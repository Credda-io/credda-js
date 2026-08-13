/**
 * A credential is only Credda's if Credda issued it.
 *
 * did:web resolution proves a credential was signed by whoever controls the
 * DID's host. It does not prove that host is Credda. Before this default,
 * `verifyVerifiableCredential(jwt)` with no options returned
 * `{ valid: true, issuer: 'did:web:evil.example' }` for a credential minted by
 * anyone with a domain, and a caller reading `.valid` accepted fabricated facts.
 *
 * The compact verifier in the same module always defaulted its issuer. These
 * pin that the VC path now agrees with it, and that federation stays reachable
 * on purpose rather than by omission.
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { verifyVerifiableCredential } from './credential.js';

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');

async function mintForeignVc(did = 'did:web:evil.example') {
  const { publicKey, privateKey } = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKeyJwk = (await webcrypto.subtle.exportKey('jwk', publicKey)) as { kty: string; crv: string; x: string };
  const header = { alg: 'EdDSA', kid: `${did}#k1` };
  const payload = {
    iss: did,
    sub: 'urn:credda:token:whatever',
    exp: Math.floor(Date.now() / 1000) + 3600,
    vc: { credentialSubject: { score: 100, band: 'Excellent' } },
  };
  const input = `${b64u(Buffer.from(JSON.stringify(header)))}.${b64u(Buffer.from(JSON.stringify(payload)))}`;
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, privateKey, Buffer.from(input)));
  return {
    jwt: `${input}.${b64u(sig)}`,
    // The attacker serves their own DID document; injected so the test needs no network.
    didDocument: { id: did, verificationMethod: [{ id: `${did}#k1`, publicKeyJwk }] },
  };
}

describe('verifyVerifiableCredential issuer default', () => {
  it('refuses a validly signed credential from an issuer that is not Credda', async () => {
    const { jwt, didDocument } = await mintForeignVc();
    await expect(verifyVerifiableCredential(jwt, { didDocument, checkRevocation: false })).rejects.toThrow(
      /issuer mismatch/,
    );
  });

  it('names both issuers and the way out, so the error is actionable', async () => {
    const { jwt, didDocument } = await mintForeignVc();
    await expect(verifyVerifiableCredential(jwt, { didDocument, checkRevocation: false })).rejects.toThrow(
      /expected did:web:api\.credda\.io, got did:web:evil\.example[\s\S]*issuer: null/,
    );
  });

  it('accepts a federated issuer only when the caller asks for it explicitly', async () => {
    const { jwt, didDocument } = await mintForeignVc();
    const res = await verifyVerifiableCredential(jwt, { didDocument, checkRevocation: false, issuer: null });
    expect(res.valid).toBe(true);
    expect(res.issuer).toBe('did:web:evil.example');
  });

  it('expects the issuer of the base this client talks to, not hardcoded production', async () => {
    const { jwt, didDocument } = await mintForeignVc('did:web:staging-api.credda.io');
    const res = await verifyVerifiableCredential(jwt, {
      didDocument,
      checkRevocation: false,
      apiBase: 'https://staging-api.credda.io',
    });
    expect(res.valid).toBe(true);
    expect(res.issuer).toBe('did:web:staging-api.credda.io');
  });

  it('still refuses a foreign issuer when a non-default base is in use', async () => {
    const { jwt, didDocument } = await mintForeignVc();
    await expect(
      verifyVerifiableCredential(jwt, { didDocument, checkRevocation: false, apiBase: 'https://staging-api.credda.io' }),
    ).rejects.toThrow(/issuer mismatch/);
  });
});
