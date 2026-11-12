// CSV and statement cases from the PRD (TC-43 to TC-47). Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, buildRows, eventsFromOutcomes, formatAmount, statement, toCsv } from '../docs/ledger.mjs';

const EXPLORER = 'https://testnet.nearblocks.io/txns/';
const NS = (iso) => String(BigInt(Date.parse(iso)) * 1_000_000n);
const ev = (event, data, iso, tx) => ({ event, data, ts: NS(iso), tx });
const names = { repos: { 42: 'acme/app' }, users: { 7: 'dev' }, labels: { '0:1': 'pay:small' } };

const EVENTS = [
  ev('funded', { pool_id: 0, funder: 'acme.near', amount: '100000000', terms: { repo_id: 42 } }, '2026-11-02T10:00:00Z', 'F1'),
  ev('award', { pool_id: 0, pr: 1, github_id: 7, amount: '5000000' }, '2026-11-03T10:00:00Z', 'A1'),
  ev('paid', { pool_id: 0, pr: 1, account: 'dev.near', amount: '5000000' }, '2026-11-03T10:00:05Z', 'P1'),
  ev('award', { pool_id: 0, pr: 2, github_id: 8, amount: '20000000' }, '2026-11-04T10:00:00Z', 'A2'),
  ev('pay_failed', { pool_id: 0, pr: 2, account: 'x.near' }, '2026-11-04T10:00:05Z', 'X2'),
  ev('award', { pool_id: 0, pr: 3, github_id: 7, amount: '1500001' }, '2026-11-05T10:00:00Z', 'A3'),
  ev('paid', { pool_id: 0, pr: 3, account: 'dev.near', amount: '1500001' }, '2026-11-05T10:00:05Z', 'P3'),
  ev('refunded', { pool_id: 0, funder: 'acme.near', amount: '73499999' }, '2026-12-01T00:00:00Z', 'R1'),
];

test('TC-43 header row exactly as specified, one row per payment', () => {
  const rows = buildRows(EVENTS, { explorer: EXPLORER, names });
  const lines = toCsv(rows).split('\r\n');
  assert.equal(lines[0], COLUMNS.join(','));
  assert.equal(lines[0], 'date_utc,repo,pr_number,pr_url,contributor_github,contributor_near_account,label,rate_usd,amount_usdc,status,award_tx,payout_tx,refund_tx,explorer_url,withdrawal_chain,withdrawal_status');
  assert.equal(rows.length, 5); // funding, 3 awards, refund
  assert.deepEqual(rows.map((r) => r.status), ['Funded', 'Paid', 'Pending', 'Paid', 'Refunded']);
  const pr1 = rows[1];
  assert.equal(pr1.pr_url, 'https://github.com/acme/app/pull/1');
  assert.equal(pr1.contributor_github, 'dev');
  assert.equal(pr1.contributor_near_account, 'dev.near');
  assert.equal(pr1.label, 'pay:small');
  assert.equal(pr1.rate_usd, '5');
  assert.equal(pr1.award_tx, 'A1');
  assert.equal(pr1.payout_tx, 'P1');
  assert.equal(pr1.explorer_url, `${EXPLORER}P1`); // most recent transaction
  assert.equal(rows[2].contributor_github, '8'); // unknown login falls back to the numeric id
});

