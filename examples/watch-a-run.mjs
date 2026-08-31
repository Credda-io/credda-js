/**
 * A worked example: list the queue, read one investigation, watch it finish.
 *
 *     npm run example
 *
 * It needs no key, no account and no network. The engine is a stub HTTP server
 * started below on loopback, serving canned versions of the three routes the
 * example touches, and the client under test is the BUILT package -- imported
 * from `dist/`, the way a consumer imports it -- so this also proves the
 * published entry point resolves and the declaration build did not diverge.
 *
 * What it is not: evidence about the engine. The payloads here are hand-written
 * to the shapes in `src/lib/types.ts`. This shows how the client is CALLED, and
 * that a real HTTP round trip through it works end to end -- the bearer header,
 * the query string, the SSE framing, the terminal `complete` frame. Whether a
 * real run reaches a proven fix is a question about the engine, measured
 * elsewhere.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { CreddaClient } from '../dist/headless.js';

const API_KEY = 'stub-key-not-a-secret';
const ID = 'inv_7fa3';

const SUMMARY = {
  id: ID,
  repositoryId: 'repo_toolshed',
  repositorySource: 'https://github.com/Credda-io/toolshed',
  issueRef: 'https://github.com/Credda-io/toolshed/issues/3',
  issueTitle: 'Late fee is charged for the day the tool came back',
  state: 'REPRODUCED',
  outcome: null,
  providerId: null,
  startedAt: '2026-08-29T09:00:00.000Z',
  completedAt: null,
  createdAt: '2026-08-29T08:59:12.000Z',
  durationMs: null,
  eventCount: 3,
  evidenceCount: 1,
};

/**
 * `id:`/`event:`/`data:` frames, exactly as `apps/api/src/routes/stream.ts`
 * writes them. The `type` values are members of the engine's own event union
 * and the severities are its lower-case ones.
 */
const FRAMES = [
  { id: 4, event: 'message', data: { sequence: 4, type: 'REPRODUCTION_SUCCEEDED', severity: 'info', summary: 'the reported failure reproduces on a clean checkout', state: 'REPRODUCED' } },
  { id: 5, event: 'message', data: { sequence: 5, type: 'PATCH_CREATED', severity: 'info', summary: 'a patch, with a test that fails before it and passes after', state: 'GENERATING_PATCH' } },
  { id: 6, event: 'message', data: { sequence: 6, type: 'VERIFICATION_SUCCEEDED', severity: 'info', summary: 'the test failed on the unpatched tree and passes on the patched one', state: 'VERIFIED' } },
  { event: 'complete', data: { state: 'READY_FOR_REVIEW' } },
];

const server = createServer((req, res) => {
  // Every `/api` route is behind one bearer gate. Refusing here is the point:
  // it is what proves the client sent the header rather than that the stub is
  // lenient.
  if (req.headers.authorization !== `Bearer ${API_KEY}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'no bearer key' } }));
    return;
  }

  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/api/investigations') {
    console.log(`  the client asked for: ${url.pathname}${url.search}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ investigations: [SUMMARY], total: 1 }));
    return;
  }

  if (url.pathname === `/api/investigations/${ID}`) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        investigation: {
          id: ID,
          orgId: 'org_stub',
          repositoryId: SUMMARY.repositoryId,
          issueRef: SUMMARY.issueRef,
          issueTitle: SUMMARY.issueTitle,
          issueBody: 'A tool returned on the due date is still charged one day of late fee.',
          signalId: null,
          state: SUMMARY.state,
          outcome: null,
          providerId: null,
          budget: {},
          startedAt: SUMMARY.startedAt,
          completedAt: null,
          error: null,
          createdAt: SUMMARY.createdAt,
          updatedAt: '2026-08-29T09:00:30.000Z',
          durationMs: null,
        },
        hypotheses: [
          {
            id: 'hyp_1',
            investigationId: ID,
            description: 'the due date is compared with `<` where the loan terms say `<=`',
            rank: 1,
            status: 'SUPPORTED',
            supportingEvidenceIds: ['ev_1'],
            contradictingEvidenceIds: [],
            createdAt: '2026-08-29T09:00:20.000Z',
            updatedAt: '2026-08-29T09:00:20.000Z',
          },
        ],
        patches: [],
        verifications: [],
        evidenceCount: 1,
        latestSequence: 3,
      }),
    );
    return;
  }

  if (url.pathname === `/api/investigations/${ID}/stream`) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': heartbeat\n\n'); // a comment frame; the decoder must skip it
    for (const frame of FRAMES) {
      if (frame.id !== undefined) res.write(`id: ${frame.id}\n`);
      res.write(`event: ${frame.event}\n`);
      res.write(`data: ${JSON.stringify({ ...frame.data, id: `evt_${frame.id ?? 'x'}`, investigationId: ID, agentRunId: null, toolCallId: null, evidenceIds: [], metadata: {}, createdAt: '2026-08-29T09:01:00.000Z' })}\n\n`);
    }
    res.end();
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: url.pathname } }));
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address();

try {
  const credda = new CreddaClient({
    // There is no default base URL. Credda runs against your own deployment.
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: API_KEY,
  });

  console.log('\nThe queue, filtered to runs that have reproduced');
  const page = await credda.listInvestigations({ state: 'REPRODUCED', limit: 10 });
  console.log(`  ${page.investigations.length} of ${page.total}: ${page.investigations[0].issueTitle}`);
  assert.equal(page.total, 1);

  console.log('\nOne run, and what it currently believes');
  const detail = await credda.getInvestigation(ID);
  console.log(`  state ${detail.investigation.state}, top hypothesis: ${detail.hypotheses[0].description}`);
  assert.equal(detail.investigation.id, ID);

  console.log('\nWatching it, live');
  let terminal = '(the stream ended without one)';
  const seen = [];
  for await (const event of credda.streamInvestigation(ID, {
    onComplete: (state) => {
      terminal = state;
    },
  })) {
    console.log(`  ${event.sequence} ${event.type} -- ${event.summary}`);
    seen.push(event.sequence);
  }
  // Asserted rather than only printed, so `npm run example` is a gate: the
  // heartbeat comment must be skipped, all three events must arrive in order,
  // and the terminal `complete` must not be yielded as a fourth.
  assert.deepEqual(seen, [4, 5, 6]);
  assert.equal(terminal, 'READY_FOR_REVIEW');
  // `complete` is not yielded as an event: it carries a state, not a sequence.
  console.log(`\nThe run finished in ${terminal}.`);
  console.log(
    'READY_FOR_REVIEW means a patch and a test are waiting for a human. Credda\n' +
      'opens the pull request on the GitHub App path, with no flag and no switch.\n' +
      'The Action path opens none: its `open-pull-request` input is declared on no\n' +
      'version a caller can reach. It never merges one.',
  );
} finally {
  server.close();
}
