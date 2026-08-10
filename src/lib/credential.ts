/**
 * Offline verification of Credda Verifiable Trust Credentials.
 *
 * Verifies an EdDSA (Ed25519) signed credential against Credda's published JWKS
 * using Web Crypto. It works in Node 20+ and modern browsers. Once the JWKS is
 * cached, verification is fully local: no call to Credda is needed to trust a
 * credential. See the scoring API's docs/TRUST_CREDENTIALS.md.
 */

/** Fact set attested by a credential. Fields present depend on the disclosure scope. */
export interface TrustCredentialFacts {
  scoreBand: string;
  finalScore?: number;
  confidence?: number;
  verifiedPlatforms?: number;
  totalEvents?: number;
  scoreFrozen?: boolean;
  formulaVersion?: string;
}

export interface VerifiedCredential {
  valid: true;
  issuer: string;
  subject: string;
  /** Disclosure scope: 'full' | 'band' | 'minimal' (default 'full'). */
  scope: string;
  issuedAt: number;
  expiresAt: number;
  cred: TrustCredentialFacts;
}

interface Ed25519Jwk {
  kty: string;
  crv: string;
  x: string;
  kid: string;
  alg?: string;
}

const DEFAULT_BASE = 'https://api.credda.io';
const JWKS_TTL_MS = 5 * 60 * 1000;

let jwksCache: { uri: string; keys: Ed25519Jwk[]; fetchedAt: number } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4;
  if (pad) t += '='.repeat(4 - pad);
  if (typeof atob === 'undefined') {
    throw new Error('credda: base64 decoder (atob) unavailable in this environment');
  }
  const bin = atob(t);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeJson<T>(seg: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(seg))) as T;
}

async function fetchJwks(uri: string): Promise<Ed25519Jwk[]> {
  const now = Date.now();
  if (jwksCache && jwksCache.uri === uri && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`credda: could not fetch JWKS (${res.status})`);
  const body = (await res.json()) as { keys: Ed25519Jwk[] };
  jwksCache = { uri, keys: body.keys ?? [], fetchedAt: now };
  return jwksCache.keys;
}

export interface VerifyOptions {
  /** Scoring API base (JWKS is fetched from `${apiBase}/.well-known/jwks.json`). */
  apiBase?: string;
  /** Explicit JWKS URI (overrides apiBase). */
  jwksUri?: string;
  /** Expected issuer. Defaults to 'credda.io'. */
  issuer?: string;
  /** Preloaded JWKS (skips the network entirely). */
  jwks?: { keys: Ed25519Jwk[] };
}

/**
 * Verify a credential offline. Resolves with the attested facts on success;
 * rejects if the signature, expiry, or issuer is invalid.
 */
export async function verifyTrustCredential(
  credential: string,
  opts: VerifyOptions = {},
): Promise<VerifiedCredential> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle) throw new Error('credda: WebCrypto (Ed25519) is not available in this environment');

  const parts = credential.split('.');
  if (parts.length !== 3) throw new Error('credda: malformed credential');
  const [h, p, s] = parts;

  const header = decodeJson<{ alg: string; kid?: string }>(h);
  if (header.alg !== 'EdDSA') throw new Error(`credda: unexpected alg ${header.alg}`);

  const base = (opts.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
  const keys = opts.jwks?.keys ?? (await fetchJwks(opts.jwksUri ?? `${base}/.well-known/jwks.json`));
  const jwk = keys.find((k) => k.kid === header.kid) ?? keys[0];
  if (!jwk) throw new Error('credda: no verification key available');

  const key = await subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, ext: true },
    { name: 'Ed25519' },
    false,
    ['verify'],
  );

  const data = new TextEncoder().encode(`${h}.${p}`);
  const ok = await subtle.verify({ name: 'Ed25519' }, key, b64urlToBytes(s) as BufferSource, data);
  if (!ok) throw new Error('credda: invalid credential signature');

  const payload = decodeJson<{ iss: string; sub: string; iat: number; exp: number; scope?: string; cred: TrustCredentialFacts }>(p);
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now >= payload.exp) throw new Error('credda: credential expired');
  const expectedIssuer = opts.issuer ?? 'credda.io';
  if (payload.iss !== expectedIssuer) throw new Error('credda: issuer mismatch');

  return {
    valid: true,
    issuer: payload.iss,
    subject: payload.sub,
    scope: payload.scope ?? 'full',
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    cred: payload.cred,
  };
}

