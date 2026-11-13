// Token decoding and in-browser signature checks, and the console's event model. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { decode, verifyRs256, audience } from '../docs/token.mjs';
import { buildModel, ago } from '../docs/model.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const n = publicKey.export({ format: 'jwk' }).n;
const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }).n;
const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims, header = { alg: 'RS256', kid: 'k1' }) {
  const m = `${part(header)}.${part(claims)}`;
  return `${m}.${createSign('RSA-SHA256').update(m).sign(privateKey).toString('base64url')}`;
}
const CLAIMS = { iss: 'https://token.actions.githubusercontent.com', repository: 'acme/app', run_id: '42',
  aud: 'pay.near|award|2|3|118598305|10000000000000000000000' };

test('a GitHub-shaped token decodes and its signature verifies against the right key only', async () => {
  const token = jwt(CLAIMS);
  assert.deepEqual(decode(token).claims, CLAIMS);
  assert.equal(decode(token).header.kid, 'k1');
  assert.equal(await verifyRs256(token, n), true);
  assert.equal(await verifyRs256(token, other), false);
});

test('any change to the signed part fails verification', async () => {
  const [h, , s] = jwt(CLAIMS).split('.');
  const forged = `${h}.${part({ ...CLAIMS, aud: 'pay.near|award|2|3|1|999' })}.${s}`;
  assert.equal(await verifyRs256(forged, n), false);
  assert.equal(await verifyRs256(jwt(CLAIMS, { alg: 'none', kid: 'k1' }), n), false);
  assert.equal(decode('not.a-token'), null);
  assert.equal(decode(undefined), null);
});

test('audience fields are named the way the contract reads them', () => {
  assert.deepEqual(audience(CLAIMS), { contract: 'pay.near', kind: 'award', pool: 2, pr: 3, githubId: 118598305, amount: '10000000000000000000000' });
  assert.deepEqual(audience({ aud: 'pay.near|link|dev.near' }), { contract: 'pay.near', kind: 'link', account: 'dev.near' });
});

const ev = (event, data, ts, tx = `t${ts}`) => ({ event, data, ts: String(ts), tx });
const EVENTS = [
  ev('funded', { pool_id: 2, funder: 'acme.near', amount: '400', terms: { repo_id: 7, cap: '100' } }, 1),
  ev('funded', { pool_id: 2, funder: 'beta.near', amount: '100' }, 2),
  ev('award', { pool_id: 2, pr: 2, github_id: 9, amount: '10' }, 3),
  ev('award', { pool_id: 2, pr: 3, github_id: 9, amount: '10' }, 4),
  ev('pay_failed', { pool_id: 2, pr: 3, account: 'x' }, 5),
  ev('linked', { github_id: 9, account: 'dev.near' }, 6),
  ev('linked', { github_id: 777, account: 'stranger.near' }, 6), // a link outside these pools
  ev('paid', { pool_id: 2, pr: 2, account: 'dev.near', amount: '10' }, 7),
  ev('award', { pool_id: 2, pr: 4, github_id: 11, amount: '5' }, 8),
  ev('award_expired', { pool_id: 2, pr: 4, amount: '5' }, 9),
];

test('the model follows each award to its final status and totals it once', () => {
  const m = buildModel(EVENTS);
  assert.deepEqual(m.awards.map((a) => `${a.pr}:${a.status}`), ['4:Refunded', '3:Pending', '2:Paid']);
  assert.equal(m.awards.find((a) => a.pr === 3).failedAttempts, 1);
  assert.equal(m.awards.find((a) => a.pr === 2).payoutTx, 't7');
  assert.deepEqual(m.totals, { paid: '10', pending: '10', paidCount: 1, awards: 3, contributors: 2, funded: '500' });
});

test('pools add up funders and exclude returned awards; contributors carry their link', () => {
  const m = buildModel(EVENTS);
  const pool = m.pools[0];
  assert.equal(pool.funded, '500');
  assert.deepEqual(pool.funders, { 'acme.near': '400', 'beta.near': '100' });
  assert.equal(pool.awarded, '20');
  assert.equal(pool.terms.repo_id, 7);
  const dev = m.contributors.find((c) => c.githubId === 9);
  assert.deepEqual([dev.paid, dev.pending, dev.prs, dev.link.account], ['10', '10', 2, 'dev.near']);
  assert.equal(m.contributors.find((c) => c.githubId === 11).link, null);
  assert.equal(m.contributors.some((c) => c.githubId === 777), false);
});

test('relative times read naturally', () => {
  const ns = (ms) => String(BigInt(ms) * 1_000_000n);
  assert.equal(ago(ns(100_000), 130_000), '30s ago');
  assert.equal(ago(ns(0), 7_200_000), '2 h ago');
  assert.equal(ago(ns(0), 3 * 86_400_000), '3 d ago');
});
