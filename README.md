# MergePay on NEAR

Pay contract developers per merged pull request, with no invoices. A company puts USDC into a pool
for one repository. When a pull request is merged, GitHub signs a statement saying so, a NEAR smart
contract checks GitHub's signature, and the contract pays the developer in USDC.

Built for NEAR HACKATHON (Nov 1–14, 2026), track 08 Real-World Money.

## For the bookkeeper

### Where the money goes

1. **Funded.** The company sends USDC to the contract and names the repository, the maximum for a
   single payment (the cap) and an expiry date. This is a pool. The contract holds the money; no
   person or server does.
2. **Awarded.** A pull request is merged with a pay label (for example `pay:small`). GitHub signs a
   statement naming the pull request, the developer and the amount. The contract checks the
   signature and sets that amount aside for the developer. One pull request can be awarded once.
3. **Paid.** If the developer has told the contract which NEAR account is theirs, the USDC goes there
   in the same few seconds. If not, the award waits until they do.
4. **Refunded.** After the expiry date each funder can take back their share of whatever was not
   awarded. An award whose developer never claims an account for 180 days goes back to the pool.

### Statuses

| Status | Meaning |
| --- | --- |
| Funded | USDC is in the pool and not yet awarded |
| Pending | An award is verified but not yet paid: the developer has no linked account yet, or the transfer is in flight |
| Paid | USDC reached the developer's NEAR account and the contract confirmed it |
| Refunded | USDC went back to a funder, or an unclaimed award went back to the pool |

### What you are trusting

- **GitHub's signing keys.** The contract only accepts statements signed by keys registered in it.
  A new key waits 48 hours before it works, and funders may withdraw during that wait.
- **The pool's pinned workflow file**, which sets the rate for each label, and **whoever can merge**
  to the repository. The on-chain cap limits the damage of a wrong rate.
- **Not** the website and **not** whoever submits the transaction. They cannot change who is paid or
  how much, because both are inside GitHub's signed statement.

Until the contract has had an independent review, fund pools with small amounts only.

## Status of this build

| Piece | State |
| --- | --- |
| Contract: pools, awards, on-chain RS256 check, account links, payouts, refunds, key time-lock | Written, 21 unit tests pass |
| Award and link workflows (`workflows/`) | Written, not yet run on GitHub |
| Testnet deploy and gas measurement of the RSA check | Not done |
| CSV export and statement page | Not built |
| Gasless delegate actions (NEP-366) for fund, refund, withdraw | Not built. Awards and links need no user signature: the workflow submits them with a key that can only call this contract |
| 1Click funding and cross-chain withdrawal | Not built |

## For developers

```bash
cargo test
```

```bash
cargo build --target wasm32-unknown-unknown --release
```

Contract methods:

| Method | Who calls it | What it does |
| --- | --- | --- |
| `new(owner, usdc, keys)` | deployer | `keys` are `[kid, n]` pairs copied from GitHub's JWKS (`https://token.actions.githubusercontent.com/.well-known/jwks`) |
| `ft_transfer_call` on USDC with `msg` | funder | `msg` is pool terms `{"repo_id":123,"workflow":"org/repo/.github/workflows/award.yml@refs/heads/main","cap":"50000000","expiry":1800000000}` to create a pool, or a pool id to add to one |
| `award(jwt)` | anyone | audience `<contract>\|award\|<pool>\|<pr>\|<github user id>\|<micro-USDC>` |
| `link(jwt)` | anyone | audience `<contract>\|link\|<near account>`; token must come from a repo the user owns |
| `pay(pool_id, pr)` | anyone | retries a pending payout to the linked account |
| `refund(pool_id)` | funder | after expiry, or while a key change is pending |
| `expire_award(pool_id, pr)` | anyone | after 180 days with no linked account |
| `propose_key(kid, n)`, `revoke_key(kid)` | owner | 48 hour time-lock on new keys; revoke is immediate |

The contract account must hold a little NEAR: it pays the USDC storage registration (0.00125 NEAR)
for a developer who has never held USDC.

Signature check: RSASSA-PKCS1-v1_5 with SHA-256 per RFC 8017, in `src/rsa.rs`. The modular
exponentiation comes from `num-bigint`; the hash is NEAR's `sha256` host function.

## Credits and reuse

The idea comes from the earlier MergePay project on Arc (Solidity), by the same author
(TODO: link to that repository). That project is a design reference only. No Solidity, library or workflow file was
copied; everything here was written from GitHub's OIDC documentation, RFC 8017 and NEAR's
documentation during the hackathon window.

Dependencies: `near-sdk`, `num-bigint`. Tests only: `rsa`, `rand`.