// ─── W3C Verifiable Credential (VC-JWT) verification: Trust Fabric v3 ──────────

interface DidVerificationMethod {
  id: string;
  publicKeyJwk: { kty: string; crv: string; x: string };
}
interface DidDocument {
  id: string;
  verificationMethod: DidVerificationMethod[];
}

export interface VerifiedVc {
  valid: true;
  /** Issuer DID (e.g. did:web:api.credda.io). */
  issuer: string;
  subject: string;
  scope: string;
  issuedAt: number;
  expiresAt: number;
  /** Attested facts from the credentialSubject (minus id/scope). */
  cred: TrustCredentialFacts;
  /** The full `vc` claim. */
  vc: Record<string, unknown>;
}

export interface VerifyVcOptions {
  /** Preloaded DID document (skips resolution). */
  didDocument?: DidDocument;
  /** Fallback JWKS base if the DID can't be resolved. */
  apiBase?: string;
  jwks?: { keys: Ed25519Jwk[] };
  /** Expected issuer DID. */
  issuer?: string;
  /**
   * Check StatusList2021 revocation when the credential carries a
   * `credentialStatus` (default: true). Set false to skip the network fetch.
   */
  checkRevocation?: boolean;
  /**
   * Preloaded, already-trusted revocation list (its `encodedList`). Skips the
   * fetch + signature verification of the status-list credential. Use only when
   * you obtained the list through a trusted channel.
   */
  statusList?: { encodedList: string };
}

/** A `credentialStatus` entry (W3C StatusList2021). */
export interface CredentialStatusEntry {
  id?: string;
  type?: string;
  statusPurpose?: string;
  statusListIndex: string | number;
  statusListCredential: string;
}

const didDocCache = new Map<string, { doc: DidDocument; fetchedAt: number }>();

/** Resolve a did:web identifier to its DID document URL and fetch it. */
async function resolveDidWeb(did: string): Promise<DidDocument> {
  const cached = didDocCache.get(did);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.doc;

  const parts = did.split(':');
  if (parts[0] !== 'did' || parts[1] !== 'web') throw new Error(`credda: unsupported DID method: ${did}`);
  const host = decodeURIComponent(parts[2] ?? '');
  const path = parts.slice(3).map(decodeURIComponent);
  const url = path.length ? `https://${host}/${path.join('/')}/did.json` : `https://${host}/.well-known/did.json`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`credda: could not resolve DID (${res.status})`);
  const doc = (await res.json()) as DidDocument;
  didDocCache.set(did, { doc, fetchedAt: Date.now() });
  return doc;
}

// ─── StatusList2021 revocation ─────────────────────────────────────────────────

/** GZIP-decompress a base64url `encodedList` into raw bitstring bytes. */
async function gunzipBase64url(s: string): Promise<Uint8Array> {
  const bytes = b64urlToBytes(s);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('credda: gzip decompression (DecompressionStream) unavailable in this environment');
  }
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** StatusList2021 bit order: bit `i` is `0x80 >> (i & 7)` of byte `i >> 3` (MSB-first). */
function bitIsSet(bytes: Uint8Array, index: number): boolean {
  const byte = index >> 3;
  if (byte < 0 || byte >= bytes.length) return false;
  return (bytes[byte] & (0x80 >> (index & 7))) !== 0;
}

/**
 * Resolve whether a credential's `credentialStatus` says it is revoked. Fetches
 * the referenced status-list credential, **verifies its signature** (same issuer
 * DID/JWKS), decodes the bitstring, and reads the subject's bit. Pass
 * `opts.statusList` to check against an already-trusted list instead.
 */
