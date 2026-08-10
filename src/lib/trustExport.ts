/**
 * Verify a portable trust export end-to-end.
 *
 * A trust export (from `CreddaClient.getTrustExport` or a saved file) bundles a
 * signed W3C credential with convenience plaintext (current score, history). This
 * verifies the credential's signature + expiry + issuer + revocation, and then
 * cross-checks that the plaintext score agrees with the SIGNED credential — so a
 * bundle whose plaintext was edited without a matching re-signed credential is
 * rejected. Offline (WebCrypto); one call to trust a received export.
 */

import { verifyVerifiableCredential, type VerifiedVc, type VerifyVcOptions } from './credential.js';
import type { TrustExport } from './client.js';

export interface VerifiedTrustExport {
  /** The export as provided. */
  export: TrustExport;
  /** The verified facts from the embedded signed credential (authoritative). */
  credential: VerifiedVc;
}

export async function verifyTrustExport(
  bundle: TrustExport,
  opts: VerifyVcOptions = {},
): Promise<VerifiedTrustExport> {
  if (!bundle || bundle.format !== 'credda-trust-export/1') {
    throw new Error('credda: unrecognized trust export format');
  }
  const vcJwt = bundle.credential?.vc;
  if (!vcJwt) throw new Error('credda: trust export has no credential');

  // Signature + expiry + issuer + StatusList2021 revocation (see credential.ts).
  const credential = await verifyVerifiableCredential(vcJwt, opts);

  // Integrity: the signed credential is authoritative. If the bundle's plaintext
  // score band disagrees with it, the convenience fields were tampered with.
  const signedBand = (credential.cred as { scoreBand?: string }).scoreBand;
  if (signedBand != null && bundle.score?.scoreBand !== signedBand) {
    throw new Error('credda: export score does not match the signed credential (tampered?)');
  }

  return { export: bundle, credential };
}
