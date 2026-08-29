import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CreddaClient } from './client.js';
import * as headless from '../headless.js';
import surface from './route-surface.json' with { type: 'json' };

/**
 * A guard on the shape of the package rather than on any one call.
 *
 * `@credda/js` 0.x was a client for a reliability-score API, and this repository
 * is the source mirror for a published name that still means that to anyone who
 * has not read the changelog. These tests fail if a trust-era method or export
 * comes back, and if a method appears that no route in the engine serves.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE ROUTE LIST COMES FROM
 * ---------------------------------------------------------------------------
 * `route-surface.json`, generated in `core` by `scripts/generate-route-surface.ts`
 * out of `apps/api/src/openapi.ts` and copied here. It is NOT edited by hand.
 *
 * This file used to transcribe the routes, and could not notice one the engine
 * gained: that is how `POST /api/investigations/{id}/cancel` shipped in `core`
 * and left this suite green at 102 tests with no `cancelInvestigation`. Now the
 * routes arrive from the engine and only the mapping below -- which method
 * serves which route -- is ours. A route the copy gains with no entry in
 * CLIENT_METHODS fails here by path, and a mapped method the class does not
 * have fails by name.
 *
 * Two staleness guards, because a copy that quietly rots is the same defect:
 *
 *   - Integrity, here: the digest stamped in the file is recomputed over its
 *     own routes below, so a copy edited by hand to make this suite pass fails
 *     instead.
 *   - Propagation, in `core`: `route-surface.consumers.json` records the digest
 *     this repository was last given, and `core`'s own suite fails -- in CI,
 *     naming `credda-js` -- when the engine's surface moves past it. Refreshing
 *     is: copy the file in, update the ledger there.
 *
 * `core` is private, is not a dependency of this package, and its route table
 * imports `@credda/shared`, `@credda/db` and `@credda/memory`, so importing it,
 * reading a sibling checkout (passes locally, fails in CI) or fetching a live
 * `/openapi.json` (a network call in a unit suite) were all rejected. A copy
 * with a digest and a ledger is what is actually available.
 */

/**
 * The one hand-written half: `"METHOD /path"` from the engine's surface to the
 * method on {@link CreddaClient} that serves it, or `null` for a route this
 * package deliberately does not wrap.
 */
const CLIENT_METHODS: Readonly<Record<string, string | null>> = {
  'GET /livez': 'isLive',
  /*
   * The one route with no method, and on purpose. It serves the document that
   * DESCRIBES this API; what a TypeScript caller wants out of that document is
   * the types, and this package already ships them. A method returning it could
   * only be typed `unknown`, which is a worse answer than `types.ts` gives.
   */
  'GET /openapi.json': null,
  'GET /api/health': 'getHealth',
  'GET /api/metrics': 'getMetrics',

  'GET /api/investigations': 'listInvestigations',
  'POST /api/investigations': 'createInvestigation',
  'GET /api/investigations/{id}': 'getInvestigation',
  'POST /api/investigations/{id}/cancel': 'cancelInvestigation',
  'GET /api/investigations/{id}/events': 'listInvestigationEvents',
  'GET /api/investigations/{id}/evidence': 'listInvestigationEvidence',
  'GET /api/investigations/{id}/stream': 'streamInvestigation',

  'GET /api/repositories': 'listRepositories',
  'GET /api/repositories/{id}': 'getRepository',
  'GET /api/repositories/{id}/learnings': 'listLearnings',

  'GET /api/resolutions': 'listResolutions',
  'GET /api/resolutions/latest': 'latestResolution',
  'GET /api/resolutions/{id}': 'getResolution',

  'GET /api/validations': 'listValidations',
  'GET /api/validations/{id}': 'getValidation',
  'GET /api/validations/{id}/checks': 'listValidationChecks',
  'GET /api/validations/{id}/findings': 'listFindings',
  'GET /api/validations/{id}/evidence': 'listValidationEvidence',
  'GET /api/validations/{id}/events': 'listValidationEvents',
  'GET /api/validations/{id}/stream': 'streamValidation',

  'GET /api/organization': 'getOrganization',
  'GET /api/organization/members': 'listMembers',
  'GET /api/organization/keys': 'listApiKeys',
};

const KEYS = surface.routes.map((route) => `${route.method} ${route.path}`);

const ROUTED_METHODS = KEYS.map((key) => CLIENT_METHODS[key])
  .filter((name): name is string => typeof name === 'string')
  .sort();

describe('the client surface', () => {
  it('holds a route surface that has not been edited by hand', () => {
    const digest = `sha256-${createHash('sha256').update(JSON.stringify(surface.routes)).digest('hex')}`;
    expect(digest, 'route-surface.json was modified after generation; re-copy it from core').toBe(surface.digest);
    expect(surface.routeCount).toBe(surface.routes.length);
    expect(surface.generator).toBe('scripts/generate-route-surface.ts');
  });

  it('maps every route the engine serves to a client method', () => {
    const unmapped = KEYS.filter((key) => !(key in CLIENT_METHODS));
    expect(unmapped, 'the engine gained these routes and this client has no method for them').toEqual([]);
    // And nothing mapped that the engine no longer serves.
    expect(Object.keys(CLIENT_METHODS).filter((key) => !KEYS.includes(key))).toEqual([]);
    // Exactly one route is deliberately unwrapped; see its entry for why.
    expect(KEYS.filter((key) => CLIENT_METHODS[key] === null)).toEqual(['GET /openapi.json']);
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
