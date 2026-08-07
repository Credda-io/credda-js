/**
 * Verify the Web Bot Auth signature on an inbound Credda webhook delivery.
 *
 * This is the OPTIONAL, second signature on a delivery. It answers a different
 * question from `verifyWebhookSignature`:
 *
 *   X-Credda-Signature (HMAC)  → "this body is authentic". Verify this. Always.
 *   Signature / Signature-Input → "this REQUEST came from Credda, an automated
 *                                  agent that publishes its keys" (RFC 9421 +
 *                                  Web Bot Auth). Normally verified by
 *                                  bot-mitigation infrastructure in front of
 *                                  you — this helper exists for receivers who
 *                                  terminate their own edge.
 *
 * The HMAC check is the one that protects the payload. This one does not
 * replace it: passing here says nothing about the body, which is not a covered
 * component.
 *
 * ── Implemented against ─────────────────────────────────────────────────────
 *   RFC 9421 (HTTP Message Signatures, 2024-02)
 *   draft-meunier-web-bot-auth-architecture-02
 *   draft-meunier-http-message-signatures-directory-03
 * Credda serves the exact revisions it signs with as `x-credda-spec-versions`
 * on https://api.credda.io/.well-known/http-message-signatures-directory.
 *
 * ── This helper never makes a network request ───────────────────────────────
 * You supply the key directory. Fetching whatever URL the inbound
 * `Signature-Agent` header names would be a server-side request forgery
 * primitive driven by an unauthenticated header, so the SDK will not do it.
 * Fetch Credda's directory yourself, cache it (it is served with
 * `Cache-Control: max-age=86400`), and pass it in.
 *
 * Requires WebCrypto Ed25519 (Node 18.4+, Chrome 137+, Safari 17+, Firefox
 * 129+). Where it is unavailable the result is `{ valid: false, reason }` — a
 * clear signal, never a silent pass.
 */

/** An Ed25519 JWK from a Web Bot Auth signature directory. */
export interface WebBotAuthJwk {
  kty: string;
  crv: string;
  x: string;
  kid: string;
  use?: string;
  alg?: string;
  nbf?: number;
  exp?: number;
}

/** The signature directory document (a JWKS). */
export interface WebBotAuthDirectory {
  keys: WebBotAuthJwk[];
}

export interface VerifyWebBotAuthInput {
  /** HTTP method of the received request (Credda sends `POST`). */
  method: string;
  /**
   * The ABSOLUTE URL the request was made to, as the client saw it — scheme,
   * host and path. Behind a proxy, reconstruct it from your forwarded headers;
   * `@target-uri` and `@authority` are covered components, so a mismatch here
   * is indistinguishable from a forged signature.
   */
  url: string;
  /** Received request headers (names matched case-insensitively). */
  headers: Record<string, string | string[] | undefined>;
  /** Credda's signature directory, fetched and cached by you. */
  directory: WebBotAuthDirectory;
  /**
   * Require `Signature-Agent` to be exactly this origin. Strongly recommended —
   * without it, any correctly signed agent whose key happens to be in the
   * directory you passed will verify. Default: no check.
   */
  expectedAgent?: string;
  /** Reject signatures whose `created`/`expires` window has lapsed. Default true. */
  checkExpiry?: boolean;
  /** Clock skew allowance in seconds when checking the window. Default 300. */
  toleranceSeconds?: number;
  /** Override the current time (unix seconds) — for tests. */
  nowSeconds?: number;
}

export interface WebBotAuthVerification {
  valid: boolean;
  reason?: string;
  /** The `keyid` parameter of the verified signature. */
  keyId?: string;
  /** The `Signature-Agent` value (unquoted), when present. */
  agent?: string;
}

// ─── Structured-field parsing (the constrained subset Web Bot Auth uses) ──────

interface ParsedSignature {
  label: string;
  /** The exact received serialization of the inner list + params. */
  raw: string;
  components: Array<{ name: string; req: boolean }>;
  params: Record<string, string | number>;
}

/**
 * Split a Structured Fields Dictionary into `label=value` members, respecting
 * quoted strings and parentheses so a comma inside either is not a separator.
 */
function splitDictionary(value: string): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  let depth = 0;
  let inQuotes = false;
  let escaped = false;
  let current = '';

  const push = (member: string) => {
    const trimmed = member.trim();
    if (!trimmed) return;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return;
    out.push({ label: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim() });
  };

  for (const ch of value) {
    if (escaped) { current += ch; escaped = false; continue; }
    if (inQuotes) {
      current += ch;
      if (ch === '\\') escaped = true;
      else if (ch === '"') inQuotes = false;
      continue;
    }
    if (ch === '"') { inQuotes = true; current += ch; continue; }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) { push(current); current = ''; continue; }
    current += ch;
  }
  push(current);
  return out;
}

