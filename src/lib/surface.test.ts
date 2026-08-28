import { describe, expect, it } from 'vitest';
import { CreddaClient } from './client.js';
import * as headless from '../headless.js';

/**
 * A guard on the shape of the package rather than on any one call.
 *
 * `@credda/js` 0.x was a client for a reliability-score API, and this repository
 * is the source mirror for a published name that still means that to anyone who
 * has not read the changelog. These two tests fail if a trust-era method or
 * export comes back, and if a method appears that no route in
 * `apps/api/src/routes/` serves.
 */

/** One entry per route, transcribed from `apps/api/src/app.ts` and `routes/`. */
const ROUTED_METHODS = [
  // routes/investigations.ts
  'listInvestigations',
  'createInvestigation',
  'getInvestigation',
  'listInvestigationEvents',
  'listInvestigationEvidence',
  'streamInvestigation',
  // routes/repositories.ts
  'listRepositories',
  'listLearnings',
  // routes/resolutions.ts
  'listResolutions',
  'latestResolution',
  'getResolution',
  // routes/validations.ts
  'listValidations',
  'getValidation',
  'listValidationChecks',
  'listFindings',
  'listValidationEvidence',
  'listValidationEvents',
  'streamValidation',
  // routes/organization.ts
  'getOrganization',
  'listMembers',
  'listApiKeys',
  // routes/health.ts, app.ts `/livez`, routes/metrics.ts
  'getHealth',
  'isLive',
  'getMetrics',
].sort();

describe('the client surface', () => {
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
