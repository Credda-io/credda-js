# Changelog

## 1.0.0 — unreleased

### ⚠️ This release redefines the package. Read this before upgrading.

`@credda/js` versions `0.1.0` through `0.8.0` were a client for a **reliability-score
API**: a 0–100 score for a person or business, share tokens, verifiable
credentials, disputes, earnings, webhook verification.

Credda no longer builds that product. Credda now finds the bugs and security
vulnerabilities in a company's production and QA environments, reproduces the
failure, diagnoses the cause, writes the patch, proves it with a test that fails
before and passes after, and opens a pull request. It proposes and never merges.

`1.0.0` is a client for that engine. **It shares no API surface with `0.8.0`.**
This is not a rename, a deprecation cycle or a migration: the old methods do not
exist, there is no shim, and nothing that compiled against `0.x` compiles
against `1.0.0`.

**If you use the trust client, pin `@credda/js@0.8.0`.** It stays on the
registry. It receives no further releases.

```json
{ "dependencies": { "@credda/js": "0.8.0" } }
```

There is no migration path, because there is nothing to migrate to: a
reliability score and a reproduced defect are not the same object with a
different name. If `0.8.0` no longer serves you, the honest answer is that the
API it spoke to is not Credda's product any more.

### Removed

Everything below is gone, with no replacement:

- `CreddaClient`'s entire trust surface — `resolveToken`, `getScore`,
  `getExplain`, `getScoreHistory`, `getEarnings`, `createShareToken`,
  `raiseDispute`, monitors, screening, ingest, imports, confirmations,
  references, policies, activations, qualifications, professional records,
  reliability reports, benchmarks, plans, the sandbox routes, and the rest.
- The hooks `useScore` and `useTrustToken`.
- Offline credential verification: `verifyTrustCredential`,
  `verifyVerifiableCredential`, `isCredentialRevoked` (`src/lib/credential.ts`).
- Portable trust export verification: `verifyTrustExport`.
- Webhook verification: `verifyWebhookSignature`, `constructWebhookEvent`, and
  every `*Event` type. The engine API has no webhook delivery.
- Web Bot Auth (RFC 9421) verification: `verifyWebBotAuthSignature`.
- All ~200 trust-domain types exported from `lib/client.ts`.

`test/` for all of the above went with it, and was replaced rather than deleted:
the suite is 93 tests over the new surface.

### Added

A typed client over the Credda engine API — one method per route in
`apps/api/src/routes/`, and no method without one:

- **Investigations**: `listInvestigations`, `createInvestigation`,
  `getInvestigation`, `listInvestigationEvents`, `listInvestigationEvidence`,
  `streamInvestigation`.
- **Validations**: `listValidations`, `getValidation`, `listValidationChecks`,
  `listFindings`, `listValidationEvidence`, `listValidationEvents`,
  `streamValidation`.
- **Resolutions**: `listResolutions`, `latestResolution`, `getResolution`.
- **Repositories and memory**: `listRepositories`, `listLearnings`.
- **Workspace**: `getOrganization`, `listMembers`, `listApiKeys`.
- **Operations**: `getHealth`, `isLive`, `getMetrics`.

React hooks, retargeted to the same surface: `useInvestigations`,
`useInvestigation`, `useInvestigationEvents`, `useResolution`, `useValidation`,
`useValidationEvents`.

An SSE reader (`streamSse`, `SseDecoder`) built on `fetch` rather than
`EventSource`, because every `/api` route requires an `Authorization` header and
`EventSource` cannot set one.

Wire types for the whole surface, transcribed field for field from the API's own
serializers, with the vocabularies (`InvestigationState`, `ValidationOutcome`,
`CheckStatus`, `ResolutionConfidenceClass`, …) as string unions.

### Changed

- **`baseUrl` is required and there is no default.** `0.x` defaulted to
  `https://api.credda.io`. Credda runs against your own deployment, and a
  built-in hostname would send your bearer key to a host nobody named.
- **One credential model, not two.** `0.x` had a public path (share tokens, safe
  in a browser) and a platform path. The engine API has no public route: one
  bearer key, scoped to an organisation rather than a person, that reads
  everything the organisation holds.
- **The error body changed.** The engine answers `{ error: { code, message } }`.
  `CreddaError` keeps `status`, `path`, `code`, `requestId` and `retryAfterMs`;
  `details` is gone, because nothing in this API sends it.
- **`429` is retryable, and `Retry-After` is honoured.** Both were dropped
  earlier in this unreleased cycle on the reasoning that nothing in `apps/api`
  rate limits. That is true of the engine and it never settled the question,
  because the retry list already held the counter-example: the engine does not
  answer 502 or 504 either, and both stayed. All three come from the hop between
  the caller and the engine — Credda runs against a customer's own deployment,
  behind the customer's own ingress, and that hop is the thing that rate limits.
  The Go client has listed 429/502/503/504 and read `Retry-After` since its own
  rewrite, so the two clients were answering the same wire differently for no
  reason either repository stated. `Retry-After` takes precedence over the
  exponential curve and is capped by `maxRetryDelayMs` like any other wait.
- `package.json` `exports` now list `types` first in each condition block.

### Kept

The transport, because none of it was ever about reliability scores: the typed
fetch, the opt-in retry policy with capped exponential backoff, the error
taxonomy, and the two entry points (`@credda/js` and `@credda/js/headless`) with
React as an optional peer dependency.

### Not in this release, and why

Neither of these is a principle. Both are statuses with a date, and both move
when the API does:

- **No pull-request method.** No route serves one. Opening a pull request needs
  repository write permissions today's install does not request.
- **`patches`, `verifications` and `resolution.fix` are typed and served, and
  empty on every run so far.** The patch path is gated on a model-backed
  provider being configured (ADR 0018, condition 1). As of August 2026 no such
  run exists, so `fix` is `null` and the gap is named in
  `confidence.notEstablished` rather than filled in.

---

## 0.8.0 and earlier

The reliability-score client. See the [0.8.0 tree](https://github.com/Credda-io/credda-js/tree/v0.8.0)
for its source and README. No further releases.
