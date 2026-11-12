// The one place that says which deployment this site shows. `?contract=` and `?pools=` in the URL override it.
export const SITE = {
  contract: 'pay.mergepay-482529.testnet',
  // Pool 0 on this contract was a smoke test with made-up GitHub ids that belong to unrelated real people.
  pools: [1, 2],
  repo: 'Mohamed-Aaftaab/MergePay', // where this site's own code lives
  dueDays: 7, // a statement is due this many days after its period ends
};

const NETWORKS = {
  testnet: {
    rpcs: ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'], // first that answers wins
    indexer: 'https://api-testnet.nearblocks.io/v3',
    explorer: 'https://testnet.near.rocks', // serves pages to scripts too, unlike explorers behind a bot check
  },
  mainnet: {
    rpcs: ['https://rpc.mainnet.fastnear.com', 'https://rpc.mainnet.near.org'],
    indexer: 'https://api.nearblocks.io/v3',
    explorer: 'https://near.rocks',
  },
};

export function settings(search = globalThis.location?.search ?? '') {
  const params = new URLSearchParams(search);
  const contract = params.get('contract') || SITE.contract;
  const network = contract.endsWith('.testnet') ? 'testnet' : 'mainnet';
  const poolParam = params.get('pools');
  const pools = poolParam !== null ? poolParam.split(',').filter(Boolean).map(Number)
    : contract === SITE.contract ? SITE.pools : [];
  const endpoints = NETWORKS[network];
  return {
    ...SITE, contract, network, pools, ...endpoints,
    txUrl: (hash) => `${endpoints.explorer}/tx/${hash}`,
    accountUrl: (id) => `${endpoints.explorer}/account/${id}`,
  };
}
