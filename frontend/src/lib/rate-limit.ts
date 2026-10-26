import { NextResponse } from "next/server";

const WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_WINDOW = 30;

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * In-memory, per-process fixed-window limiter. Good enough to stop a single
 * client from hammering the public Horizon/Soroban RPC nodes through this
 * API — NOT distributed, so it resets per instance on a multi-instance
 * deployment. Set RATE_LIMIT_REDIS_URL to switch to the Redis-backed store
 * which enforces a single shared limit across all instances (#28).
 */
const buckets = new Map<string, Bucket>();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
}, 5 * 60_000).unref?.();

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  /** Seconds until the window resets. Only set when success is false. */
  retryAfter?: number;
}

/**
 * Pluggable store interface for the rate limiter (#28).
 * The in-memory default is synchronous; a Redis implementation is async.
 */
export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }>;
}

/**
 * Redis-backed store. Two instances sharing the same Redis enforce one
 * combined limit. Selected automatically when RATE_LIMIT_REDIS_URL is set.
 */
export class RedisRateLimitStore implements RateLimitStore {
  private client: import("ioredis").Redis | null = null;

  constructor(private readonly url: string) {}

  private async getClient(): Promise<import("ioredis").Redis> {
    if (!this.client) {
      const { default: Redis } = await import("ioredis");
      this.client = new Redis(this.url, { lazyConnect: true });
      await this.client.connect();
    }
    return this.client;
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    const redis = await this.getClient();
    const windowSec = Math.ceil(windowMs / 1000);
    // Atomic INCR + EXPIRE: the Lua script ensures the TTL is set exactly once.
    const result = (await redis.eval(
      `local c = redis.call('INCR', KEYS[1])
       if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
       return {c, redis.call('PTTL', KEYS[1])}`,
      1,
      key,
      String(windowSec)
    )) as [number, number];
    return { count: result[0], ttlMs: Math.max(0, result[1]) };
  }
}

/** The active store — Redis when RATE_LIMIT_REDIS_URL is set, otherwise in-memory. */
export const rateLimitStore: RateLimitStore | null = process.env.RATE_LIMIT_REDIS_URL
  ? new RedisRateLimitStore(process.env.RATE_LIMIT_REDIS_URL)
  : null;

/**
 * Core bucket logic — keyed by an arbitrary string that callers compose.
 * Returns a structured result rather than a NextResponse so it can be used
 * in non-HTTP contexts (tests, background workers, etc.).
 *
 * Uses the in-memory store directly (synchronous). For the distributed Redis
 * path use rateLimitAsync.
 */
export function rateLimit(key: string, max: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true, remaining: max - 1 };
  }

  if (bucket.count >= max) {
    return {
      success: false,
      remaining: 0,
      retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
    };
  }

  bucket.count += 1;
  return { success: true, remaining: max - bucket.count };
}

/**
 * Async rate-limit check that works with any RateLimitStore, including Redis.
 * Falls back to the in-memory rateLimit() when no store is provided and
 * RATE_LIMIT_REDIS_URL is not set.
 */
export async function rateLimitAsync(
  key: string,
  max: number,
  windowMs: number,
  store: RateLimitStore | null = rateLimitStore
): Promise<RateLimitResult> {
  if (!store) return rateLimit(key, max, windowMs);
  const { count, ttlMs } = await store.increment(key, windowMs);
  if (count > max) {
    return { success: false, remaining: 0, retryAfter: Math.ceil(ttlMs / 1000) };
  }
  return { success: true, remaining: max - count };
}

/**
 * Derive a stable client key from an HTTP request.
 *
 * `X-Forwarded-For` is a client-controlled header; any value it carries is
 * only trustworthy when a known, trusted reverse proxy set it. The
 * `TRUST_PROXY` environment variable opts in to that trust:
 *
 *   - `TRUST_PROXY=1` (or any non-empty, non-"false" string): use the first
 *     value from `X-Forwarded-For`. Set this only when a trusted proxy sits
 *     in front of this server and strips or rewrites the header itself.
 *   - `TRUST_PROXY` unset or `"false"` (the default): ignore the header.
 *     All requests share the key `"direct"` because the App Router does not
 *     expose the raw socket address. Deploy behind a trusted proxy and set
 *     `TRUST_PROXY=1` to get per-IP bucketing in production.
 */
export function getClientKey(req: Request): string {
  const trustProxy =
    process.env.TRUST_PROXY !== undefined &&
    process.env.TRUST_PROXY !== "" &&
    process.env.TRUST_PROXY !== "false";

  if (trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for");
    const ip = forwarded?.split(",")[0]?.trim();
    if (ip) return ip;
  }

  // Without a trusted proxy the socket address is unavailable in App Router.
  // Fall back to a single shared key rather than silently trusting a spoofed
  // header — the per-scope limit still applies, just not per-IP.
  return "direct";
}

/**
 * HTTP-level helper: returns a 429 NextResponse if the caller is over the
 * limit, or null if the request should proceed.
 */
export function rateLimitRequest(
  req: Request,
  opts?: { scope?: string; max?: number }
): NextResponse | null {
  const max = opts?.max ?? DEFAULT_MAX_PER_WINDOW;
  const key = `${opts?.scope ?? "default"}:${getClientKey(req)}`;
  const result = rateLimit(key, max, WINDOW_MS);

  if (!result.success) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(result.retryAfter ?? 60) },
      }
    );
  }

  return null;
}
