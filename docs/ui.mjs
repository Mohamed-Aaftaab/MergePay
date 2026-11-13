// Small DOM helpers shared by the console pages. Text always goes in as text nodes, never as HTML.
import { formatAmount } from './ledger.mjs';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only ever used with our own static SVG strings
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const $ = (id) => document.getElementById(id);

/** Display text for a token amount: at most `max` decimals, "≈" when rounded, "<" for dust. Exact value stays in the CSV. */
export function amountText(base, tok, max = 6) {
  const full = formatAmount(base, tok.decimals).replace(/\.?0+$/, '') || '0';
  const [whole, frac = ''] = full.split('.');
  if (frac.length <= max) return { text: full, full, rounded: false };
  const cut = `${whole}.${frac.slice(0, max)}`.replace(/\.?0+$/, '');
  if (/^0$/.test(cut)) return { text: `< 0.${'0'.repeat(max - 1)}1`, full, rounded: true };
  return { text: `≈ ${cut}`, full, rounded: true };
}

/** Token amount element; hover shows the exact value when the display is rounded. */
export function amount(base, tok, withSymbol = true, max = 6) {
  const { text, full, rounded } = amountText(base, tok, max);
  return h('span', { title: rounded ? `${full} ${tok.symbol} exactly` : null, class: 'amt' }, withSymbol ? `${text} ${tok.symbol}` : text);
}

/** ".github/workflows/award.yml @ main" from a job_workflow_ref like owner/repo/.github/workflows/award.yml@refs/heads/main */
export const workflowLabel = (ref = '') => {
  const [path, at] = ref.split('@');
  return `${path.split('/').slice(2).join('/')} @ ${(at ?? '').replace('refs/heads/', '')}`;
};

export const short = (s, a = 8, b = 6) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s ?? '');

export function status(s) {
  return h('span', { class: `pill-s s-${s}` }, s);
}

export function ext(href, text, cls = 'link') {
  return h('a', { href, class: cls, target: '_blank', rel: 'noopener' }, text);
}

export function avatar(githubId) {
  return h('img', { class: 'avatar', src: `https://avatars.githubusercontent.com/u/${githubId}?s=48`, alt: '', loading: 'lazy' });
}

export function when(ns) {
  return new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
}

const path = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICON = {
  overview: path('<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>'),
  payouts: path('<path d="M3 7h18M3 12h18M3 17h11"/>'),
  pools: path('<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'),
  contributors: path('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M16.5 14.6c2.5.3 4.3 2 5 5.4"/>'),
  statement: path('<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>'),
  proof: path('<path d="M12 3l8 3v6c0 4.5-3.3 8.3-8 9-4.7-.7-8-4.5-8-9V6z"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>'),
  system: path('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
  merge: path('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8.3 7.2C11 9.5 13 11 15.5 11.7"/>'),
  key: path('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>'),
  check: path('<path d="M12 3l8 3v6c0 4.5-3.3 8.3-8 9-4.7-.7-8-4.5-8-9V6z"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>'),
  coin: path('<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.5c-.5-1-1.4-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.1 0-2-.5-2.5-1.5M12 6.5v11"/>'),
  refresh: path('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>'),
  search: path('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  menu: path('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  clock: path('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  users: path('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/>'),
};
export const icon = (name) => h('span', { html: ICON[name], style: 'display:contents' });