test('TC-44 text starting with = + - @ cannot run as a formula', () => {
  const rows = buildRows([ev('award', { pool_id: 0, pr: 9, github_id: 7, amount: '1' }, '2026-11-03T00:00:00Z', 'A9')], {
    explorer: EXPLORER, names: { ...names, users: { 7: '=HYPERLINK("http://x")' }, labels: { '0:9': '+cmd' } },
  });
  rows[0].contributor_near_account = '@SUM(1)';
  rows[0].repo = '-2+3';
  const line = toCsv(rows).split('\r\n')[1];
  assert.match(line, /"'=HYPERLINK\(""http:\/\/x""\)"/);
  assert.match(line, /,'\+cmd,/);
  assert.match(line, /,'@SUM\(1\),/);
  assert.match(line, /,'-2\+3,/);
});

test('TC-45 commas, quotes and line breaks are quoted and survive a round trip', () => {
  const tricky = 'a, "b"\nc';
  const rows = buildRows(EVENTS.slice(0, 2), { explorer: EXPLORER, names: { ...names, labels: { '0:1': tricky } } });
  const csv = toCsv(rows);
  assert.match(csv, /"a, ""b""\nc"/);
  assert.deepEqual(parseCsv(csv)[2][COLUMNS.indexOf('label')], tricky);
});

test('TC-46 amounts to 6 decimals, ISO UTC dates, total equals the sum of Paid rows', () => {
  const rows = buildRows(EVENTS, { explorer: EXPLORER, names });
  assert.equal(formatAmount('5000000'), '5.000000');
  assert.equal(formatAmount('1'), '0.000001');
  assert.equal(formatAmount('0'), '0.000000');
  assert.equal(formatAmount('123456789012345678901234'), '123456789012345678.901234');
  for (const r of rows) {
    assert.match(r.amount_usdc, /^\d+\.\d{6}$/);
    assert.match(r.date_utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }
  const nov = statement(rows, '2026-11');
  assert.equal(nov.lines.length, 4);
  assert.equal(nov.totalPaid, '6.500001'); // 5.000000 + 1.500001; Pending and Funded are not paid
});

test('TC-47 a period with no payments gives the header row only', () => {
  const rows = buildRows(EVENTS, { explorer: EXPLORER, names });
  const { lines, totalPaid } = statement(rows, '2027-01');
  assert.equal(toCsv(lines), `${COLUMNS.join(',')}\r\n`);
  assert.equal(totalPaid, '0.000000');
});

test('unclaimed award returned to the pool shows Refunded with its refund transaction', () => {
  const rows = buildRows([
    ...EVENTS.slice(0, 1),
    ev('award', { pool_id: 0, pr: 4, github_id: 9, amount: '1000000' }, '2026-11-03T00:00:00Z', 'A4'),
    ev('award_expired', { pool_id: 0, pr: 4, amount: '1000000' }, '2027-05-03T00:00:00Z', 'E4'),
  ], { explorer: EXPLORER, names });
  assert.equal(rows[1].status, 'Refunded');
  assert.equal(rows[1].refund_tx, 'E4');
});

test('only successful mergepay events from our contract are read from a transaction', () => {
  const log = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: 'mergepay', version: '1.0.0', event, data: [data] })}`;
  const outcomes = [
    { id: 'r1', outcome: { executor_id: 'usdc.near', status: { SuccessReceiptId: 'r2' }, logs: ['Transfer 5 from a to b'] } },
    { id: 'r2', outcome: { executor_id: 'pay.near', status: { SuccessValue: '' }, logs: [log('funded', { pool_id: 0 }), 'EVENT_JSON:{bad', 'EVENT_JSON:{"standard":"nep141","data":[{}]}'] } },
    { id: 'r3', outcome: { executor_id: 'pay.near', status: { Failure: {} }, logs: [log('award', { pool_id: 0 })] } },
    { id: 'r4', outcome: { executor_id: 'evil.near', status: { SuccessValue: '' }, logs: [log('paid', { pool_id: 0 })] } },
    { id: 'r5', outcome: { executor_id: 'pay.near', status: { SuccessValue: '' }, logs: [log('paid', { pool_id: 1 })] } },
  ];
  assert.deepEqual(eventsFromOutcomes(outcomes, 'pay.near', 'T', { r2: '2' }, '9'), [
    { tx: 'T', ts: '2', event: 'funded', data: { pool_id: 0 } },
    { tx: 'T', ts: '9', event: 'paid', data: { pool_id: 1 } }, // no timestamp for r5, so the fallback
  ]);
});

// Minimal RFC 4180 reader, enough to check the round trip.
function parseCsv(text) {
  const rows = [[]];
  let field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { rows.at(-1).push(field); field = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { rows.at(-1).push(field); field = ''; rows.push([]); i++; }
    else field += ch;
  }
  return rows;
}
