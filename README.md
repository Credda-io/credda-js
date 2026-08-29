<p align="center">
  <a href="https://credda.io">
    <img alt="Credda" width="96" height="96"
         src="https://raw.githubusercontent.com/Credda-io/credda-js/main/assets/credda-mark-spectrum.png">
  </a>
</p>

> Source mirror for [`@credda/js`](https://www.npmjs.com/package/@credda/js). Install from npm: `npm install @credda/js`. This repo provides the source and issue tracker; canonical development happens in Credda internal tooling.

# @credda/js

> ### ⚠️ 1.0.0 is a different package from 0.8.0
>
> Versions `0.x` of this name were a client for a **reliability-score API**:
> `useScore`, `useTrustToken`, share tokens, verifiable credentials, disputes,
> webhooks. Credda no longer builds that product, and **none of that surface
> exists in 1.0.0**. Nothing was renamed and nothing is deprecated — it is gone.
>
> `1.0.0` is a client for the **Credda engine**, which reproduces defects and
> vulnerabilities you report and proposes fixes for them. Upgrading from `0.x`
> is a rewrite, not a migration, and there is no compatibility layer. If you depend
> on the trust client, **pin `@credda/js@0.8.0`**; see [CHANGELOG.md](CHANGELOG.md).

You label a bug report or a security vulnerability; Credda reproduces the
failure, diagnoses the cause, writes the patch, proves it with a test that fails
before and passes after, and hands back a diff. Whether that diff becomes a
pull request depends on which mechanism delivered it, and the two answer
differently: the **GitHub App** path opens one with no flag and no switch, for a
run that reaches `READY_FOR_REVIEW` with a proven verdict; the **GitHub Action**
opens none unless you set its `open-pull-request` input, which defaults to
`false`. How often a run reaches a proven fix at all has not been measured. It
proposes and never merges.

This package is the typed TypeScript client and React hooks for the engine's
HTTP API — one method per route, and no method without one. The routes it wraps
are documented at [api.credda.io/reference](https://api.credda.io/reference).

```bash
npm install @credda/js
```

> **This installs 0.8.0 today — checked 2026-08-28.** The latest `@credda/js` on
> npm is still **0.8.0**, the retired reliability-score client described in the
> warning above. `1.0.0` — the version this repository contains and this README
> documents — is **not published yet**. A bare `npm install @credda/js` therefore
> gets you the wrong package. Until 1.0.0 ships, read this README as
> documentation of the source in this repository rather than of what npm serves.

## Two entry points

| Import | Contains | Needs React |
| --- | --- | --- |
| `@credda/js/headless` | `CreddaClient`, the wire types, `CreddaError`, the SSE reader | no |
| `@credda/js` | everything above, plus `CreddaProvider` and the hooks | **yes** |

React is an *optional* peer dependency, so `npm install @credda/js` in a Node
service installs no React. Import the root entry there and it fails with
`Cannot find package 'react'`. On a server, import `@credda/js/headless`.

## Getting started

```ts
import { CreddaClient } from '@credda/js/headless';

const credda = new CreddaClient({
  baseUrl: 'https://credda.internal', // your deployment. There is no default.
  apiKey: process.env.CREDDA_API_KEY,
});

const { investigations, total } = await credda.listInvestigations({ state: 'REPRODUCED' });
console.log(`${investigations.length} of ${total}`);
```

There is **no default base URL**. Credda runs against your own deployment, and a
built-in hostname would be this package guessing where your engine lives — a
wrong guess that sends your bearer key there.

### One credential, and it is not a browser credential

Every route under `/api` sits behind one bearer gate. The key identifies an
**organisation, not a person**: `api_keys` has an `org_id` and no `user_id`, and
no scopes column. So there is exactly one kind of key, it reads every
investigation, patch, finding and resolution in the organisation, and there is
no narrower credential to hand to an untrusted page.

There is no public, key-less route on this API. If you are building something a
customer sees, put it behind your own login and inject the key server-side.

`/livez` is the one exception — no credential, and it answers 204 with an empty
body and nothing else.

## What the API serves

Every method below maps to one route in the engine. Almost all of it is read:
the engine is driven by the worker and the CLI, and the only write this API
accepts is opening an investigation.

### Investigations — a reported failure being chased down

| Method | Route |
| --- | --- |
| `listInvestigations({ repository, signalId, state, outcome, limit, offset })` | `GET /api/investigations` |
| `createInvestigation({ repositoryId, issueTitle, issueBody, issueRef? })` | `POST /api/investigations` |
| `getInvestigation(id)` | `GET /api/investigations/:id` |
| `listInvestigationEvents(id, { since, limit, includeDebug })` | `GET /api/investigations/:id/events` |
| `listInvestigationEvidence(id, { type, limit, offset })` | `GET /api/investigations/:id/evidence` |
| `streamInvestigation(id, { since, reconnect })` | `GET /api/investigations/:id/stream` (SSE) |

`createInvestigation` creates the row in state `CREATED` and returns. **It does
not start the run** — the API does not execute anything; the worker does. What
you watch it with is the event stream.

### Validations — a change being checked before it lands

| Method | Route |
| --- | --- |
| `listValidations({ repository, state, outcome, limit, offset })` | `GET /api/validations` |
| `getValidation(id)` | `GET /api/validations/:id` |
| `listValidationChecks(id, { limit, offset })` | `GET /api/validations/:id/checks` |
| `listFindings(id, { severity, status, limit, offset })` | `GET /api/validations/:id/findings` |
| `listValidationEvidence(id, { type, limit, offset })` | `GET /api/validations/:id/evidence` |
| `listValidationEvents(id, { since, limit, includeDebug })` | `GET /api/validations/:id/events` |
| `streamValidation(id, { since, reconnect })` | `GET /api/validations/:id/stream` (SSE) |

Read-only over HTTP. There is no route that starts a validation; they arrive
from a webhook, the CLI or a schedule.

Two fields carry most of the meaning. A check's `baseStatus` is the base-commit
re-run: `FAILED` there means the check passes on the base and fails on the head,
so *this change* caused it — and `null` means the base has not been consulted,
never that it was fine. `environment.status` is the other: a run that ended
`BLOCKED` could not be executed at all, and must not be rendered as a failure of
the change.

### Resolutions — what a run established, and what it did not

| Method | Route |
| --- | --- |
| `listResolutions({ investigation, signalId, confidence, limit, offset })` | `GET /api/resolutions` |
| `latestResolution(investigationId)` | `GET /api/resolutions/latest` |
| `getResolution(id)` | `GET /api/resolutions/:id` |

`confidence.class` and `confidence.notEstablished` are one fact written twice.
Render them together: the class without the gaps is a bare assertion, and it is
the field a reviewer reads to decide whether to trust a fix. There is no number
anywhere on a resolution's confidence, deliberately — no score, no ratio,
nothing for a progress bar to consume.

`latestResolution` returning `{ resolution: null }` means the investigation
exists and has resolved nothing yet. That is an answer, and it is different from
a 404 for an id that does not exist. Render them differently.

### Repositories, memory, workspace and operations

| Method | Route |
| --- | --- |
| `listRepositories({ limit, offset })` | `GET /api/repositories` |
| `getRepository(id)` | `GET /api/repositories/:id` |
| `listLearnings(repositoryId, { kind, limit, offset })` | `GET /api/repositories/:id/learnings` |
| `getOrganization()` | `GET /api/organization` |
| `listMembers({ limit, offset })` | `GET /api/organization/members` |
| `listApiKeys({ limit, offset })` | `GET /api/organization/keys` |
| `getHealth()` | `GET /api/health` (readiness) |
| `isLive()` | `GET /livez` (liveness, unauthenticated) |
| `getMetrics()` | `GET /api/metrics` (Prometheus text) |

`getHealth()` returns the readiness report on a degraded deployment too, where
the server answers **503** with that same body. Branch on `status`, not on
whether the call threw. `getMetrics()` covers the API process only — the
investigation, reproduction and model-usage counters live in the worker, which
is a separate process with its own registry. Scrape both.

`listApiKeys` includes revoked keys, on purpose: "this key was revoked on the
3rd" is the answer an operator came for. There is no create and no revoke,
because the API has neither — keys are minted out of band by the operator today.

## React

```tsx
import { CreddaProvider, useInvestigation, useInvestigationEvents } from '@credda/js';

function Investigation({ id }: { id: string }) {
  const { data, loading } = useInvestigation(id);
  const { events, streaming } = useInvestigationEvents(id);

  if (loading) return <span>…</span>;
  if (!data) return null;

  return (
    <section>
      <h2>{data.investigation.issueTitle}</h2>
      <p>{data.investigation.state}{streaming ? ' · live' : ''}</p>
      <ol>
        {events.map((e) => (
          <li key={e.id}>{e.summary}</li>
        ))}
      </ol>
    </section>
  );
}

export default function App() {
  return (
    <CreddaProvider baseUrl="https://credda.internal" apiKey={key}>
      <Investigation id="inv_…" />
    </CreddaProvider>
  );
}
```

| Hook | What it reads |
| --- | --- |
| `useInvestigations(query)` | a page of investigations, with `total` |
| `useInvestigation(id)` | one investigation and everything hanging off it |
| `useInvestigationEvents(id, opts)` | its live timeline (SSE) |
| `useResolution(investigationId)` | the latest resolution record, or `null` |
| `useValidation(id)` | one validation run |
| `useValidationEvents(id, opts)` | its live timeline (SSE) |

## The event stream is SSE, and is read with `fetch`

The engine serves `text/event-stream`: `id:`/`event:`/`data:` frames, a
`: heartbeat` comment every 15 seconds, `Last-Event-ID` for resumption. It is
not a WebSocket.

This package reads it with `fetch` and a stream reader rather than with the
browser's `EventSource`, because **`EventSource` cannot set a request header**
and every `/api` route requires `Authorization: Bearer`. `EventSource` can only
reach this API on a deployment running `CREDDA_AUTH=disabled`.

Outside React, stream it directly:

```ts
for await (const event of credda.streamInvestigation(id, { since: 0, reconnect: true })) {
  console.log(event.sequence, event.type, event.summary);
}
```

Four behaviours to build around:

- **`debug` events never arrive on a stream.** The server withholds them and
  offers no way to ask. They stay readable with
  `listInvestigationEvents(id, { includeDebug: true })`.
- **A finished run closes its own stream.** When the run reaches a terminal
  state the server sends a `complete` frame carrying that state; the generator
  returns there and does **not** reconnect, because there is nothing left to
  reconnect for. Pass `onComplete` to read the state, or take the return as
  "the run is over". In the hooks it arrives as `completedState`.
- **A stream carrying no event for five minutes is dropped**, with an `idle`
  frame saying so. That is not an error and the run has not finished.
  `reconnect: true` reopens from the last sequence seen (it defaults to
  `true` in the hooks, `false` in the generator).
- **A revoked key ends the stream mid-flight.** The server re-checks the
  credential once a second and sends an `unauthenticated` frame before closing;
  that surfaces as a `CreddaError` with status 401, and it does not reconnect.

## Errors

Every non-2xx becomes a `CreddaError` carrying the API's own `code`, the HTTP
`status`, the request `path`, and the `X-Request-Id` the server echoed — which
is the one thing support asks for.

```ts
import { CreddaError } from '@credda/js/headless';

try {
  await credda.getInvestigation(id);
} catch (err) {
  if (err instanceof CreddaError && err.code === 'NOT_FOUND') { /* … */ }
}
```

Codes the API can send today: `INVALID_REQUEST`, `VALIDATION_FAILED`,
`UNAUTHENTICATED`, `NOT_FOUND`, `NO_ORGANIZATION`, `PAYLOAD_TOO_LARGE`,
`UNAVAILABLE`, `TOO_MANY_STREAMS`, `INTERNAL_ERROR`.

Retries are **opt-in and off by default**: `new CreddaClient({ …, retries: 2 })`
re-attempts network errors and 502/504 on GETs with exponential backoff. `429`
is not on that list because nothing in the API rate limits. `createInvestigation`
is never retried whatever you set — the route defines no idempotency key, so a
repeat would open a second investigation into the same report. `getHealth` is
never retried either: a degraded database does not recover by being asked twice.

## Status of the fix path

Credda's product is the fix: reproduce, diagnose, patch, prove, hand back a
diff. What a user will look for and not find **on this HTTP API** is below,
and it is a status with a date on it rather than a position:

- **No pull-request route, as of 2026-08-28.** Nothing here returns a PR link or
  opens one. The engine can open a pull request -- its GitHub App asks an
  operator for Contents write and Pull requests write, and its delivery path
  uses them for a run that reaches a proven verdict -- but that delivery is not
  surfaced as a route here. When a route appears, a method appears; this package
  will not invent one in the meantime.

  That delivery is **not** opt-in, and this bullet said it was until 2026-08-29.
  `apps/worker/src/handlers/change-proposal-delivery.ts` states in as many words
  that there is no opt-in switch and no flag: the gate is the state and the
  verdict, widened or narrowed only by a code review. The `open-pull-request`
  input that defaults to `false` belongs to the **GitHub Action**, which is a
  different mechanism -- it runs on the caller's own runner and calls
  `gh pr create` -- and describing the two in one sentence is wrong about one of
  them.
- **`patches`, `verifications` and `resolution.fix` are typed and served, and
  are `null` or empty on a run that did not enter the patch stage.** The API
  serializes them on every investigation detail and every resolution record.
  They fill in when the engine runs the patch path, which is gated on a
  model-backed provider being configured. **This bullet said, until 2026-08-28,
  that no such run exists and that the fields are empty on every run made so
  far.** That was measured and true when written; it is not now. A model-backed
  run happened on 2026-08-27, ADR 0019 put the Fixer and the Verifier back on
  the investigation path the same day, and the following day the engine's
  delivery path was wired to open a pull request for a run that reaches a proven
  verdict. That path has no flag; see the bullet above for which mechanism the
  off-by-default input actually belongs to. How often a run reaches a proven fix
  at all has not been measured, and no count is claimed here.

  What did **not** change is the rule that made the old sentence worth writing:
  a stage that did not run is never reported as a measured zero. Against the
  deterministic heuristic provider the fix stage is not entered at all, so
  `fix` is `null` and the gap is named in `confidence.notEstablished` rather
  than papered over. Read `null` as "this run did not establish it", never as
  "there was nothing to establish" -- the distinction this client's pointer
  discipline exists for.


## Requirements

Node 18+ (for `fetch` and `ReadableStream`), or any modern browser. React 18+ if
you use the hooks. TypeScript types ship with the package.

## License

MIT. See [LICENSE](LICENSE).
