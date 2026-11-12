// Turns MergePay contract events into ledger rows and a CSV a spreadsheet opens cleanly. No network here.

export const COLUMNS = [
  'date_utc', 'repo', 'pr_number', 'pr_url', 'contributor_github', 'contributor_near_account',
  'label', 'rate_usd', 'amount_usdc', 'status', 'award_tx', 'payout_tx', 'refund_tx',
  'explorer_url', 'withdrawal_chain', 'withdrawal_status',
];

const USDC_DECIMALS = 6;

/** Base units (string) to a plain decimal with the token's places, e.g. "5000000" -> "5.000000" for USDC. */
export function formatAmount(base, decimals = USDC_DECIMALS) {
  const s = BigInt(base).toString().padStart(decimals + 1, '0');
  return decimals === 0 ? s : `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

/** Same value without trailing zeros, for the rate column: "5000000" -> "5". */
export function formatRate(base, decimals = USDC_DECIMALS) {
  const s = formatAmount(base, decimals);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/**
 * Contract events from one transaction's `receipts_outcome` (NEAR RPC `tx`).
 * `times` maps receipt id to block timestamp (ns); `fallbackTs` covers a receipt missing from it.
 */
export function eventsFromOutcomes(receiptsOutcome, contract, tx, times, fallbackTs) {
  const out = [];
  for (const r of receiptsOutcome ?? []) {
    const o = r.outcome ?? {};
    if (o.executor_id !== contract || !o.status || 'Failure' in o.status) continue;
    for (const log of o.logs ?? []) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      let e;
      try { e = JSON.parse(log.slice('EVENT_JSON:'.length)); } catch { continue; }
      if (e.standard !== 'mergepay') continue;
      for (const data of e.data ?? []) out.push({ tx, ts: times[r.id] ?? fallbackTs, event: e.event, data });
    }
  }
  return out;
}

const isoDate = (ns) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * One row per payment: each funding, each award (its status moves Pending -> Paid or Refunded),
 * each funder refund. `names` holds GitHub lookups: { repos: {id: "org/repo"}, users: {id: login}, labels: {"pool:pr": label} }.
 */
export function buildRows(events, { explorer, names = {}, decimals = USDC_DECIMALS }) {
  const repos = names.repos ?? {}, users = names.users ?? {}, labels = names.labels ?? {};
  const sorted = [...events].sort((a, b) => (BigInt(a.ts) < BigInt(b.ts) ? -1 : BigInt(a.ts) > BigInt(b.ts) ? 1 : 0));
  const poolRepo = {};
  const awards = new Map();
  const rows = [];
  const blank = () => Object.fromEntries(COLUMNS.map((c) => [c, '']));
  const touch = (row, e) => { row.date_utc = isoDate(e.ts); row.explorer_url = `${explorer}${e.tx}`; };
  const amount = (v) => formatAmount(v, decimals);

  for (const e of sorted) {
    const d = e.data;
    if (e.event === 'funded') {
      if (d.terms) poolRepo[d.pool_id] = String(d.terms.repo_id);
      const row = { ...blank(), repo: repos[poolRepo[d.pool_id]] ?? '', contributor_near_account: d.funder,
        label: 'funding', amount_usdc: amount(d.amount), status: 'Funded' };
      touch(row, e);
      rows.push(row);
    } else if (e.event === 'refunded') {
      const row = { ...blank(), repo: repos[poolRepo[d.pool_id]] ?? '', contributor_near_account: d.funder,
        label: 'refund', amount_usdc: amount(d.amount), status: 'Refunded', refund_tx: e.tx };
      touch(row, e);
      rows.push(row);
    } else if (e.event === 'award') {
      const repo = repos[poolRepo[d.pool_id]] ?? '';
      const row = { ...blank(), repo, pr_number: String(d.pr), pr_url: repo ? `https://github.com/${repo}/pull/${d.pr}` : '',
        contributor_github: users[d.github_id] ?? String(d.github_id), label: labels[`${d.pool_id}:${d.pr}`] ?? '',
        rate_usd: formatRate(d.amount, decimals), amount_usdc: amount(d.amount), status: 'Pending', award_tx: e.tx };
      touch(row, e);
      awards.set(`${d.pool_id}:${d.pr}`, row);
      rows.push(row);
    } else if (e.event === 'paid' || e.event === 'award_expired') {
      const row = awards.get(`${d.pool_id}:${d.pr}`);
      if (!row) continue; // award happened before the scanned window
      if (e.event === 'paid') Object.assign(row, { status: 'Paid', payout_tx: e.tx, contributor_near_account: d.account });
      else Object.assign(row, { status: 'Refunded', refund_tx: e.tx });
      touch(row, e);
    }
    // pay_failed leaves the award Pending; key and link events are not payments
  }
  return rows;
}

/** Rows whose date falls in `period` ("YYYY-MM"), plus the total actually paid out. */
export function statement(rows, period, decimals = USDC_DECIMALS) {
  const lines = rows.filter((r) => r.date_utc.startsWith(period));
  return { lines, totalPaid: sumAmounts(lines.filter((r) => r.status === 'Paid'), decimals) };
}

/** Exact total of the rows' amounts (they all carry the same number of places). */
export function sumAmounts(rows, decimals = USDC_DECIMALS) {
  return formatAmount(rows.reduce((sum, r) => sum + BigInt(r.amount_usdc.replace('.', '')), 0n), decimals);
}

function cell(value) {
  let s = String(value ?? '');
  // A leading = + - @ (or tab / CR) makes spreadsheets run the cell as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with CRLF line ends. The caller adds a UTF-8 BOM when saving for Excel. */
export function toCsv(rows) {
  return [COLUMNS, ...rows.map((r) => COLUMNS.map((c) => r[c]))].map((line) => line.map(cell).join(',')).join('\r\n') + '\r\n';
}
