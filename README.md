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
| Contract: pools, awards, on-chain RS256 check, account links, payouts, refunds, key time-lock | Deployed on testnet, 21 unit tests pass |
| Award and link workflows (`.github/workflows/`) | Running in this repository |
| Real merged PR paid on testnet, verified with GitHub's own signature | Done (see below). Not yet run on mainnet or with USDC |
| Statement page and CSV export (`docs/`) | Built, reads the testnet contract live. The Fund button shows the funding command; 1Click is not wired in |
| Gasless delegate actions (NEP-366) for fund, refund, withdraw | Not built. Awards and links need no user signature: the workflow submits them with a key that can only call this contract |
| 1Click funding and cross-chain withdrawal | Not built |

## Testnet run and gas report (Nov 12, 2026)

Contract: `pay.mergepay-482529.testnet`. Testnet has no convenient USDC, so wrapped NEAR
(`wrap.testnet`, also a NEP-141 token) stands in for it. The contract is registered with GitHub's
live signing keys plus one test key; the tokens below were GitHub-shaped and signed with the test key.

| Step | Gas used | Limit | Transaction |
| --- | --- | --- | --- |
| Fund a pool (`ft_transfer_call`) | 7.1 TGas | 300 | [Bdfof8s1…](https://testnet.nearblocks.io/txns/Bdfof8s13HGozPJLzFT86romsePwyAWA4mqgWurp1hin) |
| Award: RSA-2048 signature check and claim checks | 19.9 TGas | 300 | [Cny9Sfk…](https://testnet.nearblocks.io/txns/Cny9SfkAtckcTApahq1MKJfFopXs8ZVFAXmRkQLtqGC) |
| Link, storage registration, payout and confirmation | 26.3 TGas | 300 | [5Y7Sps1…](https://testnet.nearblocks.io/txns/5Y7Sps1TFiKGhTrHLhuATPh1cjwopAUrXCUetgRLA5EP) |
| Same award submitted again | rejected: "PR already awarded" | | [D2GjUHY…](https://testnet.nearblocks.io/txns/D2GjUHYDDZ71ULAntxR4huQ2BEUB8q3wzHHEap5vVF3d) |

The on-chain RSA check uses under 7% of the per-call gas limit, so no off-chain attester is needed.

### A real pull request, paid

After the run above, the test key was revoked
([6SRqBYR…](https://testnet.nearblocks.io/txns/6SRqBYRdzYe2CM68H9GyDnXa6HCvH1q4ES8BPcTwJ1dd)) and
the same contract paid a real merge in this repository, using only GitHub's signature:

| Step | What happened | Proof |
| --- | --- | --- |
| Pool 1 funded for this repository | 0.5 wrapped NEAR, pinned to `award.yml` on `main` | [ERE53i7…](https://testnet.nearblocks.io/txns/ERE53i77N9xxnMEUoBXT7JMfT8DqbgsdCdKgFdDhdkvT) |
| [PR #1](https://github.com/Mohamed-Aaftaab/MergePay/pull/1) merged with label `pay:small` | The workflow asked GitHub for a signed token and submitted it | [workflow run](https://github.com/Mohamed-Aaftaab/MergePay/actions/runs/43211106314) |
| Award verified on-chain | 20.0 TGas, status Pending (author had no linked account) | [8F9DjV9…](https://testnet.nearblocks.io/txns/8F9DjV9KLVKuBj7hejkyA7ZqGXwW4BEqXVzEnn19nMUA) |
| Author linked a NEAR account | GitHub-signed link token from the link workflow | [workflow run](https://github.com/Mohamed-Aaftaab/MergePay/actions/runs/43211216176) |
| Link verified, award paid | 26.9 TGas, status Paid | [fLg1irr…](https://testnet.nearblocks.io/txns/fLg1irrCa4L5zJ93bJ9DYWuoxwfjMnSVtQCdGhUNGWz) |

The rate card is written in micro-USDC, so on the 24-decimal stand-in token the amount paid is tiny
(5000000 base units). The submitting key is a function-call key that can only call `award`, `link`
and `pay` on this contract.

## Statement page and CSV

Live: **https://mohamed-aaftaab.github.io/MergePay/?period=2026-11**

`docs/index.html` is a static page. It lists the contract's activity from the NearBlocks API, reads
each transaction's events from NEAR RPC, and looks up repository and user names on GitHub. No server
and no wallet are involved.

- Pick a month to see that period's line items, the total paid and the due date (7 days after the
  period ends).
- **Download CSV** saves one row per payment: each funding, each award (Pending, then Paid or
  Refunded) and each refund. The columns are `date_utc, repo, pr_number, pr_url, contributor_github,
  contributor_near_account, label, rate_usd, amount_usdc, status, award_tx, payout_tx, refund_tx,
  explorer_url, withdrawal_chain, withdrawal_status`.
- Amounts have 6 decimals and no currency sign. Dates are ISO 8601 in UTC. Cells that start with
  `=`, `+`, `-` or `@` get a leading `'` so they cannot run as formulas. The file is UTF-8 with a BOM
  so Excel opens it without garbling.
- On funding and refund rows, `contributor_near_account` holds the funder's account and `label` says
  `funding` or `refund`.
- `?contract=<account>` points the page at another deployment and `?pools=1,2` limits it to some
  pools. The demo contract defaults to pool 1: pool 0 was a smoke test whose made-up GitHub ids belong
  to unrelated people.

To run it locally, serve the folder (ES modules do not load from `file://`):

```bash
python -m http.server 8765 --directory docs
```

## For developers

```bash
cargo test
```

```bash
node --test test/ledger.test.mjs
```

```bash
cargo near build non-reproducible-wasm --no-abi
```

`--no-abi` is only needed on Windows, where ABI generation does not link.

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
(link to that repository to be added). That project is a design reference only. No Solidity, library or workflow file was
copied; everything here was written from GitHub's OIDC documentation, RFC 8017 and NEAR's
documentation during the hackathon window.

Dependencies: `near-sdk`, `num-bigint`. Tests only: `rsa`, `rand`.
