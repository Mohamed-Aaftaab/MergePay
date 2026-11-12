// Reads a MergePay contract's history from public NEAR services. Shared by every page.
import { eventsFromOutcomes } from './ledger.mjs';

const FINAL_AFTER_MS = 10 * 60 * 1000; // a transaction this old is final and fully indexed, so it is safe to cache
const RETRY_MS = 12000;

const cache = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked: refetch next time */ } },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function reader(cfg, onStatus = () => {}) {
  async function getJson(url, tries = 6) {
    for (let i = 0; i < tries; i++) {
      const res = await fetch(url);
      if (res.status === 429) { onStatus(`The block explorer is rate limiting us, waiting… (${i + 1}/${tries})`); await sleep(RETRY_MS); continue; }
      if (!res.ok) throw new Error(`${url} returned ${res.status}`);
      return res.json();
    }
    throw new Error('The block explorer kept rate limiting. Try again in a minute.');
  }

  // Public RPCs rate limit, so try each in turn; a JSON-RPC error (bad request) is final and not retried.
  async function rpc(method, params) {
    let lastError;
    for (const url of cfg.rpcs) {
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        if (!res.ok) { lastError = new Error(`${url} returned ${res.status}`); continue; }
        const body = await res.json();
        if (body.error) throw Object.assign(new Error(`RPC ${method}: ${body.error.cause?.name ?? body.error.message}`), { final: true });
        return body.result;
      } catch (err) {
        if (err.final) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  async function view(account, method, args = {}) {
    const res = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: account,
      method_name: method, args_base64: btoa(JSON.stringify(args)) });
    return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
  }

  /** The payout token as the contract reports it, with its own decimals and symbol. */
  async function token() {
    const { usdc } = await view(cfg.contract, 'get_config');
    const meta = await view(usdc, 'ft_metadata');
    return { account: usdc, decimals: meta.decimals, symbol: meta.symbol };
  }

  // The indexer only lists which transactions touched the contract (one call per 100 receipts; it rate limits hard).
  // The logs come from NEAR RPC, which finds a transaction by hash alone.
  async function receiptIndex() {
    const txs = new Map(); // hash -> earliest block timestamp
    const times = {}; // receipt id -> block timestamp
    let next = '';
    do {
      onStatus('Listing contract activity…');
      const page = await getJson(`${cfg.indexer}/accounts/${cfg.contract}/receipts?limit=100${next ? `&next=${encodeURIComponent(next)}` : ''}`);
      for (const r of page.data ?? []) {
        const ts = r.block?.block_timestamp ?? r.included_in_block_timestamp;
        times[r.receipt_id] = ts;
        if (!txs.has(r.transaction_hash) || BigInt(ts) < BigInt(txs.get(r.transaction_hash))) txs.set(r.transaction_hash, ts);
      }
      next = page.meta?.next_page ?? '';
    } while (next);
    return { txs, times };
  }

  /** Every mergepay event, limited to the configured pools, plus the gas each transaction used. */
  async function events() {
    const { txs, times } = await receiptIndex();
    const out = [];
    const gas = {};
    let done = 0;
    const work = [...txs];
    const worker = async () => {
      for (let item = work.shift(); item; item = work.shift()) {
        const [hash, ts] = item;
        const key = `mergepay:${cfg.network}:tx3:${hash}`;
        let found = cache.get(key);
        if (!found) {
          const tx = await rpc('tx', { tx_hash: hash, sender_account_id: cfg.contract, wait_until: 'FINAL' });
          // whole-transaction gas, the figure explorers and the CLI report as "gas used"
          const burnt = tx.receipts_outcome.reduce((sum, r) => sum + r.outcome.gas_burnt, tx.transaction_outcome.outcome.gas_burnt);
          found = { events: eventsFromOutcomes(tx.receipts_outcome, cfg.contract, hash, times, ts), gas: burnt };
          if (Date.now() - Number(BigInt(ts) / 1_000_000n) > FINAL_AFTER_MS) cache.set(key, found);
        }
        out.push(...found.events);
        gas[hash] = found.gas;
        onStatus(`Reading transactions… ${++done} of ${txs.size}`);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]); // a few at a time keeps public RPC happy
    const inPools = (e) => cfg.pools.length === 0 || !('pool_id' in e.data) || cfg.pools.includes(e.data.pool_id);
    return { events: out.filter(inPools), gas };
  }

  async function github(path) {
    const key = `mergepay:gh:${path}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const res = await fetch(`https://api.github.com${path}`);
    if (!res.ok) return null; // unauthenticated limit is 60 an hour; names fall back to ids
    const body = await res.json();
    if (!path.includes('/runs')) cache.set(key, body); // workflow runs change; names and labels don't
    return body;
  }

  /** GitHub names for the repositories, authors and pay labels the events mention. */
  async function names(evts) {
    const out = { repos: {}, users: {}, labels: {} };
    const poolRepo = {};
    for (const e of evts) if (e.event === 'funded' && e.data.terms) poolRepo[e.data.pool_id] = String(e.data.terms.repo_id);
    for (const id of new Set(Object.values(poolRepo))) {
      const repo = await github(`/repositories/${id}`);
      if (repo) out.repos[id] = repo.full_name;
    }
    for (const e of evts.filter((x) => x.event === 'award')) {
      const { pool_id, pr, github_id } = e.data;
      if (!(github_id in out.users)) {
        const user = await github(`/user/${github_id}`);
        if (user) out.users[github_id] = user.login;
      }
      const repo = out.repos[poolRepo[pool_id]];
      if (repo) {
        const issue = await github(`/repos/${repo}/issues/${pr}`);
        const label = issue?.labels?.map((l) => l.name).find((n) => n.startsWith('pay:'));
        if (label) out.labels[`${pool_id}:${pr}`] = label;
      }
    }
    return out;
  }

  async function unspent(evts) {
    const ids = [...new Set(evts.filter((e) => e.event === 'funded').map((e) => e.data.pool_id))];
    let total = 0n;
    for (const pool_id of ids) {
      const pool = await view(cfg.contract, 'get_pool', { pool_id });
      if (pool) total += BigInt(pool.balance);
    }
    return total;
  }

  return { events, names, token, unspent, github };
}