export async function isCredentialRevoked(
  status: CredentialStatusEntry,
  opts: VerifyVcOptions = {},
): Promise<boolean> {
  const index = Number(status.statusListIndex);
  if (!Number.isInteger(index) || index < 0) throw new Error('credda: invalid statusListIndex');

  let encodedList = opts.statusList?.encodedList;
  if (!encodedList) {
    if (!status.statusListCredential) throw new Error('credda: credentialStatus has no statusListCredential');
    const res = await fetch(status.statusListCredential);
    if (!res.ok) throw new Error(`credda: could not fetch status list (${res.status})`);
    const body = (await res.json()) as { statusListVc?: string; credentialVc?: string };
    const listVc = body.statusListVc ?? body.credentialVc;
    if (!listVc) throw new Error('credda: status-list response missing the signed credential');
    // Verify the list's own signature + issuer; never recurse into revocation.
    const verified = await verifyVerifiableCredential(listVc, { ...opts, checkRevocation: false, statusList: undefined });
    const subj = verified.vc.credentialSubject as Record<string, unknown> | undefined;
    encodedList = typeof subj?.encodedList === 'string' ? subj.encodedList : undefined;
    if (!encodedList) throw new Error('credda: status-list credential has no encodedList');
  }

  const bytes = await gunzipBase64url(encodedList);
  return bitIsSet(bytes, index);
}

/**
 * Verify a W3C Verifiable Credential (VC-JWT) offline. Resolves the issuer's
 * did:web DID document to find the signing key (JWKS fallback), verifies the
 * EdDSA signature, checks expiry and issuer, checks StatusList2021 revocation if
 * present, and returns the attested facts. Rejects on any failure (including a
 * revoked credential).
 */
export async function verifyVerifiableCredential(
  vcJwt: string,
  opts: VerifyVcOptions = {},
): Promise<VerifiedVc> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle) throw new Error('credda: WebCrypto (Ed25519) is not available in this environment');

  const parts = vcJwt.split('.');
  if (parts.length !== 3) throw new Error('credda: malformed credential');
  const [h, p, s] = parts;

  const header = decodeJson<{ alg: string; kid?: string }>(h);
  if (header.alg !== 'EdDSA') throw new Error(`credda: unexpected alg ${header.alg}`);
  const kid = header.kid ?? '';
  const did = kid.split('#')[0];

  let jwk: { kty: string; crv: string; x: string } | undefined;
  const doc = opts.didDocument ?? (did ? await resolveDidWeb(did).catch(() => undefined) : undefined);
  if (doc) {
    const vm = doc.verificationMethod?.find((v) => v.id === kid) ?? doc.verificationMethod?.[0];
    jwk = vm?.publicKeyJwk;
  }
  if (!jwk) {
    const base = (opts.apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');
    const keys = opts.jwks?.keys ?? (await fetchJwks(`${base}/.well-known/jwks.json`));
    const frag = kid.includes('#') ? kid.split('#')[1] : kid;
    jwk = keys.find((k) => k.kid === frag) ?? keys[0];
  }
  if (!jwk) throw new Error('credda: no verification key available');

  const key = await subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, ext: true }, { name: 'Ed25519' }, false, ['verify']);
  const data = new TextEncoder().encode(`${h}.${p}`);
  const ok = await subtle.verify({ name: 'Ed25519' }, key, b64urlToBytes(s) as BufferSource, data);
  if (!ok) throw new Error('credda: invalid credential signature');

  const payload = decodeJson<{ iss: string; sub: string; nbf?: number; iat?: number; exp?: number; vc?: Record<string, unknown> }>(p);
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now >= payload.exp) throw new Error('credda: credential expired');
  if (opts.issuer && payload.iss !== opts.issuer) throw new Error('credda: issuer mismatch');

  const vc = payload.vc ?? {};

  // StatusList2021 revocation: reject a revoked credential like an expired one.
  const status = vc.credentialStatus as CredentialStatusEntry | undefined;
  if (status && opts.checkRevocation !== false) {
    if (await isCredentialRevoked(status, opts)) throw new Error('credda: credential revoked');
  }

  const cs = { ...((vc.credentialSubject as Record<string, unknown>) ?? {}) };
  const scope = typeof cs.scope === 'string' ? cs.scope : 'full';
  delete cs.id;
  delete cs.scope;

  return {
    valid: true,
    issuer: payload.iss,
    subject: payload.sub,
    scope,
    issuedAt: payload.nbf ?? payload.iat ?? 0,
    expiresAt: payload.exp ?? 0,
    cred: cs as unknown as TrustCredentialFacts,
    vc,
  };
}
