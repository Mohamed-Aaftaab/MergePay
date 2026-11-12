//! Unit cases from the PRD (TC numbers in test names/comments). Tokens are GitHub-shaped and
//! signed with a locally generated RSA-2048 key.
use super::*;
use ::rsa::pkcs1v15::SigningKey;
use ::rsa::sha2::Sha256;
use ::rsa::signature::{SignatureEncoding, Signer};
use ::rsa::traits::PublicKeyParts;
use ::rsa::RsaPrivateKey;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::OnceLock;

const T0: u64 = 1_800_000_000;
const EXPIRY: u64 = T0 + 30 * 24 * 3600;
const WF: &str = "tenori/pilot/.github/workflows/award.yml@refs/heads/main";
const CONTRACT: &str = "mergepay.near";
const DAY: u64 = 24 * 3600;

fn keypair(slot: &'static OnceLock<RsaPrivateKey>) -> &'static RsaPrivateKey {
    slot.get_or_init(|| RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap())
}
fn key() -> &'static RsaPrivateKey {
    static K: OnceLock<RsaPrivateKey> = OnceLock::new();
    keypair(&K)
}
fn other_key() -> &'static RsaPrivateKey {
    static K: OnceLock<RsaPrivateKey> = OnceLock::new();
    keypair(&K)
}
fn modulus(k: &RsaPrivateKey) -> String {
    enc(&k.n().to_bytes_be())
}
fn enc(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn sign(k: &RsaPrivateKey, header: Value, claims: &Value) -> String {
    let msg = format!(
        "{}.{}",
        enc(header.to_string().as_bytes()),
        enc(claims.to_string().as_bytes())
    );
    let sig = SigningKey::<Sha256>::new(k.clone())
        .sign(msg.as_bytes())
        .to_vec();
    format!("{msg}.{}", enc(&sig))
}
fn jwt(claims: &Value) -> String {
    sign(key(), json!({"alg": "RS256", "kid": "k1"}), claims)
}

fn at(caller: &str, time: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(caller.parse().unwrap())
        .block_timestamp(time * 1_000_000_000)
        .build());
}

fn setup() -> MergePay {
    at("owner.near", T0);
    MergePay::new(
        acct("owner.near"),
        acct("usdc.near"),
        vec![("k1".into(), modulus(key()))],
    )
}
fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn terms() -> String {
    json!({"repo_id": 42, "workflow": WF, "cap": "5000000", "expiry": EXPIRY}).to_string()
}
fn fund(c: &mut MergePay, who: &str, amount: u128, msg: &str) {
    at("usdc.near", T0);
    c.ft_on_transfer(acct(who), U128(amount), msg.to_string());
}
/// A contract with pool 0 funded with 10 USDC by alice.
fn funded() -> MergePay {
    let mut c = setup();
    fund(&mut c, "alice.near", 10_000_000, &terms());
    c
}
fn award_claims(pr: u64, amount: u128) -> Value {
    json!({
        "iss": ISSUER, "iat": T0, "exp": T0 + 300, "repository_id": "42",
        "event_name": "pull_request_target", "job_workflow_ref": WF,
        "aud": format!("{CONTRACT}|award|0|{pr}|7|{amount}"),
    })
}
fn link_claims(account: &str, iat: u64) -> Value {
    json!({
        "iss": ISSUER, "iat": iat, "exp": iat + 300, "actor_id": "7", "repository_owner_id": "7",
        "aud": format!("{CONTRACT}|link|{account}"),
    })
}
fn with(mut claims: Value, field: &str, value: Value) -> Value {
    claims[field] = value;
    claims
}
fn balance(c: &MergePay) -> u128 {
    c.get_pool(0).unwrap().balance.0
}
fn status(c: &MergePay, pr: u64) -> Status {
    c.get_award(0, pr).unwrap().status
}

