import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `CreateInvestigationInput` must carry every field `createBody` accepts.
 *
 * `POST /api/investigations` gained `start` and `budget` on 2026-08-30 and this
 * SDK did not. `start` DEFAULTS TO FALSE server-side, so the omission looked
 * like working code from the outside: a caller got a row, no run, and no error.
 * The two capabilities the route was extended to provide — begin the run in the
 * same transaction, and cap what it may spend — were simply unreachable, and
 * `createBody` is `.strict()`, so adding them by hand was a 400.
 *
 * `surface.test.ts` learned this one level up and says so: it "used to
 * transcribe the routes, and could not notice one the engine gained", which is
 * how `cancelInvestigation` shipped in core and left this suite green. The
 * routes now arrive from the engine via `route-surface.json`. The FIELDS are
 * still transcribed by hand, and this is the guard for them until that file
 * carries request bodies too.
 */

const ROUTE = join(__dirname, '..', '..', '..', 'core', 'apps', 'api', 'src', 'routes', 'investigations.ts');
const CLIENT = join(__dirname, 'client.ts');
const HAVE_CORE = existsSync(ROUTE);

/** The keys of the `createBody` zod object, read from the engine's own source. */
function createBodyFields(): string[] {
  const src = readFileSync(ROUTE, 'utf8');
  const start = src.indexOf('export const createBody = z.object({');
  if (start === -1) throw new Error('createBody is no longer declared the way this test reads it');
  const body = src.slice(start, src.indexOf('}).strict();', start));
  return [...body.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]!);
}

describe('the create-investigation body', () => {
  /*
   * `skipIf`, never an early `return`.
   *
   * This guard is unreachable from a git worktree, where `../../../core` is not
   * the sibling it is in a real checkout — and an early return reports the test
   * as PASSING. The first version of this file did exactly that and "proved"
   * the fix while checking nothing; the two-sided proof caught it. Skipped is
   * visible in the runner's output. Passing is not.
   *
   * CI has no sibling checkout either, so it will skip there — which is the
   * honest answer, rather than failing for a reason nobody can fix from inside
   * this repository.
   */
  it.skipIf(!HAVE_CORE)('exposes every field the engine accepts', () => {
    const fields = createBodyFields();
    expect(fields.length, 'read no fields at all — the parse is wrong, not the SDK').toBeGreaterThan(3);

    const src = readFileSync(CLIENT, 'utf8');
    const declared = src.slice(
      src.indexOf('export interface CreateInvestigationInput {'),
      src.indexOf('export interface InvestigationBudgetInput {'),
    );
    const missing = fields.filter((f) => !new RegExp(`^ {2}${f}\\??:`, 'm').test(declared));

    expect(missing, `field(s) the engine accepts that this SDK cannot send: ${missing.join(', ')}`).toEqual([]);
  });

  it.skipIf(!HAVE_CORE)('still keeps the idempotency key out of the body', () => {
    // `createBody` is `.strict()` and the key travels as a header, so a field
    // here would be a 400 naming it. Pinned because the fix above WIDENS the
    // interface, and widening is how that guarantee would be lost.
    expect(createBodyFields()).not.toContain('idempotencyKey');
  });
});
