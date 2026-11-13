// Turns MergePay contract events into what the console shows: awards, pools, contributors and totals.
// Amounts stay as base-unit strings; pages format them with the token's decimals.

const byTime = (a, b) => (BigInt(a.ts) < BigInt(b.ts) ? -1 : BigInt(a.ts) > BigInt(b.ts) ? 1 : 0);
const add = (a, b) => (BigInt(a) + BigInt(b)).toString();

export function buildModel(events) {
  const awards = new Map();
  const links = new Map();
  const pools = new Map();
  for (const e of [...events].sort(byTime)) {
    const d = e.data;
    const key = `${d.pool_id}:${d.pr}`;
    if (e.event === 'funded') {
      const pool = pools.get(d.pool_id) ?? { id: d.pool_id, terms: null, funded: '0', refunded: '0', funders: {}, fundTxs: [] };
      if (d.terms) pool.terms = d.terms;
      pool.funded = add(pool.funded, d.amount);
      pool.funders[d.funder] = add(pool.funders[d.funder] ?? '0', d.amount);
      pool.fundTxs.push({ tx: e.tx, ts: e.ts, funder: d.funder, amount: d.amount });
      pools.set(d.pool_id, pool);
    } else if (e.event === 'refunded') {
      const pool = pools.get(d.pool_id);
      if (pool) pool.refunded = add(pool.refunded, d.amount);
    } else if (e.event === 'award') {
      awards.set(key, { key, pool: d.pool_id, pr: d.pr, githubId: d.github_id, amount: d.amount, status: 'Pending',
        awardTx: e.tx, awardTs: e.ts, payoutTx: null, payoutTs: null, account: null, refundTx: null, failedAttempts: 0 });
    } else if (e.event === 'paid' && awards.has(key)) {
      Object.assign(awards.get(key), { status: 'Paid', payoutTx: e.tx, payoutTs: e.ts, account: d.account });
    } else if (e.event === 'pay_failed' && awards.has(key)) {
      awards.get(key).failedAttempts += 1;
    } else if (e.event === 'award_expired' && awards.has(key)) {
      Object.assign(awards.get(key), { status: 'Refunded', refundTx: e.tx });
    } else if (e.event === 'linked') {
      links.set(d.github_id, { githubId: d.github_id, account: d.account, tx: e.tx, ts: e.ts });
    }
  }

  const list = [...awards.values()];
  const contributors = new Map();
  for (const a of list) {
    const c = contributors.get(a.githubId) ?? { githubId: a.githubId, paid: '0', pending: '0', prs: 0, lastTs: '0', link: null };
    c.prs += 1;
    if (a.status === 'Paid') c.paid = add(c.paid, a.amount);
    if (a.status === 'Pending') c.pending = add(c.pending, a.amount);
    if (BigInt(a.awardTs) > BigInt(c.lastTs)) c.lastTs = a.awardTs;
    contributors.set(a.githubId, c);
  }
  // Links are not tied to a pool, so only people with awards in the pools shown are listed.
  for (const l of links.values()) {
    if (contributors.has(l.githubId)) contributors.get(l.githubId).link = l;
  }
  for (const pool of pools.values()) {
    const mine = list.filter((a) => a.pool === pool.id && a.status !== 'Refunded');
    pool.awarded = mine.reduce((s, a) => add(s, a.amount), '0');
    pool.awards = mine.length;
  }

  const sum = (status) => list.filter((a) => a.status === status).reduce((s, a) => add(s, a.amount), '0');
  return {
    awards: list.sort((a, b) => byTime({ ts: b.awardTs }, { ts: a.awardTs })),
    pools: [...pools.values()].sort((a, b) => a.id - b.id),
    contributors: [...contributors.values()].sort((a, b) => (BigInt(b.paid) > BigInt(a.paid) ? 1 : -1)),
    totals: { paid: sum('Paid'), pending: sum('Pending'), paidCount: list.filter((a) => a.status === 'Paid').length,
      awards: list.length, contributors: contributors.size,
      funded: [...pools.values()].reduce((s, p) => add(s, p.funded), '0') },
  };
}

/** Human time like "3 min ago" from a nanosecond timestamp string. */
export function ago(ns, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Number(BigInt(ns) / 1_000_000n)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
