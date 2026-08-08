> Source mirror for [`@credda/js`](https://www.npmjs.com/package/@credda/js). Install from npm: `npm install @credda/js`. This repo provides the source and issue tracker; canonical development happens in Credda internal tooling.

# @credda/js

Client SDK for the Credda reliability-score API. React hooks + a headless
client, fully typed against the live API.

```bash
npm install @credda/js
```

## Two entry points

The package has two entry points, and picking the wrong one is the most common
first-run failure.

| Import | Contains | Needs React |
| --- | --- | --- |
| `@credda/js/headless` | `CreddaClient`, offline credential + webhook verification | no |
| `@credda/js` | everything above, plus `CreddaProvider`, `useScore`, `useTrustToken` | **yes** |

React is an *optional* peer dependency, so a plain `npm install @credda/js` in a
Node service installs no React. Import the root entry there and it fails with
`Cannot find package 'react'`. On a server, import `@credda/js/headless`.

```ts
// Node / any server runtime — no React required
import { CreddaClient } from '@credda/js/headless';

const credda = new CreddaClient({ apiBase: 'https://api.credda.io' });
const trust = await credda.resolveToken('crd_share_…'); // public, no API key
console.log(trust.finalScore, trust.scoreBand);
```

## Two access models

| Model        | Method / hook                     | Auth              | Where it's safe        |
| ------------ | --------------------------------- | ----------------- | ---------------------- |
| **Public**   | `resolveToken` / `useTrustToken`  | a share token     | browser or server      |
| **Platform** | `getScore` / `useScore`, etc.     | `crd_live_…` key  | **server-side only**   |

> Never ship a platform API key (`crd_live_…`) in a browser bundle. For
> in-browser trust displays, mint a share token server-side and use the public
> path.

> **Test mode:** pass a sandbox key (`crd_test_…`) instead of a live one — no
> other change. Test keys read/write only your platform's isolated test
> universe (scored by the identical formula), test webhooks arrive with
> `livemode: false` on the envelope, and `DELETE /api/v1/test/data` resets it.
> Share tokens/credentials refuse test mode (`TEST_MODE_NOT_ALLOWED`).

## React — public trust badge

```tsx
import { CreddaProvider, useTrustToken } from '@credda/js';

function Badge({ token }: { token: string }) {
  const { data, loading, error } = useTrustToken(token);
  if (loading) return <span>…</span>;
  if (error || !data) return null;
  return <span>{data.finalScore}/100 · {data.scoreBand}</span>;
}

export default function App() {
  return (
    <CreddaProvider apiBase="https://api.credda.io">
      <Badge token="crd_share_…" />
    </CreddaProvider>
  );
}
```

## Headless client (server-side)

```ts
import { CreddaClient } from '@credda/js/headless';

const credda = new CreddaClient({ apiBase: 'https://api.credda.io' });

// Public — no key
const trust = await credda.resolveToken('crd_share_…');

const key = process.env.CREDDA_API_KEY!; // server-side only — never ship to a browser

// Platform reads
const score   = await credda.getScore('user-123', key);
const explain = await credda.getScoreExplain('user-123', key);
const history = await credda.getScoreHistory('user-123', key, { limit: 30 });
const plats   = await credda.getPlatforms('user-123', key);
const risk    = await credda.getRisk('user-123', key);   // advisory, never affects the score
const usage   = await credda.getUsage(key);              // your consumption vs. tier quota

// Platform writes
await credda.reportEvent(
  { userId: 'user-123', eventType: 'CONTRACT_FULFILLED', transactionValue: 500 },
  key,
  { idempotencyKey: 'commitment:abc:fulfilled' },        // stable → exactly-once retries
);
const { token } = await credda.mintShareToken('user-123', key);   // powers badge/verify/export
await credda.revokeShareToken('user-123', key);
await credda.resolveDispute('dispute-1', 'FOR_USER', key);

// Public — no key
const bundle = await credda.getTrustExport('crd_share_…'); // portable, self-verifying export

// Webhook subscriptions
const { secret } = await credda.createWebhook({ url: 'https://hooks.you/credda', events: ['score.band_changed'] }, key);
const { data }   = await credda.listWebhooks(key);
await credda.deleteWebhook('wh-1', key);

// Recent events across ALL your endpoints — sample data for an automation
// platform's field picker. Falls back to catalog examples (`isExample: true`,
// `source: 'examples'`) when nothing has been delivered yet.
const recent = await credda.getRecentWebhookEvents(key, { limit: 25, eventType: 'score.updated' });
```

Every method returns a typed payload matching the API (`ScorePayload`,
`UsagePayload`, `TrustExport`, `CreateWebhookResult`, …). Failed requests throw a
`CreddaError` carrying the HTTP `status` and request `path`. Write methods need a
key with the matching scope (`write` or e.g. `events:write` / `webhooks:write`).

## Automatic retries (opt-in)

```ts
const credda = new CreddaClient({ apiBase: 'https://api.credda.io', retries: 2 });
```

Retries transient failures only (network errors, 429, 502/503/504) with
exponential backoff. Applied to GETs always, and to POSTs **only when the
request carries an `Idempotency-Key`** — a non-idempotent write is never
retried, so enabling this can't double-report an event. Off by default.

## Recipes by use case

Complete walkthroughs (problem → flow → working calls) live at
[api.credda.io/use-cases](https://api.credda.io/use-cases), and the
[quickstart](https://api.credda.io/quickstart) has copy-paste versions of each.
The short version:

```ts
// Marketplace: read the trust record behind a page of listings (one call, ≤100 users)
const { scores } = await credda.getScores(['seller_1', 'seller_2'], key);

// Hiring: candidate hands you a token or an export file — verify offline
const verified = await verifyTrustExport(bundleTheyHandedYou); // throws if forged/revoked

// Contractors: report the outcome (idempotent), then explain the move
await credda.reportEvent({ userId, eventType: 'CONTRACT_FULFILLED', isVerified: true },
  key, { idempotencyKey: `${orderRef}-fulfilled` });
const delta = await credda.getScoreDelta(userId, key); // { scoreDelta, topDriver, ... }

// Automation: react to trust changes without polling
const event = await constructWebhookEvent({ secret, rawBody, signatureHeader, timestampHeader });
```

## Counterparty confirmation (the strongest evidence there is)

`reportEvent` lets you *assert* `isVerified: true`. A **confirmation request** is
the strong form: you propose an outcome, deliver a one-time token to the named
counterparty over **your own** channel, and the event is written — verified —
only when that distinct party confirms.

```ts
// 1. You (keyed). Writes NO event and touches NO score.
const req = await credda.createConfirmationRequest(
  {
    userId: 'worker_7',
    eventType: 'CONTRACT_FULFILLED',
    counterpartyRef: 'client_42',          // your key for them — must not name the subject
    counterpartyName: 'Acme Ltd',
    description: 'Kitchen refit, delivered 19 July',
    returnUrl: 'https://acme.example/thanks',
    expiresInDays: 14,
  },
  key,
  { idempotencyKey: `job-991-confirm` },
);
// req.confirmationToken is shown ONCE. Send req.confirmUrl (Credda's hosted
// page — zero frontend) or build your own UI on req.previewUrl/respondUrl.

// 2. The counterparty — NO API KEY. They hold a token, not a Credda account.
const counterparty = new CreddaClient();
const { confirmation } = await counterparty.previewConfirmation(req.confirmation.id, token);
const result = await counterparty.respondToConfirmation(req.confirmation.id, token, 'confirm');
// result.eventId — the verified ledger event the confirmation earned.
// 'decline' writes NOTHING: a decline is not evidence of a negative outcome.

await credda.listConfirmations(key, { status: 'PENDING' });
await credda.cancelConfirmation(req.confirmation.id, key);   // only while PENDING
```

## Reference requests (verify a résumé claim)

The qualifications-half sibling of confirmations. A self-attested claim
(employment / education / certification / skill) becomes **verified** when the
named third party who was there confirms it via a one-time token. Same
asymmetric auth: create/list/get/cancel are keyed; `previewReference` /
`respondToReference` take **no API key**. A reference never moves the score.

```ts
// 1. You (keyed). Records NO qualification and touches NO score.
const req = await credda.createReferenceRequest(
  {
    userId: 'worker_7',
    category: 'employment',
    label: 'Senior Engineer',
    issuer: 'Acme Ltd',                    // display only — never scored or ranked
    counterpartyRef: 'manager_42',         // your key for the reference — must not name the subject
    counterpartyName: 'Dana Lee',
    returnUrl: 'https://acme.example/thanks',
    expiresInDays: 14,
  },
  key,
  { idempotencyKey: `ref-991` },
);
// req.referenceToken is shown ONCE. Send req.referenceUrl (Credda's hosted page)
// or build your own UI on req.previewUrl/respondUrl.

// 2. The reference — NO API KEY. They hold a token, not a Credda account.
const reference = new CreddaClient();
const { reference: preview } = await reference.previewReference(req.reference.id, token);
const result = await reference.respondToReference(req.reference.id, token, 'confirm');
// result.eventId — the verified qualification event the reference earned.
// 'decline' writes NOTHING: a decline is not evidence against the claim.

await credda.listReferences(key, { status: 'PENDING' });
await credda.cancelReference(req.reference.id, key);         // only while PENDING
```

## Threshold policies

Declarative "tell me when a subject crosses this line" — edge-triggered, delivered
as `policy.threshold_crossed` through your webhooks. Notification config: a policy
never reads into, blocks, or changes a score.

```ts
await credda.createPolicy(
  { name: 'Watch the 60 line', userId: 'worker_7', metric: 'score', direction: 'down', threshold: 60 },
  key,
);
await credda.createPolicy(
  { name: 'Anyone entering High Risk', appliesToAll: true, metric: 'band', direction: 'enter', band: 'High Risk' },
  key,
);
await credda.listPolicies(key);
await credda.updatePolicy('pol_1', { threshold: 55 }, key);   // the metric is immutable
await credda.deletePolicy('pol_1', key);
```

## Professional record + verified profile

Two worker-owned surfaces over the same ledger. Both describe a record; **neither
is a hiring verdict, a background check, or a consumer report**, and neither can
move the Reliability Score.

```ts
// Reliability half — résumé-shaped summary of a VERIFIED work record.
const record = await credda.getProfessionalRecord('worker_7', key);
const cred   = await credda.mintProfessionalRecordCredential('worker_7', key);
// cred.credentialVc verifies offline; cred.linkedin.addToProfileUrl opens
// LinkedIn's certification form (LinkedIn does not import VC claims — its
// "Show credential" link resolves to the public Credda proof).

// Qualifications half — how much of a CLAIMED record is third-party verified.
await credda.recordQualification(
  'worker_7',
  { category: 'certification', label: 'AWS Solutions Architect', issuer: 'AWS', verifiedBy: 'aws-training' },
  key,
);
const profile = await credda.getVerifiedProfile('worker_7', key);
// Omit `verifiedBy` and the claim is still recorded — as self-attested, with a
// `verificationNote` saying why. It counts WHETHER a claim is verified, never
// how prestigious it is: no school, employer or credential is ranked.

// Public, no key — the token is the subject's own consent to present it.
const shown = await new CreddaClient().getPublicProfessionalRecord('crd_share_…');

// Public, no key — the closed set of Open Badges 3.0 achievements Credda signs.
const badges = await new CreddaClient().getOpenBadgeAchievements();

// Career export — the whole verified record as an open JSON Resume document
// (jsonresume.org), so it drops into an ATS/HRIS without a bespoke integration.
const resume = await credda.getCareerExport('worker_7', key);
// Public, no key — behind a share token (the subject's own consent).
const publicResume = await new CreddaClient().getPublicCareerExport('crd_share_…');

// Public, no key — how to map real-world outcomes to Credda events, and WHO
// confirms each. Guidance only; nothing here scores or ranks anyone.
const templates = await new CreddaClient().getOutcomeTemplates('trades');
```

## Verify a credential offline

`GET /api/v1/verify/:token` now returns a **Verifiable Trust Credential** (an
EdDSA-signed JWT) alongside the payload. You can verify it **without trusting a
live Credda call** — once the JWKS is cached, verification is fully local.

```ts
import { CreddaClient, verifyTrustCredential } from '@credda/js/headless';

const credda = new CreddaClient();
const trust = await credda.resolveToken('crd_share_…');

// Method form (uses the client's apiBase for the JWKS):
const v = await credda.verifyCredential(trust.credential!);

// Or standalone:
const v2 = await verifyTrustCredential(trust.credential!, { apiBase: 'https://api.credda.io' });

console.log(v.cred.finalScore, v.cred.scoreBand); // attested, signature-checked
```

Verification uses Web Crypto (Ed25519) — works in Node 20+ and modern browsers.
It throws if the signature, expiry, or issuer is invalid. See the scoring API's
`docs/TRUST_CREDENTIALS.md` for the format and key rotation.

## W3C Verifiable Credentials (Trust Fabric v3)

Request a standards-compliant **W3C VC-JWT** and verify it offline — the issuer's
`did:web` DID document is resolved automatically (JWKS fallback):

```ts
import { CreddaClient, verifyVerifiableCredential } from '@credda/js/headless';

const credda = new CreddaClient();
// GET /api/v1/verify/:token/credential?format=w3c returns { credentialVc, ... }
const v = await credda.verifyVerifiableCredential(vcJwt);
console.log(v.issuer);            // did:web:api.credda.io
console.log(v.cred.scoreBand);    // attested, signature-checked

// Or standalone with a preloaded DID document:
await verifyVerifiableCredential(vcJwt, { didDocument });
```

`verifyVerifiableCredential` also enforces **revocation** (StatusList2021): if the
credential carries a `credentialStatus`, it fetches + signature-verifies the status
list and rejects a revoked credential. Check status directly with `isCredentialRevoked`,
or skip the network with `{ checkRevocation: false }`.

## Portable trust export

Fetch a self-verifying bundle a user owns (current score + history + signed W3C
credential + revocation pointer), then verify it end-to-end offline in one call —
including a tamper check that the plaintext score matches the signed credential:

```ts
import { CreddaClient, verifyTrustExport } from '@credda/js/headless';

const credda = new CreddaClient();
const bundle = await credda.getTrustExport(shareToken);   // GET /verify/:token/export
const { credential } = await verifyTrustExport(bundle);   // throws if invalid/revoked/tampered
console.log(credential.cred.scoreBand);                   // trusted
```

## Receive webhooks

Credda POSTs HMAC-signed trust events (`score.updated`, `score.band_changed`,
`dispute.resolved`). Verify on the **raw** body, before parsing:

```ts
import { constructWebhookEvent } from '@credda/js/headless';

// e.g. app.post('/credda', express.raw({ type: 'application/json' }), async (req, res) => {
const event = await constructWebhookEvent({
  secret: process.env.CREDDA_WEBHOOK_SECRET!,
  rawBody: req.body.toString('utf8'),
  signatureHeader: req.header('X-Credda-Signature'),
  timestampHeader: req.header('X-Credda-Timestamp'),
});
// event is a discriminated union on `type`:
if (event.type === 'dispute.resolved') event.data.disputeId; // typed
else event.data.score;                                       // score events
// res.sendStatus(200) — throws (→ 400) on bad signature / stale timestamp / bad body.
```

`verifyWebhookSignature(...)` is the lower-level form returning `{ valid, reason }`.

## Build

```bash
npm run build      # ES + CJS bundles + .d.ts
npm run typecheck
```

## License

MIT © Credda. See [LICENSE](LICENSE).

---

Part of the Credda SDK family:
[`@credda/js`](https://github.com/Credda-io/credda-js) ·
[`credda-go`](https://github.com/Credda-io/credda-go) ·
[`@credda/cli`](https://github.com/Credda-io/credda-cli) ·
[`@credda/mcp-server`](https://github.com/Credda-io/credda-mcp)
