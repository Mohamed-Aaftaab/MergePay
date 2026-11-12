//! RSASSA-PKCS1-v1_5 verification with SHA-256 (RFC 8017 section 8.2.2), public exponent 65537.
use near_sdk::env;
use num_bigint::BigUint;

// DER DigestInfo prefix for SHA-256 (RFC 8017 section 9.2, note 1)
const SHA256_PREFIX: [u8; 19] = [
    0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05,
    0x00, 0x04, 0x20,
];
const HASH_LEN: usize = 32;

/// `n` is the big-endian modulus without a leading zero byte.
pub fn verify_rs256(n: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    let k = n.len();
    if k < 256 || sig.len() != k {
        return false;
    }
    let modulus = BigUint::from_bytes_be(n);
    let s = BigUint::from_bytes_be(sig);
    if s >= modulus {
        return false;
    }
    let em = s.modpow(&BigUint::from(65537u32), &modulus).to_bytes_be();

    // Build the one valid encoding and compare all of it: parsing the padding instead is how forgeries get in.
    let mut expected = vec![0xff; k];
    expected[0] = 0x00;
    expected[1] = 0x01;
    let t = k - HASH_LEN - SHA256_PREFIX.len();
    expected[t - 1] = 0x00;
    expected[t..t + SHA256_PREFIX.len()].copy_from_slice(&SHA256_PREFIX);
    expected[t + SHA256_PREFIX.len()..].copy_from_slice(&env::sha256(msg));
    // to_bytes_be drops the leading 0x00
    em == expected[1..]
}