/** Parse `;name=value;name="value"` parameter tails. */
function parseParams(tail: string): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  // Matches `;key=123`, `;key="text"`, and bare `;key`.
  const re = /;([A-Za-z0-9_-]+)(?:=(?:"((?:[^"\\]|\\.)*)"|([^;]*)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail)) !== null) {
    const [, key, quoted, bare] = m;
    if (quoted !== undefined) params[key] = quoted.replace(/\\(.)/g, '$1');
    else if (bare !== undefined && bare !== '') {
      const n = Number(bare);
      params[key] = Number.isFinite(n) ? n : bare;
    } else params[key] = '';
  }
  return params;
}

/** Parse a `Signature-Input` header value into its labelled signatures. */
export function parseSignatureInput(header: string): ParsedSignature[] {
  return splitDictionary(header).flatMap(({ label, value }) => {
    const close = value.lastIndexOf(')');
    if (!value.startsWith('(') || close === -1) return [];
    const inner = value.slice(1, close);
    const tail = value.slice(close + 1);

    const components: Array<{ name: string; req: boolean }> = [];
    // Each item is a quoted name optionally followed by its own parameters.
    const itemRe = /"((?:[^"\\]|\\.)*)"((?:;[A-Za-z0-9_-]+(?:=(?:"(?:[^"\\]|\\.)*"|[^;\s)]*))?)*)/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(inner)) !== null) {
      components.push({ name: m[1], req: /;req\b/.test(m[2] ?? '') });
    }
    return [{ label, raw: value, components, params: parseParams(tail) }];
  });
}

/** Parse a `Signature` header value into label → base64 signature. */
export function parseSignatureHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { label, value } of splitDictionary(header)) {
    const m = /^:([A-Za-z0-9+/=]*):$/.exec(value.trim());
    if (m) out[label] = m[1];
  }
  return out;
}

// ─── Component canonicalization (RFC 9421 §2.1 / §2.2) ───────────────────────
//
// A deliberate, self-contained re-implementation: `@credda/js` is published to
// consumers who must not need Credda's server code, and it carries no
// dependencies. It is pinned by tests against RFC 9421's own Appendix B.2.6
// ed25519 vector — an external authority, which is a stronger guard than
// agreeing with another copy in this repo.

function fieldValue(headers: VerifyWebBotAuthInput['headers'], name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower) continue;
    const values = Array.isArray(v) ? v : [v];
    return values.map((x) => String(x ?? '').replace(/\r?\n[ \t]+/g, ' ').trim()).join(', ');
  }
  return null;
}

function derivedValue(name: string, method: string, url: URL): string | null {
  switch (name) {
    case '@method':
      return method.toUpperCase();
    case '@authority': {
      const host = url.hostname.toLowerCase();
      if (!url.port) return host;
      const isDefault =
        (url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80');
      return isDefault ? host : `${host}:${url.port}`;
    }
    case '@target-uri':
      return url.toString();
    case '@path':
      return url.pathname === '' ? '/' : url.pathname;
    case '@query':
      return url.search === '' ? '?' : url.search;
    default:
      return null;
  }
}

/**
 * Rebuild the RFC 9421 signature base for a received request.
 *
 * The `@signature-params` line uses the signature's OWN received serialization
 * (`sig.raw`), never a re-serialization — parameter order is whatever the
 * signer chose, and re-serializing would silently break on a signer that
 * ordered them differently.
 */
export function rebuildSignatureBase(
  sig: ParsedSignature,
  input: Pick<VerifyWebBotAuthInput, 'method' | 'url' | 'headers'>,
): string | null {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return null;
  }

  const lines: string[] = [];
  for (const c of sig.components) {
    // `;req` is only meaningful on a response signature; a request signature
    // carrying it is malformed, and guessing is not an option.
    if (c.req) return null;
    const value = c.name.startsWith('@')
      ? derivedValue(c.name, input.method, url)
      : fieldValue(input.headers, c.name);
    if (value === null) return null;
    lines.push(`"${c.name}": ${value}`);
  }
  lines.push(`"@signature-params": ${sig.raw}`);
  return lines.join('\n');
}

