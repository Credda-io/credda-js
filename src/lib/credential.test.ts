/**
 * SDK revocation tests. Generates a real Ed25519 key, signs a StatusList2021
 * credential + a trust VC that references it, and verifies the full offline
 * revocation check end to end (signature of the list included). No real network:
 * `fetch` is stubbed to serve the signed status list.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { gzipSync } from 'zlib';
import { verifyVerifiableCredential, isCredentialRevoked } from './credential.js';

const LIST_SIZE = 131_072;
const STATUS_URL = 'https://api.test/api/v1/status/revocation';
const KID = 'did:web:api.test#key-1';

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url(gzip(bitstring)) with the given indices set (MSB-first). */
function encodeList(revoked: number[]): string {
  const bytes = new Uint8Array(LIST_SIZE >> 3);
  for (const i of revoked) bytes[i >> 3] |= 0x80 >> (i & 7);
  return gzipSync(Buffer.from(bytes)).toString('base64url');
}

let priv: CryptoKey;
let jwks: { keys: Array<{ kty: string; crv: string; x: string; kid: string }> };

async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'EdDSA', kid: KID, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = new TextEncoder().encode(`${header}.${body}`);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, priv, data));
  return `${header}.${body}.${b64url(sig)}`;
}

function statusListVc(revoked: number[]): Promise<string> {
  return signJwt({
    iss: 'did:web:api.test', sub: `${STATUS_URL}#list`, iat: 1_700_000_000,
    vc: {
      '@context': ['https://www.w3.org/2018/credentials/v1', 'https://w3id.org/vc/status-list/2021/v1'],
      id: STATUS_URL, type: ['VerifiableCredential', 'StatusList2021Credential'], issuer: 'did:web:api.test',
      credentialSubject: { id: `${STATUS_URL}#list`, type: 'StatusList2021', statusPurpose: 'revocation', encodedList: encodeList(revoked) },
    },
  });
}

function trustVc(index: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss: 'did:web:api.test', sub: 'urn:credda:token:abc', nbf: now, iat: now, exp: now + 3600,
    vc: {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', 'CreddaTrustCredential'], issuer: 'did:web:api.test',
      credentialSubject: { id: 'urn:credda:token:abc', scope: 'full', scoreBand: 'Excellent' },
      credentialStatus: { id: `${STATUS_URL}#${index}`, type: 'StatusList2021Entry', statusPurpose: 'revocation', statusListIndex: String(index), statusListCredential: STATUS_URL },
    },
  });
}

beforeEach(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  priv = pair.privateKey;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as { kty: string; crv: string; x: string };
  jwks = { keys: [{ kty: pub.kty, crv: pub.crv, x: pub.x, kid: 'key-1' }] };
});

afterEach(() => vi.unstubAllGlobals());

function stubFetchWith(listVc: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url) === STATUS_URL) return new Response(JSON.stringify({ statusListVc: listVc }), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  }));
}

describe('verifyVerifiableCredential + StatusList2021 revocation', () => {
  it('accepts a credential whose bit is clear', async () => {
    stubFetchWith(await statusListVc([999])); // some other index revoked
    const res = await verifyVerifiableCredential(await trustVc(42), { jwks });
    expect(res.valid).toBe(true);
    expect(res.cred.scoreBand).toBe('Excellent');
  });

  it('rejects a credential whose bit is set (revoked)', async () => {
    stubFetchWith(await statusListVc([42]));
    await expect(verifyVerifiableCredential(await trustVc(42), { jwks })).rejects.toThrow(/revoked/);
  });

  it('skips the check when checkRevocation is false', async () => {
    stubFetchWith(await statusListVc([42]));
    const res = await verifyVerifiableCredential(await trustVc(42), { jwks, checkRevocation: false });
    expect(res.valid).toBe(true);
  });

  it('rejects if the status-list signature is invalid', async () => {
    // Sign the list with a DIFFERENT key than the jwks the verifier trusts.
    const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const realPriv = priv; priv = other.privateKey;
    const badList = await statusListVc([]);
    priv = realPriv;
    stubFetchWith(badList);
    await expect(verifyVerifiableCredential(await trustVc(1), { jwks })).rejects.toThrow(/signature/);
  });
});

describe('isCredentialRevoked with a preloaded list', () => {
  const status = { type: 'StatusList2021Entry', statusListIndex: '7', statusListCredential: STATUS_URL };

  it('reads the bit without any network', async () => {
    expect(await isCredentialRevoked({ ...status }, { statusList: { encodedList: encodeList([7]) } })).toBe(true);
    expect(await isCredentialRevoked({ ...status }, { statusList: { encodedList: encodeList([8]) } })).toBe(false);
  });

  it('rejects an invalid index', async () => {
    await expect(isCredentialRevoked({ ...status, statusListIndex: 'x' }, { statusList: { encodedList: encodeList([]) } })).rejects.toThrow(/invalid statusListIndex/);
  });
});
