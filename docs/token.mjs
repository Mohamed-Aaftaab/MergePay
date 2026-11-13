// GitHub OIDC tokens as stored in award and link transactions: decode them, and re-check GitHub's RS256
// signature with WebCrypto against a key modulus (base64url), the same check the contract runs on-chain.

const b64urlToBytes = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const decodeJson = (part) => JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));

/** { header, claims } of a compact JWT, or null if it is not one. */
export function decode(jwt) {
  const parts = typeof jwt === 'string' ? jwt.split('.') : [];
  if (parts.length !== 3) return null;
  try {
    return { header: decodeJson(parts[0]), claims: decodeJson(parts[1]) };
  } catch {
    return null;
  }
}

/** True when `jwt` carries a valid RS256 signature by the RSA key with modulus `n` (base64url) and exponent 65537. */
export async function verifyRs256(jwt, n) {
  const parts = jwt.split('.');
  if (parts.length !== 3 || decode(jwt)?.header.alg !== 'RS256') return false;
  const key = await crypto.subtle.importKey(
    'jwk', { kty: 'RSA', n, e: 'AQAB', alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  );
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), signed);
}

/** The audience fields the contract reads, named. */
export function audience(claims) {
  const [contract, kind, ...rest] = String(claims?.aud ?? '').split('|');
  if (kind === 'award') {
    const [pool, pr, githubId, amount] = rest;
    return { contract, kind, pool: Number(pool), pr: Number(pr), githubId: Number(githubId), amount };
  }
  if (kind === 'link') return { contract, kind, account: rest[0] };
  return { contract, kind };
}
