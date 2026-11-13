// The console frame shared by every page: sidebar, top bar, and one load of the contract's data.
import { SITE, settings } from './config.mjs';
import { reader } from './chain.mjs';
import { h, $, icon, short } from './ui.mjs';

const NAV = [
  ['Workspace', [['overview', 'console.html', 'Overview'], ['payouts', 'payouts.html', 'Payouts'], ['pools', 'pools.html', 'Pools'], ['contributors', 'contributors.html', 'Contributors']]],
  ['Records', [['statement', 'statement.html', 'Statement']]],
  ['Trust', [['proof', 'proof.html', 'Proof'], ['system', 'system.html', 'System']]],
];

export function mount(page, title) {
  const cfg = settings();
  // carry a deployment override (?contract=, ?pools=) from page to page
  const current = new URLSearchParams(location.search);
  const carry = new URLSearchParams([...current].filter(([k]) => k === 'contract' || k === 'pools')).toString();
  const keep = (href) => (carry ? `${href}?${carry}` : href);
  $('side').replaceChildren(
    h('a', { class: 'brand', href: './' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, '//'), 'MergePay'),
    h('div', { class: 'workspace' },
      h('div', { class: 'ws-name' }, 'Pilot workspace'),
      h('div', { class: 'ws-sub' }, short(cfg.contract, 14, 8)),
      h('div', { class: 'ws-sub' }, `NEAR ${cfg.network}${cfg.pools.length ? ` · pools ${cfg.pools.join(', ')}` : ''}`)),
    ...NAV.map(([label, items]) => h('nav', { class: 'nav-group', 'aria-label': label },
      h('div', { class: 'label' }, label),
      items.map(([id, href, text]) => h('a', { class: 'nav-item', href: keep(href), 'aria-current': id === page ? 'page' : null, id: `nav-${id}` },
        icon(id), text)))),
    h('div', { class: 'side-foot' }, h('b', {}, `${cfg.network === 'testnet' ? 'Testnet pilot' : 'Mainnet'}`),
      'Pays in the token the contract reports. Not audited yet: keep pools small.'),
  );
  const syncDot = h('span', { class: 'dot busy' });
  const syncText = h('span', {}, 'Connecting…');
  const syncWhen = h('span', { class: 'when' });
  const app = document.querySelector('.app');
  $('topbar').replaceChildren(
    h('button', { class: 'btn menu-btn', type: 'button', 'aria-label': 'Menu', onclick: () => app.classList.toggle('open') }, icon('menu')),
    h('div', { class: 'crumbs' }, h('span', { class: 'pre' }, 'Console / '), h('b', {}, title)),
    h('div', { class: 'spacer' }),
    h('div', { class: 'sync', role: 'status', 'aria-live': 'polite' }, syncDot, syncText, syncWhen),
    h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, icon('refresh'), 'Refresh'),
  );
  document.addEventListener('click', (e) => { if (app.classList.contains('open') && !e.target.closest('.side, .menu-btn')) app.classList.remove('open'); });

  const setStatus = (text, state = 'busy', when = '') => { syncText.textContent = text; syncWhen.textContent = when; syncDot.className = `dot ${state}`; };
  const chain = reader(cfg, (msg) => setStatus(msg));
  const data = chain.load().then((d) => {
    const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setStatus('Synced', 'ok', ` ${time}`);
    const count = $('nav-payouts');
    if (count) count.append(h('span', { class: 'count' }, d.model.awards.length));
    return d;
  }, (err) => {
    const missing = /UNKNOWN_ACCOUNT|CodeDoesNotExist|MethodNotFound/.test(err.message);
    setStatus('Could not reach the contract', 'bad');
    const msg = missing ? `There is no MergePay contract at ${cfg.contract} on NEAR ${cfg.network}.` : `Could not load the contract: ${err.message}`;
    $('page').prepend(h('div', { class: 'notice', role: 'alert' }, msg));
    throw err;
  });
  return { cfg, chain, data, site: SITE };
}
