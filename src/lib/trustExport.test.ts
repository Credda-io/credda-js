/**
 * verifyTrustExport tests: sign a real W3C VC (Ed25519), wrap it in an export
 * bundle, and verify end-to-end with preloaded JWKS (no network). Covers the
 * tamper + format failure paths.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { verifyTrustExport } from './trustExport.js';
import type { TrustExport } from './client.js';

const KID = 'did:web:api.test#key-1';
let priv: CryptoKey;
let jwks: { keys: Array<{ kty: string; crv: string; x: string; kid: string }> };

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signVc(scoreBand: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'EdDSA', kid: KID, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: 'did:web:api.test', sub: 'urn:credda:token:abc', nbf: now, iat: now, exp: now + 3600,
    vc: {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', 'CreddaTrustCredential'], issuer: 'did:web:api.test',
      credentialSubject: { id: 'urn:credda:token:abc', scope: 'full', scoreBand, finalScore: 82 },
    },
  }));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, priv, data));
  return `${header}.${payload}.${b64url(sig)}`;
}

function bundle(vc: string, scoreBand: string): TrustExport {
  return {
    format: 'credda-trust-export/1', exportedAt: '2026-07-18T12:00:00.000Z',
    subject: { token: 'crd_share_abc' },
    score: { finalScore: 82, scoreBand, confidence: 1, formulaVersion: '3.0', computedAt: null, scoreFrozen: false },
    activity: { verifiedPlatforms: 3, totalEvents: 40 },
    history: [],
    credential: { format: 'jwt_vc_json', vc, issuer: 'did:web:api.test' },
    revocation: { statusListCredential: 'https://api.test/api/v1/status/revocation' },
    howToVerify: 'Verify offline …',
  };
}

beforeEach(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  priv = pair.privateKey;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as { kty: string; crv: string; x: string };
  jwks = { keys: [{ kty: pub.kty, crv: pub.crv, x: pub.x, kid: 'key-1' }] };
});

describe('verifyTrustExport', () => {
  it('verifies a well-formed export and returns the signed facts', async () => {
    const vc = await signVc('Excellent');
    const res = await verifyTrustExport(bundle(vc, 'Excellent'), { jwks, checkRevocation: false, apiBase: 'https://api.test' });
    expect(res.credential.valid).toBe(true);
    expect((res.credential.cred as { scoreBand: string }).scoreBand).toBe('Excellent');
  });

  it('rejects an unrecognised format', async () => {
    const vc = await signVc('Excellent');
    const b = { ...bundle(vc, 'Excellent'), format: 'nope' } as unknown as TrustExport;
    await expect(verifyTrustExport(b, { jwks, checkRevocation: false, apiBase: 'https://api.test' })).rejects.toThrow(/format/);
  });

  it('rejects a tampered plaintext score (mismatch with signed credential)', async () => {
    const vc = await signVc('Excellent');           // signed says Excellent
    const b = bundle(vc, 'High Risk');              // plaintext edited to High Risk
    await expect(verifyTrustExport(b, { jwks, checkRevocation: false, apiBase: 'https://api.test' })).rejects.toThrow(/does not match|tampered/i);
  });

  it('rejects when the credential signature is invalid (wrong key)', async () => {
    const vc = await signVc('Excellent');
    const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const pub = (await crypto.subtle.exportKey('jwk', other.publicKey)) as { kty: string; crv: string; x: string };
    const wrongJwks = { keys: [{ kty: pub.kty, crv: pub.crv, x: pub.x, kid: 'key-1' }] };
    await expect(verifyTrustExport(bundle(vc, 'Excellent'), { jwks: wrongJwks, checkRevocation: false, apiBase: 'https://api.test' })).rejects.toThrow(/signature/);
  });
});
