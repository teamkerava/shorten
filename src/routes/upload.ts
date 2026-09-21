import { error } from 'itty-router';
import type { Env, Request } from '../lib/types';
import {
  expiresAtFor,
  generateShortCode,
  parseDuration,
  parseOneTime,
  checkRateLimit,
  getClientIp,
  oneTimeConfirmResponse,
} from '../lib/utils';

// POST /api/upload
// Request body: multipart/form-data with "image" field,
// optional "duration" field and optional "oneTime" flag.
// Images live 30 days max — longer durations are rejected.

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Max image TTL in hours (30 days). Enforced so the "auto-deleted after 30 days" note stays true. */
export const MAX_IMAGE_TTL_HOURS = 30 * 24;

const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

interface ImageState {
  expiresAt?: string;
  oneTime: boolean;
}

/**
 * Reads expiry + one-time state from R2 custom metadata.
 * Accepts the legacy mixed-case `oneTime` key too (objects uploaded before
 * the lowercase-key fix); new uploads always write lowercase `onetime`
 * because metadata travels as case-insensitive `x-amz-meta-*` headers.
 */
const readImageState = (file: R2ObjectBody): ImageState => {
  const meta = file.customMetadata ?? {};
  return {
    expiresAt: meta.expiresAt,
    oneTime: meta.onetime === '1' || meta.oneTime === '1',
  };
};

/** `Cache-Control` for regular images, capped at the remaining TTL (max 1 day). */
const imageCacheControl = (expiresAt?: string): string => {
  if (!expiresAt) return 'public, max-age=31536000, immutable';
  const remainingSec = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  return `public, max-age=${Math.min(remainingSec, 86400)}`;
};

const imageNotFound = (code: string) =>
  error(
    404,
    `Image '${code}' not found. It either never existed or already burned after its one glorious view.`,
  );
const imageGone = () => error(410, 'This image has expired. Nothing gold can stay.');

export const handleUpload = async (request: Request, env: Env) => {
  const rl = await checkRateLimit(env.SHORT_URLS, 'upload', getClientIp(request));
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({
        error: 'Easy there, shutterbug. Too many uploads — take a breath and try again in a bit.',
      }),
      {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(rl.retryAfter) },
      },
    );
  }

  if (!env.IMAGE_R2) {
    return error(500, 'Image storage is not configured. The hamster powering R2 called in sick.');
  }

  let data: FormData;
  try {
    data = await request.formData();
  } catch {
    return error(
      400,
      "Invalid request. I asked for multipart/form-data with an 'image' field and got... this.",
    );
  }

  const file = data.get('image') as File | string | null;

  if (!file || typeof file === 'string') {
    return error(400, "No image? Bold strategy. Send multipart/form-data with an 'image' field.");
  }

  const mimeType = file.type || 'application/octet-stream';
  const fileExt = ALLOWED_IMAGE_TYPES[mimeType];
  if (!fileExt) {
    return error(
      400,
      `Unsupported image type '${mimeType}'. We take png, jpeg, gif, webp — not modern art.`,
    );
  }

  if (file.size === 0) {
    return error(400, "Empty file. That's just vibes, not an image. Pick a real one.");
  }

  if (file.size > MAX_IMAGE_BYTES) {
    return error(400, "Image too large. 10 MB max — this isn't a museum archive.");
  }

  const fileName = `${generateShortCode(8)}.${fileExt}`;

  let duration = '24h';
  const rawDuration = data.get('duration');
  if (typeof rawDuration === 'string' && rawDuration.trim()) {
    duration = rawDuration.trim();
  }

  let expiresAt: string;
  try {
    const ttlHours = parseDuration(duration);
    if (ttlHours > MAX_IMAGE_TTL_HOURS) {
      return error(
        400,
        'Images live 30 days max — pick a shorter duration. Nothing hosted here is forever.',
      );
    }
    expiresAt = expiresAtFor(duration);
  } catch (err) {
    return error(400, (err as Error).message);
  }

  const oneTime = parseOneTime(data.get('oneTime'));

  try {
    // R2 accepts ArrayBuffer directly; Node's Buffer does not exist in Workers.
    await env.IMAGE_R2.put(fileName, await file.arrayBuffer(), {
      httpMetadata: {
        contentType: mimeType,
      },
      customMetadata: {
        expiresAt,
        // Lowercase key: customMetadata travels as x-amz-meta-* headers,
        // whose names are case-insensitive and may come back lowercased.
        ...(oneTime ? { onetime: '1' } : {}),
      },
    });
  } catch (err) {
    console.error('R2 put error:', err);
    return error(500, 'Failed to store image. The bucket fumbled it — try again?');
  }

  const origin = new URL(request.url).origin;
  const shortUrl = `${origin}/img/${fileName}`;

  return new Response(
    JSON.stringify({
      code: fileName,
      shortUrl,
      originalMimeType: mimeType,
      expiresAt,
      ...(oneTime ? { oneTime: true as const } : {}),
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      status: 201,
    },
  );
};

// Shared read path for GET (preview) and POST (consume) below.
// Regular images serve immediately. One-time images render a confirm page on
// GET — previews/bots only see the page and never burn the entry. The burn
// happens on POST (the form button), which deletes then serves the bytes.

const serveImage = async (request: Request, env: Env, consume: boolean) => {
  const code = request.params.code;
  const file = await env.IMAGE_R2.get(code);

  if (!file) return imageNotFound(code);

  const { expiresAt, oneTime } = readImageState(file);
  if (expiresAt && new Date(expiresAt) < new Date()) {
    try {
      await env.IMAGE_R2.delete(code);
    } catch {
      // Best-effort expiry cleanup.
    }
    return imageGone();
  }

  if (oneTime && !consume) return oneTimeConfirmResponse('image');

  const contentType = file.httpMetadata?.contentType || 'application/octet-stream';
  const body = await file.arrayBuffer();

  if (oneTime) {
    // Burn after reading: delete so a second viewer gets 404.
    try {
      await env.IMAGE_R2.delete(code);
    } catch {
      // Best-effort: still serve even if the delete failed.
    }
    return new Response(body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      },
    });
  }

  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': imageCacheControl(expiresAt),
    },
  });
};

// GET /img/:code — serves regular images, confirm page for one-time ones.
export const handleServeImage = async (request: Request, env: Env) =>
  serveImage(request, env, false);

// POST /img/:code — consumes a one-time image (burn after reading).
export const handleConsumeImage = async (request: Request, env: Env) =>
  serveImage(request, env, true);
