/**
 * The idempotency key for `POST /api/investigations`, and the only value this
 * client will retry a create against.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE ENGINE PROMISES
 * ---------------------------------------------------------------------------
 * `apps/api/src/routes/investigations.ts` reads an `Idempotency-Key` header on
 * the create route and, with `createInvestigationOnce` in `context.ts`, writes
 * the key and a hash of the parsed body alongside the run in one transaction:
 *
 *   • 201, first request under that key — the run was created.
 *   • 200, the SAME body again under that key — the same run, returned again.
 *     Nothing was created and nothing was billed.
 *   • 409 `IDEMPOTENCY_KEY_REUSED`, a DIFFERENT body under that key — and
 *     neither run is disclosed: the earlier one would answer a question this
 *     caller never asked, and a new one is the duplicate the key was sent to
 *     prevent.
 *   • No header at all — byte for byte the behaviour the route had before the
 *     header existed. One row per request, no claim written.
 *
 * The claim is scoped to the organisation the bearer key names and never
 * expires; it lives as long as the investigation and is deleted with it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE KEY IS MINTED HERE AND NOT INSIDE THE REQUEST
 * ---------------------------------------------------------------------------
 * Running an investigation spends a model budget, so a create that is repeated
 * because a socket died is a second bill. That is what the key prevents, and it
 * is why {@link CreddaClient.createInvestigationOnce} is the one write this
 * client will retry.
 *
 * It would have been easy to have the client mint a key on EVERY create and
 * retry them all. This package deliberately does not, and the engine is the
 * reason. A key means "these requests are one intent", and the engine's own
 * handler says only the caller can know that: a natural key over the body would
 * make the second run of the same report impossible, and rerunning one report
 * is a real thing to want, because the engine is not deterministic and the
 * obvious move after a run that reproduced nothing is to run it again. A key
 * this client minted per call would also cover only ITS OWN retries — the
 * process that crashes and re-sends after restart, which is the case that
 * actually double-bills, has no way to name a key it never saw. So the caller
 * mints it, holds it, and can send it again tomorrow. {@link newIdempotencyKey}
 * makes that one call; it is not made on anyone's behalf.
 */

import type { CreateInvestigationInput } from './client.js';

/** @internal */
declare const idempotencyBrand: unique symbol;

/**
 * A validated `Idempotency-Key`. Branded so it cannot be produced by writing a
 * string: every key on this client comes from {@link newIdempotencyKey} or
 * {@link idempotencyKey}, both of which enforce the engine's 1–255 ceiling
 * before a request is spent finding out.
 */
export type IdempotencyKey = string & { readonly [idempotencyBrand]: 'IdempotencyKey' };

/** The engine's ceiling, from `idempotencyHeader` on the create route. */
const MAX_KEY_LENGTH = 255;

/**
 * Adopts a key the caller already holds — one read back from their own job
 * record after a restart, which is the case a client-minted key cannot serve.
 *
 * Throws a `TypeError` for a value the engine would refuse with a 400.
 */
export function idempotencyKey(value: string): IdempotencyKey {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('credda: an idempotency key must be a non-empty string');
  }
  if (value.length > MAX_KEY_LENGTH) {
    throw new TypeError(`credda: an idempotency key is at most ${MAX_KEY_LENGTH} characters`);
  }
  return value as IdempotencyKey;
}

/**
 * Mints a fresh key. A UUID from the platform's CSPRNG where there is one, and
 * `Math.random` is never a fallback: two callers colliding on a key is one
 * organisation being handed the other's investigation.
 */
export function newIdempotencyKey(): IdempotencyKey {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID() as IdempotencyKey;
  if (typeof c?.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') as IdempotencyKey;
  }
  throw new TypeError(
    'credda: no Web Crypto available to mint an idempotency key; pass your own to idempotentCreate()',
  );
}

/**
 * One key bound to one body — the value
 * {@link CreddaClient.createInvestigationOnce} takes, and the reason a key
 * cannot drift onto a different report by accident.
 *
 * The engine's second promise is the sharp one: the same key over a DIFFERENT
 * body is a 409, and a client that took the key and the body as two independent
 * arguments would make that mistake reachable by editing one of them. Here they
 * are made together and are `readonly` afterwards. Changing the report means
 * calling {@link idempotentCreate} again, which mints a new key unless you
 * insist on an old one.
 *
 * ```ts
 * const claim = idempotentCreate({ repositoryId, issueTitle, issueBody });
 * await jobs.record(ticketId, claim.key);   // so our own restart can send it again
 * const created = await credda.createInvestigationOnce(claim);
 * // created.status === 'REPLAYED' means an earlier attempt of ours got through.
 * ```
 */
export class IdempotentCreate {
  /** Prefer {@link idempotentCreate}, which mints the key. */
  constructor(
    readonly key: IdempotencyKey,
    readonly input: CreateInvestigationInput,
  ) {
    Object.freeze(this);
  }
}

/**
 * Pairs a create body with a key, minting one unless the caller supplies the
 * key they already recorded.
 *
 * Calling this IS the caller's statement that a repeat of this request is the
 * same intent. Nothing in this client makes that statement for them: see the
 * note at the top of this file.
 */
export function idempotentCreate(
  input: CreateInvestigationInput,
  key: IdempotencyKey = newIdempotencyKey(),
): IdempotentCreate {
  return new IdempotentCreate(key, input);
}
