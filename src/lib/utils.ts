const CODE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export const generateShortCode = (length: number = 6): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return result;
};

export const parseDuration = (duration: string | number): number => {
  if (typeof duration === 'number') return duration;

  const match = duration.match(/^(\d+)([mhdw]?)$/i);
  if (!match)
    throw new Error(
      "Invalid duration. I accept '15m', '1h', '1d', '1w' and friends — 'forever' is not a unit.",
    );

  const value = Number.parseInt(match[1], 10);
  const unit = match[2]?.toLowerCase() || 'h'; // default to hours if no unit

  switch (unit) {
    case 'm':
      return value / 60; // minutes to hours
    case 'h':
      return value;
    case 'd':
      return value * 24;
    case 'w':
      return value * 24 * 7;
    default:
      throw new Error('Unknown time unit. I know m, h, d and w — pick a letter I recognize.');
  }
};

/** ISO expiry timestamp `duration` from now (any `parseDuration` value). */
export const expiresAtFor = (duration: string | number = '24h'): string =>
  new Date(Date.now() + parseDuration(duration) * 3_600_000).toISOString();

export const expiryUrl = (
  url: string,
  duration: string | number = 24,
): { url: string; expiresAt: string } => ({ url, expiresAt: expiresAtFor(duration) });

/**
 * Normalizes opt-in one-time flags from JSON bodies (`boolean`) and
 * multipart form fields (`"true"` / `"1"` / `"on"`).
 */
export const parseOneTime = (value: unknown): boolean => {
  if (value === true) return true;
  if (typeof value === 'string') {
    return ['true', '1', 'on'].includes(value.trim().toLowerCase());
  }
  return false;
};

/**
 * Interstitial confirm page for one-time links/images.
 * GETs only render this page (never burn) so chat link-previews and bots
 * can't consume the entry — only an explicit POST (the form button) burns it.
 * The target URL / image bytes are deliberately NOT embedded here.
 */
export const oneTimeConfirmResponse = (kind: 'link' | 'image'): Response => {
  const noun = kind === 'link' ? 'link' : 'image';
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex, nofollow, noarchive">` +
    `<title>one-time ${noun} — click to reveal</title>` +
    `<style>body{font-family:monospace,sans-serif;background:#1a1a1a;color:#fff;display:flex;` +
    `align-items:center;justify-content:center;min-height:100vh;margin:0}` +
    `.box{max-width:26rem;padding:2rem;text-align:center}` +
    `button{font:inherit;background:#38bdf8;border:0;border-radius:6px;padding:.6rem 1.4rem;` +
    `cursor:pointer;margin-top:1rem}</style></head><body><div class="box">` +
    `<h1>one-time ${noun}</h1>` +
    `<p>this ${noun} burns after you reveal it. previews and bots only see this page — ` +
    `nothing is burned until you click.</p>` +
    `<form method="POST"><button type="submit">reveal once &rarr;</button></form>` +
    `</div></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html;charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  });
};

/**
 * Per-IP fixed-window rate limits for the write APIs. Counters live in the
 * existing SHORT_URLS KV under `rl:<route>:<ip>:<window>` keys with a native
 * TTL, so no new bindings are needed. Best-effort like the rest of the
 * codebase: concurrent writers can overshoot the limit by a little.
 */
export const RATE_LIMITS = {
  shorten: { limit: 30, windowSeconds: 600 },
  upload: { limit: 20, windowSeconds: 600 },
} as const;

export type RateLimitRoute = keyof typeof RATE_LIMITS;

export const getClientIp = (request: Request): string => {
  const cf = request.headers.get('CF-Connecting-IP')?.trim();
  if (cf) return cf;
  const forwarded = request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  return 'unknown';
};

export const checkRateLimit = async (
  kv: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  },
  route: RateLimitRoute,
  ip: string,
): Promise<{ allowed: boolean; retryAfter: number }> => {
  const { limit, windowSeconds } = RATE_LIMITS[route];
  // Can't identify the caller — fail open rather than locking everyone out.
  if (!ip || ip === 'unknown') return { allowed: true, retryAfter: 0 };
  const nowSec = Math.floor(Date.now() / 1000);
  const windowId = Math.floor(nowSec / windowSeconds);
  const key = `rl:${route}:${ip}:${windowId}`;
  let count = 0;
  try {
    const raw = await kv.get(key);
    if (raw) count = Number.parseInt(raw, 10) || 0;
  } catch {
    // Best-effort: a failed read must not block writes.
    return { allowed: true, retryAfter: 0 };
  }
  if (count >= limit) {
    return { allowed: false, retryAfter: Math.max(1, windowSeconds - (nowSec % windowSeconds)) };
  }
  try {
    await kv.put(key, String(count + 1), { expirationTtl: windowSeconds });
  } catch {
    // Best-effort: a failed write must not block this request.
  }
  return { allowed: true, retryAfter: 0 };
};