fn rejected(c: &mut MergePay, why: &str, f: impl FnOnce(&mut MergePay)) {
    let err = catch_unwind(AssertUnwindSafe(|| f(c))).expect_err("call should have been rejected");
    let msg = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(msg.contains(why), "expected rejection '{why}', got '{msg}'");
}
fn award_rejected(c: &mut MergePay, why: &str, token: String) {
    at("relayer.near", T0);
    rejected(c, why, |c| c.award(token));
    assert_eq!(
        balance(c),
        10_000_000,
        "a rejected award must not move money"
    );
}

// ---- Funding ----

#[test]
fn tc01_funding_creates_pool() {
    let c = funded();
    assert_eq!(
        c.get_config(),
        json!({"owner": "owner.near", "usdc": "usdc.near", "next_pool": 1})
    );
    let pool = c.get_pool(0).unwrap();
    assert_eq!(
        (pool.balance.0, pool.terms.repo_id, pool.terms.cap.0),
        (10_000_000, 42, 5_000_000)
    );
    assert_eq!(c.get_share(0, acct("alice.near")).0, 10_000_000);
}

#[test]
fn tc02_tc04_bad_funding_is_rejected() {
    let mut c = setup();
    at("fake-usdc.near", T0);
    rejected(&mut c, "only the configured USDC", |c| {
        c.ft_on_transfer(acct("alice.near"), U128(1), terms());
    });
    at("usdc.near", T0);
    rejected(&mut c, "malformed funding message", |c| {
        c.ft_on_transfer(acct("alice.near"), U128(1), "{\"repo_id\":".into());
    });
    rejected(&mut c, "no such pool", |c| {
        c.ft_on_transfer(acct("alice.near"), U128(1), "9".into());
    });
    assert!(c.get_pool(0).is_none());
}

#[test]
fn tc03_second_funder_adds_to_pool() {
    let mut c = funded();
    fund(&mut c, "bob.near", 5_000_000, "0");
    assert_eq!(balance(&c), 15_000_000);
    assert_eq!(c.get_share(0, acct("alice.near")).0, 10_000_000);
    assert_eq!(c.get_share(0, acct("bob.near")).0, 5_000_000);
    assert_eq!(c.get_pool(0).unwrap().terms.workflow, WF);
}

// ---- Awards ----

#[test]
fn tc05_valid_award_is_recorded_once() {
    let mut c = funded();
    at("relayer.near", T0);
    c.award(jwt(&award_claims(1, 2_000_000)));
    assert_eq!(balance(&c), 8_000_000);
    let award = c.get_award(0, 1).unwrap();
    assert_eq!(
        (award.github_id, award.amount.0, award.status),
        (7, 2_000_000, Status::Pending)
    );
    // TC-15: same PR again
    rejected(&mut c, "PR already awarded", |c| {
        c.award(jwt(&award_claims(1, 2_000_000)))
    });
    assert_eq!(balance(&c), 8_000_000);
}

#[test]
fn tc06_tc18_tampered_token_or_signature() {
    let mut c = funded();
    let good = jwt(&award_claims(1, 2_000_000));
    let parts: Vec<&str> = good.split('.').collect();
    let forged_payload = enc(award_claims(1, 5_000_000).to_string().as_bytes());
    award_rejected(
        &mut c,
        "bad signature",
        format!("{}.{forged_payload}.{}", parts[0], parts[2]),
    );

    let mut sig = b64(parts[2]);
    sig[100] ^= 1;
    award_rejected(
        &mut c,
        "bad signature",
        format!("{}.{}.{}", parts[0], parts[1], enc(&sig)),
    );
    // signature value not less than the modulus
    let n = key().n().to_bytes_be();
    award_rejected(
        &mut c,
        "bad signature",
        format!("{}.{}.{}", parts[0], parts[1], enc(&n)),
    );
    award_rejected(
        &mut c,
        "bad signature",
        format!("{}.{}.{}", parts[0], parts[1], enc(&[0xff; 256])),
    );
    award_rejected(
        &mut c,
        "bad signature",
        format!("{}.{}.{}", parts[0], parts[1], enc(&sig[1..])),
    );
}

