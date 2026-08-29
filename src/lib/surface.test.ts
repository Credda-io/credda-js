import { describe, expect, it } from 'vitest';
import { CreddaClient } from './client.js';
import * as headless from '../headless.js';

/**
 * A guard on the shape of the package rather than on any one call.
 *
 * `@credda/js` 0.x was a client for a reliability-score API, and this repository
 * is the source mirror for a published name that still means that to anyone who
 * has not read the changelog. These tests fail if a trust-era method or export
 * comes back, and if a method appears that no route in
 * `apps/api/src/routes/` serves.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS TEST CANNOT DO, STATED SO IT IS NOT MISREAD
 * ---------------------------------------------------------------------------
 * ROUTES below is TRANSCRIBED. It is not derived from the engine, and nothing
 * here reads `apps/api/src/openapi.ts`, so this suite CANNOT notice a route the
 * engine gained. It only notices a method this package gained or lost. That is
 * exactly how `POST /api/investigations/{id}/cancel` shipped in `core` on
 * 2026-08-29 and left this file green at 102 tests with the client blind to it.
 *
 * Deriving it was considered and is not available from here. `core` is a
 * separate repository and is not a dependency of this one — `package.json` has
 * no `@credda/*` — and its `ROUTES` table lives in a TypeScript module that
 * imports `@credda/shared`, `@credda/db` and `@credda/memory`, so it cannot be
 * imported, and it is not published anywhere this package could fetch. Reading
 * it off a sibling checkout would pass on the machine it was written on and
 * fail in CI, which is worse than a table that is honest about being a table.
 * Fetching a running engine's `/openapi.json` puts a network call in a unit
 * suite. `credda-backend/src/public/endpoints.ts` faced the same wall and made
 * the same choice: a hand-kept table that names its source file and the date it
 * was read.
 *
 * So this file does the two things that ARE available. It records every route
 * the engine mounts — including the one no method maps to — rather than only
 * the ones this client implements, so a missing method is visible by reading
 * the table instead of by counting. And it pins the total, so the day someone
 * refreshes ROUTES against `core` the count moves with it.
 *
 * The real fix is a fixture generated from the engine's routes and loaded by
 * this suite and by `credda-go`'s `parity_test.go`, which holds the same kind
 * of table for the same reason. That is a cross-repository change and is not
 * faked here with an assertion nobody checks.
 */

/**
 * Every route `core` mounts, read from `apps/api/src/app.ts` and each module in
 * `apps/api/src/routes/`, against `core` at 3cf196a.
 *
 * `client` is the method on {@link CreddaClient} that serves it, or `null` for a
 * route this package deliberately does not wrap.
 */
const VERIFIED_AGAINST_CORE = '2026-08-29';

