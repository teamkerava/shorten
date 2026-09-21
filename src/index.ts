import { AutoRouter, error } from 'itty-router';
import type { Env, Request } from './lib/types';
import { handleConsumeRedirect, handleRedirect, handleShorten } from './routes/shorten';
import { handleConsumeImage, handleServeImage, handleUpload } from './routes/upload';

const router = AutoRouter();

router.post('/api/shorten', async (request: Request, env: Env) => handleShorten(request, env));
router.post('/api/upload', async (request: Request, env: Env) => handleUpload(request, env));

// Served from the static asset so the URL stays stable while the content is a real file.
// GET / itself is served directly from public/index.html and never reaches the Worker.
router.get('/api/docs', (request: Request, env: Env) => {
  return env.ASSETS.fetch(new URL('/docs.html', request.url).toString());
});

router.get('/:code', async (request: Request, env: Env) => handleRedirect(request, env));
// POST consumes a one-time link (the confirm page form posts here).
router.post('/:code', async (request: Request, env: Env) => handleConsumeRedirect(request, env));

router.get('/img/:code', async (request: Request, env: Env) => handleServeImage(request, env));
// POST consumes a one-time image (the confirm page form posts here).
router.post('/img/:code', async (request: Request, env: Env) => handleConsumeImage(request, env));

// 404 Fallback
router.all('*', () => error(404, 'Not found. But hey, at least you tried, right?'));

// Re-export shared helpers so existing imports from "./index" keep working.
export {
  expiryUrl,
  expiresAtFor,
  generateShortCode,
  parseDuration,
  parseOneTime,
  oneTimeConfirmResponse,
  checkRateLimit,
  getClientIp,
  RATE_LIMITS,
} from './lib/utils';
export type { Env, Request, ShortUrlData, ShortenRequest } from './lib/types';

export default {
  fetch: router.fetch,
};