#[test]
fn tc07_unknown_or_mismatched_key() {
    let mut c = funded();
    let claims = award_claims(1, 2_000_000);
    award_rejected(
        &mut c,
        "unknown signing key",
        sign(key(), json!({"alg": "RS256", "kid": "k9"}), &claims),
    );
    award_rejected(
        &mut c,
        "bad signature",
        sign(other_key(), json!({"alg": "RS256", "kid": "k1"}), &claims),
    );
}

#[test]
fn tc08_only_rs256() {
    let mut c = funded();
    let claims = award_claims(1, 2_000_000);
    for alg in ["none", "HS256", "RS384", "PS256"] {
        award_rejected(
            &mut c,
            "algorithm must be RS256",
            sign(key(), json!({"alg": alg, "kid": "k1"}), &claims),
        );
    }
    let unsigned = format!(
        "{}.{}.",
        enc(json!({"alg": "none", "kid": "k1"}).to_string().as_bytes()),
        enc(claims.to_string().as_bytes())
    );
    award_rejected(&mut c, "algorithm must be RS256", unsigned);
}

#[test]
fn tc09_to_tc14_wrong_claims() {
    let mut c = funded();
    let good = || award_claims(1, 2_000_000);
    let cases = [
        (
            "wrong issuer",
            with(good(), "iss", json!("https://evil.example")),
        ),
        ("token expired", with(good(), "exp", json!(T0 - 1))),
        ("token expired", with(good(), "exp", json!(T0))), // the exact expiry second
        (
            "different contract",
            with(good(), "aud", json!("other.near|award|0|1|7|2000000")),
        ),
        (
            "wrong repository",
            with(good(), "repository_id", json!("43")),
        ),
        (
            "not the pinned workflow",
            with(
                good(),
                "job_workflow_ref",
                json!(WF.replace("award.yml", "x.yml")),
            ),
        ),
        (
            "wrong event",
            with(good(), "event_name", json!("pull_request")),
        ),
        (
            "wrong audience kind",
            with(
                good(),
                "aud",
                json!(format!("{CONTRACT}|link|0|1|7|2000000")),
            ),
        ),
    ];
    for (why, claims) in cases {
        award_rejected(&mut c, why, jwt(&claims));
    }
}

#[test]
fn tc16_amount_above_cap_or_balance() {
    let mut c = funded();
    award_rejected(
        &mut c,
        "above the per-award cap",
        jwt(&award_claims(1, 5_000_001)),
    );
    award_rejected(&mut c, "above the per-award cap", jwt(&award_claims(1, 0)));
    at("relayer.near", T0);
    c.award(jwt(&award_claims(1, 5_000_000)));
    c.award(jwt(&award_claims(2, 4_000_000)));
    rejected(&mut c, "above the pool balance", |c| {
        c.award(jwt(&award_claims(3, 2_000_000)))
    });
    assert_eq!(balance(&c), 1_000_000);
}

#[test]
fn tc17_tc19_malformed_audience() {
    let mut c = funded();
    let good = || award_claims(1, 2_000_000);
    let cases = [
        (
            "malformed audience",
            json!(format!("{CONTRACT}|award|0|1|7")),
        ),
        // an injected extra field (e.g. from a branch name) changes the field count
        (
            "malformed audience",
            json!(format!("{CONTRACT}|award|0|1|7|2000000|9999999")),
        ),
        (
            "malformed number",
            json!(format!("{CONTRACT}|award|0|1|7|lots")),
        ),
        (
            "malformed number",
            json!(format!("{CONTRACT}|award|0|1|7|-5")),
        ),
        (
            "audience must be a string",
            json!([format!("{CONTRACT}|award|0|1|7|2000000")]),
        ),
    ];
    for (why, aud) in cases {
        award_rejected(&mut c, why, jwt(&with(good(), "aud", aud)));
    }
}

// ---- Linking and payout ----