const ROUTES: ReadonlyArray<{
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly source: string;
  readonly client: string | null;
}> = [
  { method: 'GET', path: '/livez', source: 'app.ts', client: 'isLive' },
  {
    method: 'GET',
    path: '/openapi.json',
    source: 'app.ts',
    /*
     * The one route with no method, and on purpose. It serves the document that
     * DESCRIBES this API; what a TypeScript caller wants out of that document
     * is the types, and this package already ships them. A method returning it
     * could only be typed `unknown`, which is a worse answer than the one the
     * `types.ts` module already gives.
     */
    client: null,
  },
  { method: 'GET', path: '/api/health', source: 'routes/health.ts', client: 'getHealth' },
  { method: 'GET', path: '/api/metrics', source: 'routes/metrics.ts', client: 'getMetrics' },

  { method: 'GET', path: '/api/investigations', source: 'routes/investigations.ts', client: 'listInvestigations' },
  { method: 'POST', path: '/api/investigations', source: 'routes/investigations.ts', client: 'createInvestigation' },
  { method: 'POST', path: '/api/investigations/:id/cancel', source: 'routes/investigations.ts', client: 'cancelInvestigation' },
  { method: 'GET', path: '/api/investigations/:id', source: 'routes/investigations.ts', client: 'getInvestigation' },
  { method: 'GET', path: '/api/investigations/:id/events', source: 'routes/investigations.ts', client: 'listInvestigationEvents' },
  { method: 'GET', path: '/api/investigations/:id/evidence', source: 'routes/investigations.ts', client: 'listInvestigationEvidence' },
  { method: 'GET', path: '/api/investigations/:id/stream', source: 'routes/investigations.ts', client: 'streamInvestigation' },

  { method: 'GET', path: '/api/repositories', source: 'routes/repositories.ts', client: 'listRepositories' },
  { method: 'GET', path: '/api/repositories/:id', source: 'routes/repositories.ts', client: 'getRepository' },
  { method: 'GET', path: '/api/repositories/:id/learnings', source: 'routes/repositories.ts', client: 'listLearnings' },

  { method: 'GET', path: '/api/resolutions', source: 'routes/resolutions.ts', client: 'listResolutions' },
  { method: 'GET', path: '/api/resolutions/latest', source: 'routes/resolutions.ts', client: 'latestResolution' },
  { method: 'GET', path: '/api/resolutions/:id', source: 'routes/resolutions.ts', client: 'getResolution' },

  { method: 'GET', path: '/api/validations', source: 'routes/validations.ts', client: 'listValidations' },
  { method: 'GET', path: '/api/validations/:id', source: 'routes/validations.ts', client: 'getValidation' },
  { method: 'GET', path: '/api/validations/:id/checks', source: 'routes/validations.ts', client: 'listValidationChecks' },
  { method: 'GET', path: '/api/validations/:id/findings', source: 'routes/validations.ts', client: 'listFindings' },
  { method: 'GET', path: '/api/validations/:id/evidence', source: 'routes/validations.ts', client: 'listValidationEvidence' },
  { method: 'GET', path: '/api/validations/:id/events', source: 'routes/validations.ts', client: 'listValidationEvents' },
  { method: 'GET', path: '/api/validations/:id/stream', source: 'routes/validations.ts', client: 'streamValidation' },

  { method: 'GET', path: '/api/organization', source: 'routes/organization.ts', client: 'getOrganization' },
  { method: 'GET', path: '/api/organization/members', source: 'routes/organization.ts', client: 'listMembers' },
  { method: 'GET', path: '/api/organization/keys', source: 'routes/organization.ts', client: 'listApiKeys' },
];

const ROUTED_METHODS = ROUTES.map((r) => r.client)
  .filter((name): name is string => name !== null)
  .sort();

describe('the client surface', () => {
  /*
   * 27 = 25 routes across the seven modules mounted in `app.ts`, plus `/livez`
   * and `/openapi.json`, which are mounted on the app itself and sit outside
   * the auth gate. A refresh of ROUTES that changes this number is the point:
   * the count is what makes the table's staleness a diff rather than a silence.
   */
  it('accounts for all 27 routes the engine mounts', () => {
    expect(ROUTES).toHaveLength(27);
    expect(VERIFIED_AGAINST_CORE).toBe('2026-08-29');
    // Exactly one route is deliberately unwrapped; see its entry for why.
    expect(ROUTES.filter((r) => r.client === null).map((r) => r.path)).toEqual(['/openapi.json']);
    // A method may not serve two routes.
    expect(new Set(ROUTED_METHODS).size).toBe(ROUTED_METHODS.length);
  });

  it('is exactly one method per route, and no method without one', () => {
    const methods = Object.getOwnPropertyNames(CreddaClient.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
    expect(methods).toEqual(ROUTED_METHODS);
  });

  it('carries nothing from the retired trust surface', () => {
    const retired = [
      'getScore',
      'resolveToken',
      'getExplain',
      'getEarnings',
      'createShareToken',
      'raiseDispute',
      'verifyTrustCredential',
      'verifyWebhookSignature',
      'verifyTrustExport',
      'verifyWebBotAuthSignature',
    ];
    const exported = Object.keys(headless);
    for (const name of retired) {
      expect(Object.getOwnPropertyNames(CreddaClient.prototype)).not.toContain(name);
      expect(exported).not.toContain(name);
    }
  });

  it('exports the client, the error taxonomy and the SSE reader from the headless entry', () => {
    expect(typeof headless.CreddaClient).toBe('function');
    expect(typeof headless.CreddaError).toBe('function');
    expect(typeof headless.SseDecoder).toBe('function');
    expect(typeof headless.streamSse).toBe('function');
    expect(typeof headless.Transport).toBe('function');
    expect(typeof headless.queryString).toBe('function');
    expect(typeof headless.isRetryableStatus).toBe('function');
  });

  it('keeps React out of the headless entry', () => {
    // The whole point of the second entry point: a Node service that installs
    // no React must not fail on `Cannot find package 'react'`.
    expect(Object.keys(headless)).not.toContain('CreddaProvider');
    expect(Object.keys(headless)).not.toContain('useInvestigation');
  });
});
