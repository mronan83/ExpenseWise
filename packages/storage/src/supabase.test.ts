import { describe, expect, it } from 'vitest';
import { receiptPath, StorageError } from './store.ts';
import { supabaseStorage } from './supabase.ts';

type Seen = { method: string; url: string; headers: Record<string, string>; body?: unknown };

function fakeFetch(answer: (req: Seen) => Response) {
  const seen: Seen[] = [];
  const fetch = (input: string, init: RequestInit = {}) => {
    const req: Seen = {
      method: init.method ?? 'GET',
      url: input,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(req);
    return Promise.resolve(answer(req));
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const store = (fetch: typeof globalThis.fetch) =>
  supabaseStorage({
    projectUrl: 'https://proj.supabase.co/',
    secretKey: 'sb_secret_test',
    bucket: 'receipts',
    fileSizeLimitBytes: 10_000_000,
    allowedMimeTypes: ['image/jpeg', 'application/pdf'],
    fetch,
  });

const path = receiptPath('org-1', 'rec-1');

describe('supabaseStorage', () => {
  it('creates the private bucket once, then signs uploads with the secret key', async () => {
    const { fetch, seen } = fakeFetch((req) =>
      req.url.endsWith('/bucket')
        ? json({ name: 'receipts' })
        : json({ url: `/object/upload/sign/receipts/${path}?token=tok-1` }),
    );
    const s = store(fetch);
    expect(await s.signedUpload(path)).toEqual({ path, token: 'tok-1' });
    await s.signedUpload(path);

    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST https://proj.supabase.co/storage/v1/bucket',
      `POST https://proj.supabase.co/storage/v1/object/upload/sign/receipts/${path}`,
      `POST https://proj.supabase.co/storage/v1/object/upload/sign/receipts/${path}`,
    ]);
    expect(seen[0]!.body).toMatchObject({
      id: 'receipts',
      public: false,
      file_size_limit: 10_000_000,
    });
    expect(seen[1]!.headers).toMatchObject({
      apikey: 'sb_secret_test',
      authorization: 'Bearer sb_secret_test',
    });
  });

  it('handles any number of trailing slashes on the project URL, quickly', async () => {
    const { fetch, seen } = fakeFetch(() => json({ signedURL: '/object/sign/receipts/x?token=t' }));
    const s = supabaseStorage({
      projectUrl: `https://proj.supabase.co${'/'.repeat(50_000)}`,
      secretKey: 'sb_secret_test',
      bucket: 'receipts',
      fileSizeLimitBytes: 1,
      allowedMimeTypes: [],
      fetch,
    });
    await s.signedDownloadUrl('x', 60);
    expect(seen[0]!.url).toBe('https://proj.supabase.co/storage/v1/object/sign/receipts/x');
  });

  it('treats an existing bucket as ready', async () => {
    const { fetch } = fakeFetch((req) =>
      req.url.endsWith('/bucket')
        ? json(
            { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' },
            400,
          )
        : json({ url: '/object/upload/sign/receipts/x?token=tok-2', token: 'tok-2' }),
    );
    expect((await store(fetch).signedUpload(path)).token).toBe('tok-2');
  });

  it('signs a short-lived download URL', async () => {
    const { fetch, seen } = fakeFetch(() =>
      json({ signedURL: `/object/sign/receipts/${path}?token=dl` }),
    );
    expect(await store(fetch).signedDownloadUrl(path, 300)).toBe(
      `https://proj.supabase.co/storage/v1/object/sign/receipts/${path}?token=dl`,
    );
    expect(seen[0]!.body).toEqual({ expiresIn: 300 });
  });

  it('downloads bytes, and reports a missing object as null', async () => {
    const { fetch } = fakeFetch((req) =>
      req.url.includes('missing')
        ? json({ statusCode: '404', error: 'not_found', message: 'Object not found' }, 400)
        : new Response(new Uint8Array([1, 2, 3])),
    );
    const s = store(fetch);
    expect(await s.download(path)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await s.download('orgs/o/receipts/missing')).toBeNull();
  });

  it('saves bytes the server has, replacing what was there', async () => {
    const { fetch, seen } = fakeFetch(() => json({ Key: `receipts/${path}` }));
    await store(fetch).save(path, new Uint8Array([37, 80, 68, 70]), 'application/pdf');
    const saved = seen.at(-1)!;
    expect(saved.method).toBe('POST');
    expect(saved.url).toBe(`https://proj.supabase.co/storage/v1/object/receipts/${path}`);
    expect(saved.headers).toMatchObject({
      authorization: 'Bearer sb_secret_test',
      'content-type': 'application/pdf',
      'x-upsert': 'true',
    });
  });

  it('removes an object by its path', async () => {
    const { fetch, seen } = fakeFetch(() => json([{ name: path }]));
    await store(fetch).remove(path);
    const removed = seen.at(-1)!;
    expect(removed.method).toBe('DELETE');
    expect(removed.url).toBe('https://proj.supabase.co/storage/v1/object/receipts');
    expect(removed.body).toEqual({ prefixes: [path] });
  });

  it('fails loudly on anything else', async () => {
    const { fetch } = fakeFetch(() => json({ error: 'Unauthorized', message: 'Invalid key' }, 403));
    await expect(store(fetch).download(path)).rejects.toBeInstanceOf(StorageError);
    await expect(store(fetch).signedUpload(path)).rejects.toThrow(/bucket failed: 403/);
  });
});
