//! MergePay on NEAR: USDC escrow that pays a contributor when GitHub signs proof of a merged PR.
use near_sdk::base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};

mod rsa;
#[cfg(test)]
mod tests;

const ISSUER: &str = "https://token.actions.githubusercontent.com";
const MERGE_EVENT: &str = "pull_request_target";
const KEY_TIMELOCK_SECS: u64 = 2 * 24 * 3600;
const UNLINKED_AWARD_SECS: u64 = 180 * 24 * 3600;
// NEP-145 registration cost on NEP-141 tokens; refunded to us if the account is already registered
const STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
// shortcut: link pays only this many waiting awards (gas), anyone can call `pay` for the rest
const MAX_PAY_ON_LINK: usize = 3;

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub struct Terms {
    pub repo_id: u64,
    /// Must equal the token's `job_workflow_ref`, e.g. `org/repo/.github/workflows/award.yml@refs/heads/main`
    pub workflow: String,
    pub cap: U128,
    /// Unix seconds
    pub expiry: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Pool {
    pub terms: Terms,
    pub balance: U128,
    pub shares: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Status {
    Pending,
    Paying,
    Paid,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Award {
    pub github_id: u64,
    pub amount: U128,
    pub status: Status,
    pub created: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct KeyView {
    pub n: String,
    pub active_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Link {
    pub account: AccountId,
    pub iat: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MergePay {
    owner: AccountId,
    usdc: AccountId,
    /// GitHub key id -> (modulus, unix second it becomes active)
    keys: LookupMap<String, (Vec<u8>, u64)>,
    key_change_until: u64,
    pools: LookupMap<u64, Pool>,
    next_pool: u64,
    shares: LookupMap<(u64, AccountId), u128>,
    /// (pool id, PR number) -> award
    awards: LookupMap<(u64, u64), Award>,
    /// GitHub user id -> payout account
    links: LookupMap<u64, Link>,
    /// GitHub user id -> awards not yet paid
    unpaid: LookupMap<u64, Vec<(u64, u64)>>,
}

fn now() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn fail(msg: &str) -> ! {
    env::panic_str(msg)
}

fn event(name: &str, data: Value) {
    let e = json!({"standard": "mergepay", "version": "1.0.0", "event": name, "data": [data]});
    env::log_str(&format!("EVENT_JSON:{e}"));
}

fn b64(s: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD
        .decode(s)
        .unwrap_or_else(|_| fail("bad base64url"))
}

/// The audience is `<this contract>|<kind>|<fields...>`; returns the fields.
fn audience<'a>(claims: &'a Value, kind: &str, fields: usize) -> Vec<&'a str> {
    let aud = claims["aud"]
        .as_str()
        .unwrap_or_else(|| fail("audience must be a string"));
    let parts: Vec<&str> = aud.split('|').collect();
    require!(parts.len() == fields + 2, "malformed audience");
    require!(
        parts[0] == env::current_account_id().as_str(),
        "audience names a different contract"
    );
    require!(parts[1] == kind, "wrong audience kind");
    parts[2..].to_vec()
}

fn number<T: std::str::FromStr>(s: &str) -> T {
    s.parse().unwrap_or_else(|_| fail("malformed number"))
}

#[near]
impl MergePay {
    /// `keys` are (kid, base64url modulus) pairs from GitHub's JWKS; they are active at once.
    #[init]
    pub fn new(owner: AccountId, usdc: AccountId, keys: Vec<(String, String)>) -> Self {
        let mut this = Self {
            owner,
            usdc,
            keys: LookupMap::new(b"k".to_vec()),
            key_change_until: 0,
            pools: LookupMap::new(b"p".to_vec()),
            next_pool: 0,
            shares: LookupMap::new(b"s".to_vec()),
            awards: LookupMap::new(b"a".to_vec()),
            links: LookupMap::new(b"l".to_vec()),
            unpaid: LookupMap::new(b"u".to_vec()),
        };
        for (kid, n) in keys {
            this.set_key(kid, &n, now());
        }
        this
    }

    // ---- GitHub signing keys ----

    pub fn propose_key(&mut self, kid: String, n: String) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        let active_at = now() + KEY_TIMELOCK_SECS;
        self.set_key(kid.clone(), &n, active_at);
        self.key_change_until = active_at;
        event("key_proposed", json!({"kid": kid, "active_at": active_at}));
    }

    pub fn revoke_key(&mut self, kid: String) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.keys.remove(&kid);
        event("key_revoked", json!({"kid": kid}));
    }

    fn set_key(&mut self, kid: String, n: &str, active_at: u64) {
        let n = b64(n);
        require!(
            n.len() >= 256 && n[0] != 0 && n[n.len() - 1] & 1 == 1,
            "not an RSA-2048+ modulus"
        );
        self.keys.insert(kid, (n, active_at));
    }

    /// Checks GitHub's signature, issuer and expiry; returns the claims.
    fn verified_claims(&self, jwt: &str) -> Value {
        let parts: Vec<&str> = jwt.split('.').collect();
        require!(parts.len() == 3, "malformed token");
        let header: Value = serde_json::from_slice(&b64(parts[0]))
            .unwrap_or_else(|_| fail("malformed token header"));
        require!(header["alg"] == "RS256", "algorithm must be RS256");
        let kid = header["kid"]
            .as_str()
            .unwrap_or_else(|| fail("token has no key id"));
        let (n, active_at) = self
            .keys
            .get(kid)
            .unwrap_or_else(|| fail("unknown signing key"));
        require!(now() >= *active_at, "signing key is still time-locked");
        let signed = &jwt[..parts[0].len() + 1 + parts[1].len()];
        require!(
            rsa::verify_rs256(n, signed.as_bytes(), &b64(parts[2])),
            "bad signature"
        );
        let claims: Value = serde_json::from_slice(&b64(parts[1]))
            .unwrap_or_else(|_| fail("malformed token claims"));
        require!(claims["iss"] == ISSUER, "wrong issuer");
        require!(
            claims["exp"].as_u64().is_some_and(|exp| now() < exp),
            "token expired"
        );
        claims
    }

    // ---- Funding ----

    /// NEP-141 hook. `msg` is either the Terms JSON (creates a pool) or an existing pool id.
    /// Any rejection panics, which makes the token contract return the full amount.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        require!(
            env::predecessor_account_id() == self.usdc,
            "only the configured USDC is accepted"
        );
        let (pool_id, mut pool) = match msg.parse::<u64>() {
            Ok(id) => (id, self.pool(id)),
            Err(_) => {
                let terms: Terms = serde_json::from_str(&msg)
                    .unwrap_or_else(|_| fail("malformed funding message"));
                require!(
                    terms.cap.0 > 0 && !terms.workflow.is_empty(),
                    "malformed pool terms"
                );
                self.next_pool += 1;
                (
                    self.next_pool - 1,
                    Pool {
                        terms,
                        balance: U128(0),
                        shares: U128(0),
                    },
                )
            }
        };
        require!(now() < pool.terms.expiry, "pool has expired");
        // Shares are minted at the current balance-per-share so earlier spending is not charged to a new funder.
        let minted = if pool.shares.0 == 0 {
            amount.0
        } else {
            require!(pool.balance.0 > 0, "pool is fully spent, create a new one");
            amount.0 * pool.shares.0 / pool.balance.0
        };
        require!(minted > 0, "amount too small");
        pool.balance.0 += amount.0;
        pool.shares.0 += minted;
        let key = (pool_id, sender_id.clone());
        let held = self.shares.get(&key).copied().unwrap_or(0);
        self.shares.insert(key, held + minted);
        event(
            "funded",
            json!({"pool_id": pool_id, "funder": sender_id, "amount": amount, "terms": pool.terms}),
        );
        self.pools.insert(pool_id, pool);
        U128(0)
    }

    // ---- Awards ----

    /// Anyone may submit a GitHub token; everything that decides the payout is inside GitHub's signature.
    /// Audience: `<contract>|award|<pool id>|<PR number>|<GitHub user id>|<amount>`
    pub fn award(&mut self, jwt: String) {
        let claims = self.verified_claims(&jwt);
        let aud = audience(&claims, "award", 4);
        let (pool_id, pr, github_id, amount): (u64, u64, u64, u128) = (
            number(aud[0]),
            number(aud[1]),
            number(aud[2]),
            number(aud[3]),
        );
        let mut pool = self.pool(pool_id);
        let repo_id = pool.terms.repo_id.to_string();
        require!(
            claims["repository_id"].as_str() == Some(&repo_id),
            "wrong repository"
        );
        require!(claims["event_name"] == MERGE_EVENT, "wrong event");
        require!(
            claims["job_workflow_ref"].as_str() == Some(&pool.terms.workflow),
            "not the pinned workflow"
        );
        require!(now() < pool.terms.expiry, "pool has expired");
        require!(
            !self.awards.contains_key(&(pool_id, pr)),
            "PR already awarded"
        );
        require!(
            amount > 0 && amount <= pool.terms.cap.0,
            "amount above the per-award cap"
        );
        require!(amount <= pool.balance.0, "amount above the pool balance");

        pool.balance.0 -= amount;
        self.pools.insert(pool_id, pool);
        let award = Award {
            github_id,
            amount: U128(amount),
            status: Status::Pending,
            created: now(),
        };
        self.awards.insert((pool_id, pr), award);
        let mut waiting = self.unpaid.get(&github_id).cloned().unwrap_or_default();
        waiting.push((pool_id, pr));
        self.unpaid.insert(github_id, waiting);
        event(
            "award",
            json!({"pool_id": pool_id, "pr": pr, "github_id": github_id, "amount": U128(amount)}),
        );
        if self.links.contains_key(&github_id) {
            self.pay(pool_id, pr).detach();
        }
    }

    /// Sends a pending award to the contributor's linked account. Anyone may call it; it cannot change who is paid.
    pub fn pay(&mut self, pool_id: u64, pr: u64) -> Promise {
        let mut award = self.award_of(pool_id, pr);
        require!(award.status == Status::Pending, "award is not pending");
        let link = self
            .links
            .get(&award.github_id)
            .unwrap_or_else(|| fail("contributor has no linked account"));
        let account = link.account.clone();
        award.status = Status::Paying;
        let amount = award.amount;
        self.awards.insert((pool_id, pr), award);
        let register = json!({"account_id": account, "registration_only": true}).to_string();
        Promise::new(self.usdc.clone())
            .function_call(
                "storage_deposit",
                register.into_bytes(),
                STORAGE_DEPOSIT,
                GAS_STORAGE_DEPOSIT,
            )
            .function_call(
                "ft_transfer",
                transfer_args(&account, amount),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_paid(pool_id, pr, account),
            )
    }

    #[private]
    pub fn on_paid(&mut self, pool_id: u64, pr: u64, account: AccountId) {
        self.settle_payout(pool_id, pr, account, near_sdk::is_promise_success());
    }

    fn settle_payout(&mut self, pool_id: u64, pr: u64, account: AccountId, paid: bool) {
        let mut award = self.award_of(pool_id, pr);
        if paid {
            award.status = Status::Paid;
            self.forget_unpaid(award.github_id, pool_id, pr);
            event(
                "paid",
                json!({"pool_id": pool_id, "pr": pr, "account": account, "amount": award.amount}),
            );
        } else {
            award.status = Status::Pending;
            event(
                "pay_failed",
                json!({"pool_id": pool_id, "pr": pr, "account": account}),
            );
        }
        self.awards.insert((pool_id, pr), award);
    }

    // ---- Linking a payout account ----

    /// Token from a workflow the contributor runs in a repo they own.
    /// Audience: `<contract>|link|<NEAR account>`
    pub fn link(&mut self, jwt: String) {
        let claims = self.verified_claims(&jwt);
        let aud = audience(&claims, "link", 1);
        let account: AccountId = aud[0]
            .parse()
            .unwrap_or_else(|_| fail("invalid NEAR account"));
        let actor = claims["actor_id"]
            .as_str()
            .unwrap_or_else(|| fail("token has no actor"));
        // Only the owner of a personal repo can make GitHub say this about themselves.
        require!(
            claims["repository_owner_id"].as_str() == Some(actor),
            "run the link workflow in a repository you own"
        );
        let github_id: u64 = number(actor);
        let iat = claims["iat"]
            .as_u64()
            .unwrap_or_else(|| fail("token has no issue time"));
        require!(
            self.links.get(&github_id).is_none_or(|l| iat > l.iat),
            "a newer link already exists"
        );
        self.links.insert(
            github_id,
            Link {
                account: account.clone(),
                iat,
            },
        );
        event(
            "linked",
            json!({"github_id": github_id, "account": account}),
        );

        let waiting = self.unpaid.get(&github_id).cloned().unwrap_or_default();
        let pending = waiting
            .into_iter()
            .filter(|k| self.awards[k].status == Status::Pending);
        for (pool_id, pr) in pending.take(MAX_PAY_ON_LINK).collect::<Vec<_>>() {
            self.pay(pool_id, pr).detach();
        }
    }

    // ---- Refunds ----

    /// A funder takes back their share of the unspent pool, after expiry or while a signing-key change is pending.
    pub fn refund(&mut self, pool_id: u64) -> Promise {
        let funder = env::predecessor_account_id();
        let mut pool = self.pool(pool_id);
        require!(
            now() >= pool.terms.expiry || now() < self.key_change_until,
            "pool has not expired"
        );
        let share = self.shares.remove(&(pool_id, funder.clone())).unwrap_or(0);
        // shortcut: an award returned after every funder has refunded stays in the pool for good,
        // add a second refund round if a pilot ever hits it
        let amount = if share == 0 {
            0
        } else {
            pool.balance.0 * share / pool.shares.0
        };
        require!(amount > 0, "nothing to refund");
        pool.balance.0 -= amount;
        pool.shares.0 -= share;
        self.pools.insert(pool_id, pool);
        event(
            "refunded",
            json!({"pool_id": pool_id, "funder": funder, "amount": U128(amount)}),
        );
        Promise::new(self.usdc.clone())
            .function_call(
                "ft_transfer",
                transfer_args(&funder, U128(amount)),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_refunded(pool_id, funder, U128(share), U128(amount)),
            )
    }

    #[private]
    pub fn on_refunded(&mut self, pool_id: u64, funder: AccountId, share: U128, amount: U128) {
        if !near_sdk::is_promise_success() {
            self.undo_refund(pool_id, funder, share.0, amount.0);
        }
    }

    fn undo_refund(&mut self, pool_id: u64, funder: AccountId, share: u128, amount: u128) {
        let mut pool = self.pool(pool_id);
        pool.balance.0 += amount;
        pool.shares.0 += share;
        self.pools.insert(pool_id, pool);
        let key = (pool_id, funder.clone());
        let held = self.shares.get(&key).copied().unwrap_or(0);
        self.shares.insert(key, held + share);
        event(
            "refund_failed",
            json!({"pool_id": pool_id, "funder": funder, "amount": U128(amount)}),
        );
    }

    /// Returns an award to its pool when the contributor has not linked an account within 180 days.
    pub fn expire_award(&mut self, pool_id: u64, pr: u64) {
        let mut award = self.award_of(pool_id, pr);
        require!(award.status == Status::Pending, "award is not pending");
        require!(
            !self.links.contains_key(&award.github_id),
            "contributor has a linked account, call pay"
        );
        require!(
            now() >= award.created + UNLINKED_AWARD_SECS,
            "award is younger than 180 days"
        );
        award.status = Status::Refunded;
        let mut pool = self.pool(pool_id);
        pool.balance.0 += award.amount.0;
        self.pools.insert(pool_id, pool);
        self.forget_unpaid(award.github_id, pool_id, pr);
        event(
            "award_expired",
            json!({"pool_id": pool_id, "pr": pr, "amount": award.amount}),
        );
        self.awards.insert((pool_id, pr), award);
    }

    // ---- Views ----

    pub fn get_pool(&self, pool_id: u64) -> Option<Pool> {
        self.pools.get(&pool_id).cloned()
    }

    pub fn get_award(&self, pool_id: u64, pr: u64) -> Option<Award> {
        self.awards.get(&(pool_id, pr)).cloned()
    }

    pub fn get_link(&self, github_id: u64) -> Option<Link> {
        self.links.get(&github_id).cloned()
    }

    pub fn get_share(&self, pool_id: u64, funder: AccountId) -> U128 {
        U128(self.shares.get(&(pool_id, funder)).copied().unwrap_or(0))
    }

    /// The RSA modulus (base64url) the contract checks tokens with this key id against, and when it became active.
    /// Lets anyone re-verify a stored token against exactly the key the contract used.
    pub fn get_key(&self, kid: String) -> Option<KeyView> {
        self.keys.get(&kid).map(|(n, active_at)| KeyView {
            n: URL_SAFE_NO_PAD.encode(n),
            active_at: *active_at,
        })
    }

    pub fn get_key_change_until(&self) -> u64 {
        self.key_change_until
    }

    /// Lets clients find the payout token (and its decimals) instead of assuming one.
    pub fn get_config(&self) -> serde_json::Value {
        json!({ "owner": self.owner, "usdc": self.usdc, "next_pool": self.next_pool })
    }

    fn pool(&self, pool_id: u64) -> Pool {
        self.pools
            .get(&pool_id)
            .cloned()
            .unwrap_or_else(|| fail("no such pool"))
    }

    fn award_of(&self, pool_id: u64, pr: u64) -> Award {
        self.awards
            .get(&(pool_id, pr))
            .cloned()
            .unwrap_or_else(|| fail("no such award"))
    }

    fn forget_unpaid(&mut self, github_id: u64, pool_id: u64, pr: u64) {
        let mut waiting = self.unpaid.get(&github_id).cloned().unwrap_or_default();
        waiting.retain(|k| *k != (pool_id, pr));
        self.unpaid.insert(github_id, waiting);
    }
}

fn transfer_args(receiver: &AccountId, amount: U128) -> Vec<u8> {
    json!({"receiver_id": receiver, "amount": amount})
        .to_string()
        .into_bytes()
}
