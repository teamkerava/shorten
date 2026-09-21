import { describe, expect, test, mock } from 'bun:test';
import worker, { generateShortCode, parseOneTime } from './index';

describe('Short URL Generator', () => {
  test('generateShortCode creates a string of correct length', () => {
    const code = generateShortCode(6);
    expect(code).toBeString();
    expect(code.length).toBe(6);
  });

  test('generateShortCode creates unique codes', () => {
    const code1 = generateShortCode();
    const code2 = generateShortCode();
    expect(code1).not.toBe(code2);
  });

  const mockEnv = {
    SHORT_URLS: {
      put: mock(async () => {}),
      get: mock(async (key: string) => {
        if (key === 'testcode') return 'https://example.com';
        if (key === 'jsoncode')
          return JSON.stringify({ url: 'https://example.org', createdAt: '2023-01-01' });
        return null;
      }),
    },
  };

  test('POST /api/shorten returns a short code', async () => {
    const request = new Request('http://localhost/api/shorten', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com' }),
    });

    const response = await worker.fetch(request, mockEnv as any, {} as any);
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body).toHaveProperty('code');
    expect(body).toHaveProperty('shortUrl');
    expect(body.shortUrl).toInclude(body.code);
  });

  test('POST /api/shorten sets KV TTL matching duration', async () => {
    (mockEnv.SHORT_URLS.put as any).mockClear();
    const request = new Request('http://localhost/api/shorten', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com', duration: '1h' }),
    });

    const response = await worker.fetch(request, mockEnv as any, {} as any);
    expect(response.status).toBe(201);

    const calls = (mockEnv.SHORT_URLS.put as any).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1][2]).toEqual({ expirationTtl: 3600 });
  });

  test('POST /api/shorten rejects invalid duration with 400', async () => {
    const request = new Request('http://localhost/api/shorten', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com', duration: 'forever' }),
    });

    const response = await worker.fetch(request, mockEnv as any, {} as any);
    expect(response.status).toBe(400);
  });

  test('POST /api/shorten rate-limits per IP', async () => {
    const store = new Map<string, string>();
    const rlEnv = {
      SHORT_URLS: {
        put: mock(async (key: string, value: string) => {
          store.set(key, value);
        }),
        get: mock(async (key: string) => store.get(key) ?? null),
        delete: mock(async (key: string) => {
          store.delete(key);
        }),
      },
    };
    let last: Response | null = null;
    for (let i = 0; i < 31; i++) {
      last = await worker.fetch(
        new Request('http://localhost/api/shorten', {
          method: 'POST',
          headers: { 'CF-Connecting-IP': '9.9.9.9', 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com' }),
        }),
        rlEnv as any,
        {} as any,
      );
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get('Retry-After')).toBeString();
  });

  test('POST /api/upload rate-limits per IP', async () => {
    const store = new Map<string, string>();
    const bodies = new Map<string, ArrayBuffer>();
    const rlEnv = {
      SHORT_URLS: {
        put: mock(async (key: string, value: string) => {
          store.set(key, value);
        }),
        get: mock(async (key: string) => store.get(key) ?? null),
        delete: mock(async (key: string) => {
          store.delete(key);
        }),
      },
      IMAGE_R2: {
        put: mock(async (key: string, value: ArrayBuffer) => {
          bodies.set(key, value);
        }),
        get: mock(async () => null),
        delete: mock(async () => {}),
      },
    };
    let last: Response | null = null;
    for (let i = 0; i < 21; i++) {
      const form = new FormData();
      form.append('image', new File(['fake-image-bytes'], 'cat.png', { type: 'image/png' }));
      last = await worker.fetch(
        new Request('http://localhost/api/upload', {
          method: 'POST',
          headers: { 'CF-Connecting-IP': '8.8.8.8' },
          body: form,
        }),
        rlEnv as any,
        {} as any,
      );
    }
    expect(last!.status).toBe(429);
  });

  test('GET /:code redirects to original URL', async () => {
    const request = new Request('http://localhost/testcode');
    const response = await worker.fetch(request, mockEnv as any, {} as any);

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('https://example.com/');
  });

  test('GET /:code returns 404 for unknown code', async () => {
    const request = new Request('http://localhost/unknown');
    const response = await worker.fetch(request, mockEnv as any, {} as any);

    expect(response.status).toBe(404);
  });

  test('GET /:code handles JSON stored values', async () => {
    const request = new Request('http://localhost/jsoncode');
    const response = await worker.fetch(request, mockEnv as any, {} as any);

    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('https://example.org/');
  });

  const r2Store = new Map<string, { body: ArrayBuffer; contentType: string }>();
  const mockEnvWithR2 = {
    ...mockEnv,
    IMAGE_R2: {
      put: mock(async (key: string, value: ArrayBuffer, opts: any) => {
        r2Store.set(key, { body: value, contentType: opts?.httpMetadata?.contentType });
      }),
      get: mock(async (key: string) => {
        const entry = r2Store.get(key);
        if (!entry) return null;
        return {
          httpMetadata: { contentType: entry.contentType },
          arrayBuffer: async () => entry.body,
        };
      }),
    },
  };

  test('POST /api/upload stores image and returns short URL', async () => {
    const file = new File(['fake-image-bytes'], 'cat.png', { type: 'image/png' });
    const form = new FormData();
    form.append('image', file);
    const request = new Request('http://localhost/api/upload', {
      method: 'POST',
      body: form,
    });

    const response = await worker.fetch(request, mockEnvWithR2 as any, {} as any);
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body).toHaveProperty('code');
    expect(body).toHaveProperty('shortUrl');
    expect(body.shortUrl).toInclude('/img/');
    expect(body.code.endsWith('.png')).toBe(true);
  });

  test('POST /api/upload rejects missing image', async () => {
    const request = new Request('http://localhost/api/upload', {
      method: 'POST',
      body: new FormData(),
    });

    const response = await worker.fetch(request, mockEnvWithR2 as any, {} as any);
    expect(response.status).toBe(400);
  });

  test('POST /api/upload rejects non-image type', async () => {
    const file = new File(['x'], 'evil.exe', { type: 'application/x-msdownload' });
    const form = new FormData();
    form.append('image', file);
    const request = new Request('http://localhost/api/upload', {
      method: 'POST',
      body: form,
    });

    const response = await worker.fetch(request, mockEnvWithR2 as any, {} as any);
    expect(response.status).toBe(400);
  });

  test('POST /api/upload rejects formerly allowed types (svg)', async () => {
    const file = new File(['<svg></svg>'], 'pic.svg', { type: 'image/svg+xml' });
    const form = new FormData();
    form.append('image', file);
    const request = new Request('http://localhost/api/upload', {
      method: 'POST',
      body: form,
    });

    const response = await worker.fetch(request, mockEnvWithR2 as any, {} as any);
    expect(response.status).toBe(400);
  });

  test('GET /img/:code serves stored image', async () => {
    const file = new File(['hello'], 'a.png', { type: 'image/png' });
    const form = new FormData();
    form.append('image', file);
    const uploadRes = await worker.fetch(
      new Request('http://localhost/api/upload', { method: 'POST', body: form }),
      mockEnvWithR2 as any,
      {} as any,
    );
    const { code } = await uploadRes.json();

    const response = await worker.fetch(
      new Request(`http://localhost/img/${code}`),
      mockEnvWithR2 as any,
      {} as any,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
  });

  test('GET /img/:code returns 404 for unknown key', async () => {
    const request = new Request('http://localhost/img/nope.png');
    const response = await worker.fetch(request, mockEnvWithR2 as any, {} as any);

    expect(response.status).toBe(404);
  });

  describe('image expiry', () => {
    const expStore = new Map<
      string,
      { body: ArrayBuffer; contentType?: string; expiresAt?: string }
    >();
    const mockEnvExp = {
      IMAGE_R2: {
        put: mock(async (key: string, value: ArrayBuffer, opts: any) => {
          expStore.set(key, {
            body: value,
            contentType: opts?.httpMetadata?.contentType,
            expiresAt: opts?.customMetadata?.expiresAt,
          });
        }),
        get: mock(async (key: string) => {
          const entry = expStore.get(key);
          if (!entry) return null;
          return {
            httpMetadata: { contentType: entry.contentType },
            customMetadata: entry.expiresAt ? { expiresAt: entry.expiresAt } : {},
            arrayBuffer: async () => entry.body,
          };
        }),
        delete: mock(async (key: string) => {
          expStore.delete(key);
        }),
      },
    };

    const upload = (duration?: string) => {
      const file = new File(['img-bytes'], 'pic.png', { type: 'image/png' });
      const form = new FormData();
      form.append('image', file);
      if (duration !== undefined) form.append('duration', duration);
      return worker.fetch(
        new Request('http://localhost/api/upload', { method: 'POST', body: form }),
        mockEnvExp as any,
        {} as any,
      );
    };

    test('POST /api/upload defaults to 24h expiry', async () => {
      const response = await upload();
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body).toHaveProperty('expiresAt');
      const hoursLeft = (new Date(body.expiresAt).getTime() - Date.now()) / 3600000;
      expect(hoursLeft).toBeGreaterThan(23.9);
      expect(hoursLeft).toBeLessThanOrEqual(24);

      const stored = expStore.get(body.code);
      expect(stored?.expiresAt).toBe(body.expiresAt);
    });

    test('POST /api/upload honors a custom duration', async () => {
      const response = await upload('15m');
      expect(response.status).toBe(201);

      const body = await response.json();
      const minsLeft = (new Date(body.expiresAt).getTime() - Date.now()) / 60000;
      expect(minsLeft).toBeGreaterThan(14.9);
      expect(minsLeft).toBeLessThanOrEqual(15);
    });

    test('POST /api/upload rejects an invalid duration', async () => {
      const response = await upload('forever');
      expect(response.status).toBe(400);
    });

    test('POST /api/upload allows exactly 30 days', async () => {
      const response = await upload('30d');
      expect(response.status).toBe(201);
    });

    test('POST /api/upload rejects image durations over 30 days', async () => {
      for (const duration of ['31d', '5w', '721h']) {
        const response = await upload(duration);
        expect(response.status).toBe(400);
      }
    });

    test('GET /img/:code returns 410 and deletes an expired image', async () => {
      const uploadRes = await upload('15m');
      const { code } = await uploadRes.json();

      // Force expiry by backdating the stored metadata
      const stored = expStore.get(code)!;
      stored.expiresAt = new Date(Date.now() - 1000).toISOString();

      const response = await worker.fetch(
        new Request(`http://localhost/img/${code}`),
        mockEnvExp as any,
        {} as any,
      );
      expect(response.status).toBe(410);
      expect(expStore.has(code)).toBe(false);
    });

    test('GET /img/:code caps Cache-Control at the remaining TTL', async () => {
      const uploadRes = await upload('15m');
      const { code } = await uploadRes.json();

      const response = await worker.fetch(
        new Request(`http://localhost/img/${code}`),
        mockEnvExp as any,
        {} as any,
      );
      expect(response.status).toBe(200);
      const cache = response.headers.get('Cache-Control')!;
      expect(cache).toInclude('max-age=');
      expect(cache.includes('immutable')).toBe(false);
    });
  });

  describe('parseOneTime', () => {
    test('normalizes JSON and form flags', () => {
      expect(parseOneTime(true)).toBe(true);
      expect(parseOneTime(false)).toBe(false);
      expect(parseOneTime('true')).toBe(true);
      expect(parseOneTime('1')).toBe(true);
      expect(parseOneTime('on')).toBe(true);
      expect(parseOneTime('false')).toBe(false);
      expect(parseOneTime('0')).toBe(false);
      expect(parseOneTime(undefined)).toBe(false);
      expect(parseOneTime(null)).toBe(false);
    });
  });

  describe('one-time short URLs (burn after reading)', () => {
    const kv = new Map<string, string>();
    const mockEnvOnce = {
      SHORT_URLS: {
        put: mock(async (key: string, value: string) => {
          kv.set(key, value);
        }),
        get: mock(async (key: string) => kv.get(key) ?? null),
        delete: mock(async (key: string) => {
          kv.delete(key);
        }),
      },
    };

    const shorten = (body: unknown) =>
      worker.fetch(
        new Request('http://localhost/api/shorten', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
        mockEnvOnce as any,
        {} as any,
      );

    const visit = (code: string) =>
      worker.fetch(new Request(`http://localhost/${code}`), mockEnvOnce as any, {} as any);

    const consume = (code: string) =>
      worker.fetch(
        new Request(`http://localhost/${code}`, { method: 'POST' }),
        mockEnvOnce as any,
        {} as any,
      );

    test('one-time URL shows confirm page on GET, burns on POST, then 404s', async () => {
      const created = await shorten({ url: 'https://example.com/secret', oneTime: true });
      expect(created.status).toBe(201);

      const body = await created.json();
      expect(body.oneTime).toBe(true);

      // Previews/bots only see the confirm page — repeated GETs never burn.
      for (let i = 0; i < 2; i++) {
        const preview = await visit(body.code);
        expect(preview.status).toBe(200);
        expect(preview.headers.get('Content-Type')).toInclude('text/html');
        expect(preview.headers.get('Cache-Control')).toBe('no-store');
        expect(kv.has(body.code)).toBe(true);
      }

      const first = await consume(body.code);
      expect(first.status).toBe(301);
      expect(first.headers.get('Cache-Control')).toBe('no-store');

      const second = await visit(body.code);
      expect(second.status).toBe(404);
      expect(kv.has(body.code)).toBe(false);
    });

    test('regular URL stays viewable and cacheable', async () => {
      const created = await shorten({ url: 'https://example.com/normal' });
      expect(created.status).toBe(201);

      const { code, oneTime } = await created.json();
      expect(oneTime).toBeUndefined();

      for (let i = 0; i < 2; i++) {
        const response = await visit(code);
        expect(response.status).toBe(301);
        expect(response.headers.get('Cache-Control')).toBeNull();
      }
      expect(kv.has(code)).toBe(true);
    });
  });

  describe('one-time images (burn after reading)', () => {
    const imgStore = new Map<
      string,
      { body: ArrayBuffer; contentType?: string; expiresAt?: string; oneTime?: string }
    >();
    const mockEnvImgOnce = {
      IMAGE_R2: {
        put: mock(async (key: string, value: ArrayBuffer, opts: any) => {
          imgStore.set(key, {
            body: value,
            contentType: opts?.httpMetadata?.contentType,
            expiresAt: opts?.customMetadata?.expiresAt,
            oneTime: opts?.customMetadata?.onetime,
          });
        }),
        get: mock(async (key: string) => {
          const entry = imgStore.get(key);
          if (!entry) return null;
          return {
            httpMetadata: { contentType: entry.contentType },
            customMetadata: {
              ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
              // Production R2 returns metadata keys lowercased.
              ...(entry.oneTime ? { onetime: entry.oneTime } : {}),
            },
            arrayBuffer: async () => entry.body,
          };
        }),
        delete: mock(async (key: string) => {
          imgStore.delete(key);
        }),
      },
    };

    const uploadOnce = (oneTime: boolean) => {
      const file = new File(['burn-after-reading'], 'secret.png', { type: 'image/png' });
      const form = new FormData();
      form.append('image', file);
      if (oneTime) form.append('oneTime', 'true');
      return worker.fetch(
        new Request('http://localhost/api/upload', { method: 'POST', body: form }),
        mockEnvImgOnce as any,
        {} as any,
      );
    };

    const serve = (code: string) =>
      worker.fetch(new Request(`http://localhost/img/${code}`), mockEnvImgOnce as any, {} as any);

    const consumeImg = (code: string) =>
      worker.fetch(
        new Request(`http://localhost/img/${code}`, { method: 'POST' }),
        mockEnvImgOnce as any,
        {} as any,
      );

    test('one-time image shows confirm page on GET, burns on POST, then 404s', async () => {
      const uploadRes = await uploadOnce(true);
      expect(uploadRes.status).toBe(201);

      const { code, oneTime } = await uploadRes.json();
      expect(oneTime).toBe(true);

      // Previews/bots only see the confirm page — repeated GETs never burn.
      for (let i = 0; i < 2; i++) {
        const preview = await serve(code);
        expect(preview.status).toBe(200);
        expect(preview.headers.get('Content-Type')).toInclude('text/html');
        expect(preview.headers.get('Cache-Control')).toBe('no-store');
        expect(imgStore.has(code)).toBe(true);
      }

      const first = await consumeImg(code);
      expect(first.status).toBe(200);
      expect(first.headers.get('Cache-Control')).toBe('no-store');
      expect(await first.arrayBuffer()).toHaveLength('burn-after-reading'.length);

      const second = await serve(code);
      expect(second.status).toBe(404);
      expect(imgStore.has(code)).toBe(false);
    });

    test('regular image stays servable', async () => {
      const uploadRes = await uploadOnce(false);
      expect(uploadRes.status).toBe(201);

      const { code, oneTime } = await uploadRes.json();
      expect(oneTime).toBeUndefined();

      for (let i = 0; i < 2; i++) {
        const response = await serve(code);
        expect(response.status).toBe(200);
      }
      expect(imgStore.has(code)).toBe(true);
    });

    test('legacy mixed-case oneTime metadata still burns', async () => {
      // Object stored before the lowercase-key fix: customMetadata key is
      // literally "oneTime". Serve it through a dedicated mock env.
      const legacyBody = new TextEncoder().encode('legacy-bytes').buffer as ArrayBuffer;
      const legacyEnv = {
        IMAGE_R2: {
          get: mock(async () => ({
            httpMetadata: { contentType: 'image/png' },
            customMetadata: { oneTime: '1' },
            arrayBuffer: async () => legacyBody,
          })),
          delete: mock(async () => {}),
        },
      };

      // GET only renders the confirm page — must not burn.
      const preview = await worker.fetch(
        new Request('http://localhost/img/legacy.png'),
        legacyEnv as any,
        {} as any,
      );
      expect(preview.status).toBe(200);
      expect(preview.headers.get('Content-Type')).toInclude('text/html');
      expect(legacyEnv.IMAGE_R2.delete).not.toHaveBeenCalled();

      const response = await worker.fetch(
        new Request('http://localhost/img/legacy.png', { method: 'POST' }),
        legacyEnv as any,
        {} as any,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(legacyEnv.IMAGE_R2.delete).toHaveBeenCalledWith('legacy.png');
    });
  });
});