// ─── Ed25519 verification ────────────────────────────────────────────────────

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8Bytes(s: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(s);
  const out = new Uint8Array(new ArrayBuffer(encoded.length));
  out.set(encoded);
  return out;
}

async function ed25519Verify(
  jwk: WebBotAuthJwk,
  signature: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle) throw new Error('WebCrypto is not available in this environment');

  // Older Node exposed the curve as 'NODE-ED25519'; modern runtimes use 'Ed25519'.
  for (const algorithm of ['Ed25519', 'NODE-ED25519']) {
    try {
      const key = await subtle.importKey(
        'jwk',
        { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
        { name: algorithm } as AlgorithmIdentifier,
        false,
        ['verify'],
      );
      return await subtle.verify({ name: algorithm } as AlgorithmIdentifier, key, signature, data);
    } catch {
      /* try the next algorithm name */
    }
  }
  throw new Error('WebCrypto Ed25519 is not supported in this environment');
}

/**
 * Verify the Web Bot Auth signature on a received request. Returns a result
 * object rather than throwing, so a handler can branch cleanly.
 *
 * This does NOT verify the webhook payload — use `verifyWebhookSignature` /
 * `constructWebhookEvent` for that. Run both.
 */
export async function verifyWebBotAuthSignature(
  input: VerifyWebBotAuthInput,
): Promise<WebBotAuthVerification> {
  const signatureInput = fieldValue(input.headers, 'signature-input');
  const signatureHeader = fieldValue(input.headers, 'signature');
  if (!signatureInput) return { valid: false, reason: 'missing Signature-Input header' };
  if (!signatureHeader) return { valid: false, reason: 'missing Signature header' };

  const signatures = parseSignatureInput(signatureInput);
  const rawSignatures = parseSignatureHeader(signatureHeader);

  // Only a signature tagged `web-bot-auth` is a bot-identity assertion; any
  // other tag is a different profile and must not be accepted as one.
  const sig = signatures.find((s) => s.params.tag === 'web-bot-auth');
  if (!sig) return { valid: false, reason: 'no signature tagged web-bot-auth' };

  const provided = rawSignatures[sig.label];
  if (!provided) return { valid: false, reason: `no Signature member for label ${sig.label}` };

  if (sig.params.alg !== undefined && sig.params.alg !== 'ed25519') {
    return { valid: false, reason: `unsupported algorithm ${String(sig.params.alg)}` };
  }

  const agentRaw = fieldValue(input.headers, 'signature-agent');
  const agent = agentRaw ? agentRaw.replace(/^"|"$/g, '') : undefined;
  if (input.expectedAgent !== undefined) {
    if (agent !== input.expectedAgent) {
      return { valid: false, reason: `Signature-Agent mismatch (expected ${input.expectedAgent})` };
    }
    // A Signature-Agent that is present but NOT covered is worthless — an
    // attacker could swap it freely. The drafts require it be signed.
    if (!sig.components.some((c) => c.name.toLowerCase() === 'signature-agent')) {
      return { valid: false, reason: 'Signature-Agent is not a covered component' };
    }
  }

  if (input.checkExpiry !== false) {
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    const tolerance = input.toleranceSeconds ?? 300;
    const created = typeof sig.params.created === 'number' ? sig.params.created : undefined;
    const expires = typeof sig.params.expires === 'number' ? sig.params.expires : undefined;
    if (created !== undefined && now + tolerance < created) {
      return { valid: false, reason: 'signature created in the future' };
    }
    if (expires !== undefined && now - tolerance > expires) {
      return { valid: false, reason: 'signature expired (possible replay)' };
    }
  }

  const keyId = typeof sig.params.keyid === 'string' ? sig.params.keyid : undefined;
  if (!keyId) return { valid: false, reason: 'missing keyid parameter' };
  const jwk = input.directory.keys?.find((k) => k.kid === keyId);
  if (!jwk) return { valid: false, reason: `keyid ${keyId} is not in the supplied directory` };
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
    return { valid: false, reason: 'directory key is not an Ed25519 OKP key' };
  }

  const base = rebuildSignatureBase(sig, input);
  if (base === null) return { valid: false, reason: 'could not reconstruct the signature base' };

  try {
    const ok = await ed25519Verify(jwk, b64ToBytes(provided), utf8Bytes(base));
    return ok ? { valid: true, keyId, agent } : { valid: false, reason: 'signature mismatch', keyId, agent };
  } catch (err) {
    return { valid: false, reason: `credda: ${(err as Error).message}`, keyId, agent };
  }
}
