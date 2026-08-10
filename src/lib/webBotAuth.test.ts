/**
 * Web Bot Auth verifier tests.
 *
 * The canonicalization is pinned against RFC 9421's own Appendix B.2.6 ed25519
 * test vector. That is an EXTERNAL authority: agreeing with another copy of the
 * logic in this repo would only prove the two copies drifted together.
 */

import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  verifyWebBotAuthSignature,
  parseSignatureInput,
  parseSignatureHeader,
  rebuildSignatureBase,
  type WebBotAuthDirectory,
} from './webBotAuth.js';

if (!globalThis.crypto) (globalThis as { crypto?: Crypto }).crypto = webcrypto as unknown as Crypto;

// ── RFC 9421 Appendix B.1.4 test key, as a JWK (Appendix B.1.4 prints both) ──
const RFC_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  kid: 'test-key-ed25519',
  x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs',
};

const B26_INPUT =
  'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"';
const B26_SIGNATURE =
  'sig-b26=:wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==:';

describe('structured-field parsing', () => {
  it('parses the RFC B.2.6 Signature-Input into components + params', () => {
    const [sig] = parseSignatureInput(B26_INPUT);
    expect(sig.label).toBe('sig-b26');
    expect(sig.components.map((c) => c.name)).toEqual([
      'date', '@method', '@path', '@authority', 'content-type', 'content-length',
    ]);
    expect(sig.params.created).toBe(1618884473);
    expect(sig.params.keyid).toBe('test-key-ed25519');
  });

  it('parses a Signature byte-sequence member', () => {
    expect(parseSignatureHeader(B26_SIGNATURE)['sig-b26']).toMatch(/^wqcAqbmY.*Cw==$/);
  });

  it('does not split on commas inside quoted strings', () => {
    const parsed = parseSignatureInput('a=("@authority");nonce="x,y";tag="web-bot-auth"');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].params.nonce).toBe('x,y');
  });

  it('parses two labelled signatures in one header', () => {
    const parsed = parseSignatureInput('a=("@authority");created=1, b=("@method");created=2');
    expect(parsed.map((p) => p.label)).toEqual(['a', 'b']);
  });

  it('recognizes the ;req component parameter', () => {
    const [sig] = parseSignatureInput('a=("@authority";req);created=1');
    expect(sig.components[0]).toEqual({ name: '@authority', req: true });
  });
});

describe('signature base reconstruction: RFC 9421 B.2.6 vector', () => {
  it('rebuilds the RFC signature base byte for byte', () => {
    const [sig] = parseSignatureInput(B26_INPUT);
    const base = rebuildSignatureBase(sig, {
      method: 'POST',
      url: 'https://example.com/foo?param=Value&Pet=dog',
      headers: {
        Host: 'example.com',
        Date: 'Tue, 20 Apr 2021 02:07:55 GMT',
        'Content-Type': 'application/json',
        'Content-Length': '18',
      },
    });
    expect(base).toBe(
      [
        '"date": Tue, 20 Apr 2021 02:07:55 GMT',
        '"@method": POST',
        '"@path": /foo',
        '"@authority": example.com',
        '"content-type": application/json',
        '"content-length": 18',
        `"@signature-params": ${B26_INPUT.slice('sig-b26='.length)}`,
      ].join('\n'),
    );
  });
});

// ── A realistic Credda delivery, signed with the RFC key so the vector's
//    canonicalization and this SDK's verification meet end to end. ───────────
const DELIVERY_URL = 'https://hooks.example.com/credda';
const AGENT = 'https://api.credda.io';

async function signDelivery(overrides: { created?: number; expires?: number; tag?: string } = {}) {
  const created = overrides.created ?? 1_760_000_000;
  const expires = overrides.expires ?? created + 60;
  const tag = overrides.tag ?? 'web-bot-auth';
  const params =
    `("@authority" "@target-uri" "signature-agent");created=${created};expires=${expires}` +
    `;keyid="test-key-ed25519";alg="ed25519";nonce="abc";tag="${tag}"`;
  const base = [
    '"@authority": hooks.example.com',
    `"@target-uri": ${DELIVERY_URL}`,
    `"signature-agent": "${AGENT}"`,
    `"@signature-params": ${params}`,
  ].join('\n');

  const key = await webcrypto.subtle.importKey(
    'jwk',
    {
      kty: 'OKP',
      crv: 'Ed25519',
      x: RFC_JWK.x,
      d: 'n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU',
    },
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const sig = await webcrypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(base));
  return {
    'Signature-Agent': `"${AGENT}"`,
    'Signature-Input': `sig1=${params}`,
    Signature: `sig1=:${Buffer.from(sig).toString('base64')}:`,
  };
}

const DIRECTORY: WebBotAuthDirectory = { keys: [RFC_JWK] };

describe('verifyWebBotAuthSignature', () => {
  const base = { method: 'POST', url: DELIVERY_URL, directory: DIRECTORY, nowSeconds: 1_760_000_010 };

  it('verifies a well-formed signed delivery', async () => {
    const r = await verifyWebBotAuthSignature({ ...base, headers: await signDelivery(), expectedAgent: AGENT });
    expect(r).toMatchObject({ valid: true, keyId: 'test-key-ed25519', agent: AGENT });
  });

  it('rejects a delivery replayed to a different path', async () => {
    const r = await verifyWebBotAuthSignature({
      ...base,
      url: 'https://hooks.example.com/somewhere-else',
      headers: await signDelivery(),
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('signature mismatch');
  });

  it('rejects a tampered Signature-Agent', async () => {
    const headers = await signDelivery();
    headers['Signature-Agent'] = '"https://evil.example"';
    const r = await verifyWebBotAuthSignature({ ...base, headers });
    expect(r.valid).toBe(false);
  });

  it('rejects an expired signature', async () => {
    const r = await verifyWebBotAuthSignature({
      ...base,
      headers: await signDelivery(),
      nowSeconds: 1_760_000_000 + 60 + 301,
    });
    expect(r.reason).toMatch(/expired/);
  });

  it('rejects a keyid absent from the supplied directory', async () => {
    const r = await verifyWebBotAuthSignature({ ...base, headers: await signDelivery(), directory: { keys: [] } });
    expect(r.reason).toMatch(/not in the supplied directory/);
  });

  it('refuses a signature that is not tagged web-bot-auth', async () => {
    const r = await verifyWebBotAuthSignature({
      ...base,
      headers: await signDelivery({ tag: 'http-message-signatures-directory' }),
    });
    expect(r.reason).toBe('no signature tagged web-bot-auth');
  });

  it('rejects an agent mismatch when expectedAgent is set', async () => {
    const r = await verifyWebBotAuthSignature({
      ...base,
      headers: await signDelivery(),
      expectedAgent: 'https://not-credda.example',
    });
    expect(r.reason).toMatch(/Signature-Agent mismatch/);
  });

  it('reports missing headers rather than throwing', async () => {
    expect((await verifyWebBotAuthSignature({ ...base, headers: {} })).reason).toBe('missing Signature-Input header');
  });
});
