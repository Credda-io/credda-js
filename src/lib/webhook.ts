/**
 * Verify inbound Credda webhooks.
 *
 * Credda signs each delivery with `X-Credda-Signature: sha256=<hex>` where the
 * HMAC-SHA256 is computed over `${X-Credda-Timestamp}.${rawBody}` using the
 * webhook's signing secret. Verify on the RAW request body — before JSON.parse —
 * or the bytes won't match. Uses WebCrypto (Node 18+ and browsers).
 */

/**
 * The event types Credda emits. Mirrors WEBHOOK_EVENT_TYPES in the API — keep
 * the two in step; a new event type is always additive.
 */
export type WebhookEventType =
  | 'score.updated'
  | 'score.band_changed'
  | 'dispute.resolved'
  | 'monitor.triggered'
  | 'policy.threshold_crossed'
  | 'usage.quota_warning'
  | 'import.completed'
  | 'screening.completed'
  /** A confirmation request you created is still unanswered past the reminder threshold. */
  | 'confirmation.awaiting_response'
  /** A pending confirmation request is approaching its expiry. */
  | 'confirmation.expiring_soon';

/** One factor's movement between the prior and new score. */
export interface WebhookFactorDelta {
  factor: 'CR' | 'OTR' | 'DR' | 'VD';
  before: number;
  after: number;
  delta: number;
  improved: boolean;
}

/** Why the score moved — a factor-level diff vs. the prior snapshot. */
export interface ScoreChangeReason {
  scoreDelta: number;
  direction: 'up' | 'down' | 'unchanged';
  factors: WebhookFactorDelta[];
  topDriver: WebhookFactorDelta | null;
  confidenceDelta: number;
  momentumDelta: number;
}

/** Payload of `score.updated` / `score.band_changed`. */
export interface ScoreEventData {
  user: { externalId: string };
  score: number;
  band: string;
  previousScore: number | null;
  previousBand: string | null;
  confidence: number;
  formulaVersion: string;
  computedAt: string;
  /** Factor-level explanation of the change; null on a user's first score. */
  reason?: ScoreChangeReason | null;
}

/** Payload of `dispute.resolved`. */
export interface DisputeResolvedData {
  disputeId: string;
  /** Present for platform-adjudicated resolutions; omitted for auto-lapses. */
  eventId?: string;
  user: { externalId: string | null };
  outcome: 'FOR_USER' | 'AGAINST_USER';
  status: 'RESOLVED_FOR_USER' | 'RESOLVED_AGAINST_USER';
  /** True when the dispute lapsed unadjudicated (resolved in the user's favor). */
  lapsed: boolean;
  resolvedAt: string;
}

/** Payload of `monitor.triggered` — an edge-triggered score-monitor condition fired. */
export interface MonitorTriggeredData {
  monitorId: string;
  /** The platform's external user id. */
  userId: string;
  previousScore: number | null;
  newScore: number;
  previousBand: string | null;
  newBand: string;
  condition: 'below_score' | 'above_score' | 'band_change';
  /** The crossed threshold; null for band_change. */
  threshold: number | null;
  formulaVersion: string;
}

/** Payload of `usage.quota_warning` — usage crossed the warning share of the monthly quota. */
export interface UsageQuotaWarningData {
  used: number;
  cap: number;
  remaining: number;
  /** The configured warning share of the cap (default 0.8). */
  ratio: number;
  /** ceil(cap × ratio) — the request count that tripped the warning. */
  threshold: number;
  /** When the quota period resets (start of next UTC month), ISO 8601. */
  periodEnd: string;
}

/** Common envelope fields shared by every delivered event. */
interface WebhookEventBase {
  id: string;
  createdAt: string;
  /**
   * False when the event was produced by test-mode (`crd_test_` key) activity,
   * true for live activity (Stripe convention). Additive: deliveries recorded
   * before test mode existed omit it — treat a missing value as live.
   */
  livemode?: boolean;
}