#[test]
fn tc20_tc22_tc23_link_and_replace() {
    let mut c = funded();
    at("relayer.near", T0);
    c.link(jwt(&link_claims("dev.near", T0)));
    assert_eq!(c.get_link(7).unwrap().account, "dev.near");
    // TC-22: an older or equally old token cannot replace it
    rejected(&mut c, "newer link already exists", |c| {
        c.link(jwt(&link_claims("thief.near", T0)))
    });
    rejected(&mut c, "newer link already exists", |c| {
        c.link(jwt(&link_claims("thief.near", T0 - 5)))
    });
    // TC-23
    c.link(jwt(&link_claims("dev2.near", T0 + 1)));
    assert_eq!(c.get_link(7).unwrap().account, "dev2.near");
}

#[test]
fn tc21_tc24_bad_links() {
    let mut c = funded();
    at("relayer.near", T0);
    let someone_elses_repo = with(
        link_claims("dev.near", T0),
        "repository_owner_id",
        json!("8"),
    );
    rejected(&mut c, "repository you own", |c| {
        c.link(jwt(&someone_elses_repo))
    });
    rejected(&mut c, "invalid NEAR account", |c| {
        c.link(jwt(&link_claims("Not An Account!", T0)))
    });
    rejected(&mut c, "malformed audience", |c| {
        c.link(jwt(&award_claims(1, 1)))
    });
    assert!(c.get_link(7).is_none());
}

#[test]
fn tc25_to_tc28_pending_then_paid_on_linking() {
    let mut c = funded();
    at("relayer.near", T0);
    c.award(jwt(&award_claims(1, 2_000_000)));
    rejected(&mut c, "no linked account", |c| {
        c.pay(0, 1).detach();
    });
    assert_eq!(status(&c, 1), Status::Pending);

    c.link(jwt(&link_claims("dev.near", T0)));
    assert_eq!(status(&c, 1), Status::Paying);
    // TC-28: no second transfer while one is in flight
    rejected(&mut c, "award is not pending", |c| {
        c.pay(0, 1).detach();
    });

    // TC-27: the transfer failed, so the award is payable again and nothing was lost
    c.settle_payout(0, 1, acct("dev.near"), false);
    assert_eq!(status(&c, 1), Status::Pending);
    c.pay(0, 1).detach();
    c.settle_payout(0, 1, acct("dev.near"), true);
    assert_eq!(status(&c, 1), Status::Paid);
    rejected(&mut c, "award is not pending", |c| {
        c.pay(0, 1).detach();
    });

    // TC-26: with a link in place a new award starts paying at once
    c.award(jwt(&award_claims(2, 1_000_000)));
    assert_eq!(status(&c, 2), Status::Paying);
    assert_eq!(balance(&c), 7_000_000);
}

// ---- Refunds ----

#[test]
fn tc30_tc31_refund_only_after_expiry() {
    let mut c = funded();
    at("relayer.near", T0);
    c.award(jwt(&award_claims(1, 4_000_000)));
    at("alice.near", EXPIRY - 1);
    rejected(&mut c, "pool has not expired", |c| {
        c.refund(0).detach();
    });
    at("alice.near", EXPIRY);
    c.refund(0).detach();
    assert_eq!(balance(&c), 0);
    rejected(&mut c, "nothing to refund", |c| {
        c.refund(0).detach();
    });
    at("mallory.near", EXPIRY);
    rejected(&mut c, "nothing to refund", |c| {
        c.refund(0).detach();
    });
}

#[test]
fn refund_is_restored_when_the_transfer_fails() {
    let mut c = funded();
    at("alice.near", EXPIRY);
    c.refund(0).detach();
    c.undo_refund(0, acct("alice.near"), 10_000_000, 10_000_000);
    assert_eq!(balance(&c), 10_000_000);
    assert_eq!(c.get_share(0, acct("alice.near")).0, 10_000_000);
}