export interface ScoreUpdatedEvent extends WebhookEventBase { type: 'score.updated'; data: ScoreEventData }
export interface ScoreBandChangedEvent extends WebhookEventBase { type: 'score.band_changed'; data: ScoreEventData }
export interface DisputeResolvedEvent extends WebhookEventBase { type: 'dispute.resolved'; data: DisputeResolvedData }
export interface MonitorTriggeredEvent extends WebhookEventBase { type: 'monitor.triggered'; data: MonitorTriggeredData }
export interface UsageQuotaWarningEvent extends WebhookEventBase { type: 'usage.quota_warning'; data: UsageQuotaWarningData }

/**
 * A verified webhook event. Discriminated on `type`, so `switch (event.type)`
 * narrows `event.data` to the right payload:
 *
 *   const e = await constructWebhookEvent({ … });
 *   if (e.type === 'dispute.resolved') e.data.disputeId; // typed
 *   else e.data.score;                                   // score events
 */
export type WebhookEvent =
  | ScoreUpdatedEvent
  | ScoreBandChangedEvent
  | DisputeResolvedEvent
  | MonitorTriggeredEvent
  | UsageQuotaWarningEvent;

export interface VerifyWebhookInput {
  /** The webhook's signing secret (`whsec_…`). */
  secret: string;
  /** The exact raw request body bytes as a string (verify BEFORE parsing JSON). */
  rawBody: string;
  /** `X-Credda-Signature` header value (`sha256=<hex>`). */
  signatureHeader: string | null | undefined;
  /** `X-Credda-Timestamp` header value (unix seconds). */
  timestampHeader: string | null | undefined;
  /** Reject deliveries whose timestamp drifts more than this (seconds). 0 disables. Default 300. */
  toleranceSeconds?: number;
  /** Override the current time (unix seconds) — for tests. */
  nowSeconds?: number;
}

export interface WebhookVerification {
  valid: boolean;
  reason?: string;
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Constant-time comparison of two equal-length ASCII strings. */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle) throw new Error('credda: WebCrypto (HMAC-SHA256) is not available in this environment');
  const enc = new TextEncoder();
  const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await subtle.sign('HMAC', key, enc.encode(message));
  return toHex(sig);
}

/**
 * Verify a webhook's signature (and, unless disabled, its timestamp freshness).
 * Returns a result object rather than throwing, so a handler can branch cleanly.
 */
export async function verifyWebhookSignature(input: VerifyWebhookInput): Promise<WebhookVerification> {
  const { secret, rawBody, signatureHeader, timestampHeader } = input;
  const tolerance = input.toleranceSeconds ?? 300;

  if (!signatureHeader) return { valid: false, reason: 'missing signature header' };
  if (!timestampHeader) return { valid: false, reason: 'missing timestamp header' };

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return { valid: false, reason: 'invalid timestamp' };

  if (tolerance > 0) {
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > tolerance) return { valid: false, reason: 'timestamp outside tolerance (possible replay)' };
  }

  const expected = await hmacSha256Hex(secret, `${ts}.${rawBody}`);
  const provided = signatureHeader.replace(/^sha256=/, '').trim().toLowerCase();
  if (!timingSafeEqualStr(expected, provided)) return { valid: false, reason: 'signature mismatch' };

  return { valid: true };
}

/**
 * Verify a webhook and return the parsed, typed event. Throws if verification
 * fails or the body isn't the expected shape — the Stripe-style ergonomic path.
 */
export async function constructWebhookEvent(input: VerifyWebhookInput): Promise<WebhookEvent> {
  const result = await verifyWebhookSignature(input);
  if (!result.valid) throw new Error(`credda: webhook verification failed: ${result.reason}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    throw new Error('credda: webhook body is not valid JSON');
  }
  const e = (parsed ?? {}) as Record<string, unknown>;
  if (typeof e.id !== 'string' || typeof e.type !== 'string' || typeof e.createdAt !== 'string') {
    throw new Error('credda: webhook body is missing required fields (id, type, createdAt)');
  }
  return e as unknown as WebhookEvent;
}