#[test]
fn awards_stop_at_expiry() {
    let mut c = funded();
    at("relayer.near", EXPIRY);
    let claims = with(award_claims(1, 1_000_000), "exp", json!(EXPIRY + 300));
    rejected(&mut c, "pool has expired", |c| c.award(jwt(&claims)));
}

#[test]
fn tc32_refund_early_while_key_change_pending() {
    let mut c = funded();
    at("owner.near", T0);
    c.propose_key("k2".into(), modulus(other_key()));
    at("alice.near", T0 + 10);
    c.refund(0).detach();
    assert_eq!(balance(&c), 0);
}

#[test]
fn tc33_unlinked_award_returns_after_180_days() {
    let mut c = funded();
    at("relayer.near", T0);
    c.award(jwt(&award_claims(1, 2_000_000)));
    at("anyone.near", T0 + 180 * DAY - 1);
    rejected(&mut c, "younger than 180 days", |c| c.expire_award(0, 1));
    at("anyone.near", T0 + 180 * DAY);
    c.expire_award(0, 1);
    assert_eq!(status(&c, 1), Status::Refunded);
    assert_eq!(balance(&c), 10_000_000);
    rejected(&mut c, "award is not pending", |c| c.expire_award(0, 1));
}

#[test]
fn tc34_refunds_sum_exactly_to_unspent_balance() {
    let mut c = setup();
    fund(&mut c, "a.near", 1_000_001, &terms());
    fund(&mut c, "b.near", 2_000_003, "0");
    fund(&mut c, "c.near", 3_000_007, "0");
    at("relayer.near", T0);
    c.award(jwt(&award_claims(1, 1_000_000)));
    let unspent = balance(&c);
    let mut refunded = 0;
    for funder in ["a.near", "b.near", "c.near"] {
        let before = balance(&c);
        at(funder, EXPIRY);
        c.refund(0).detach();
        refunded += before - balance(&c);
    }
    assert_eq!(refunded, unspent);
    assert_eq!(balance(&c), 0);
}

#[test]
fn late_funder_is_not_charged_for_earlier_spending() {
    let mut c = funded();
    at("relayer.near", T0);
    c.award(jwt(&award_claims(1, 5_000_000)));
    fund(&mut c, "bob.near", 5_000_000, "0");
    at("bob.near", EXPIRY);
    c.refund(0).detach();
    assert_eq!(balance(&c), 5_000_000);
}

// ---- Keys ----

#[test]
fn tc35_tc36_tc37_key_management() {
    let mut c = funded();
    at("mallory.near", T0);
    rejected(&mut c, "owner only", |c| {
        c.propose_key("k2".into(), modulus(other_key()))
    });
    rejected(&mut c, "owner only", |c| c.revoke_key("k1".into()));
    at("owner.near", T0);
    rejected(&mut c, "not an RSA-2048+ modulus", |c| {
        c.propose_key("k2".into(), enc(&[0xff; 128]))
    });
    c.propose_key("k2".into(), modulus(other_key()));

    let token = |pr, time: u64| {
        let claims = with(award_claims(pr, 1_000_000), "exp", json!(time + 300));
        sign(other_key(), json!({"alg": "RS256", "kid": "k2"}), &claims)
    };
    at("relayer.near", T0 + KEY_TIMELOCK_SECS - 1);
    rejected(&mut c, "still time-locked", |c| {
        c.award(token(1, T0 + KEY_TIMELOCK_SECS - 1))
    });
    at("relayer.near", T0 + KEY_TIMELOCK_SECS);
    c.award(token(1, T0 + KEY_TIMELOCK_SECS));
    assert_eq!(balance(&c), 9_000_000);

    at("owner.near", T0 + KEY_TIMELOCK_SECS);
    c.revoke_key("k2".into());
    at("relayer.near", T0 + KEY_TIMELOCK_SECS);
    rejected(&mut c, "unknown signing key", |c| {
        c.award(token(2, T0 + KEY_TIMELOCK_SECS))
    });
}
