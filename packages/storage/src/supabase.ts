import { StorageError, type ObjectStore } from './store.ts';

export interface SupabaseStorageOptions {
  /** e.g. https://abcd1234.supabase.co */
  readonly projectUrl: string;
  /** The server-side secret key (sb_secret_…). It can read and write every bucket. */
  readonly secretKey: string;
  readonly bucket: string;
  /** Created with these settings the first time it is needed. */
  readonly fileSizeLimitBytes: number;
  readonly allowedMimeTypes: readonly string[];
  readonly fetch?: typeof fetch;
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

// A loop, not /\/+$/: that pattern backtracks quadratically on a long run of '/'.
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

/**
 * Supabase Storage over its REST API with the secret key. Not supabase-js: the server keeps
 * to plain HTTP for everything but sign-in (ADR-0013). The bucket is private and is created
 * on first use, so a new project needs no setup.
 */
export function supabaseStorage(options: SupabaseStorageOptions): ObjectStore {
  const doFetch = options.fetch ?? fetch;
  const base = `${withoutTrailingSlashes(options.projectUrl)}/storage/v1`;
  const headers = {
    apikey: options.secretKey,
    authorization: `Bearer ${options.secretKey}`,
  };
  const call = async (path: string, init: RequestInit = {}) =>
    doFetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });
  const fail = async (what: string, res: Response): Promise<never> => {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new StorageError(
      `${what} failed: ${res.status} ${body.error ?? ''} ${body.message ?? ''}`.trim(),
      res.status,
    );
  };

  let bucketReady: Promise<void> | undefined;
  const ensureBucket = () =>
    (bucketReady ??= (async () => {
      const res = await call('/bucket', {
        method: 'POST',
        body: JSON.stringify({
          id: options.bucket,
          name: options.bucket,
          public: false,
          file_size_limit: options.fileSizeLimitBytes,
          allowed_mime_types: options.allowedMimeTypes,
        }),
      });
      if (res.ok) return;
      const body = (await res.json().catch(() => ({}))) as {
        statusCode?: string;
        error?: string;
        message?: string;
      };
      const exists =
        res.status === 409 ||
        body.statusCode === '409' ||
        body.error === 'Duplicate' ||
        /already exists/i.test(body.message ?? '');
      if (!exists) {
        throw new StorageError(
          `Creating the ${options.bucket} bucket failed: ${res.status} ${body.message ?? ''}`.trim(),
          res.status,
        );
      }
    })().catch((error: unknown) => {
      bucketReady = undefined;
      throw error;
    }));

  const objectPath = (path: string) => `${options.bucket}/${encodePath(path)}`;

  return {
    async signedUpload(path) {
      await ensureBucket();
      const res = await call(`/object/upload/sign/${objectPath(path)}`, { method: 'POST' });
      if (!res.ok) return fail('Signing an upload', res);
      const body = (await res.json()) as { url?: string; token?: string };
      const token = body.token ?? new URL(body.url ?? '', base).searchParams.get('token');
      if (!token) throw new StorageError('Signing an upload returned no token');
      return { path, token };
    },

    async signedDownloadUrl(path, expiresInSeconds) {
      const res = await call(`/object/sign/${objectPath(path)}`, {
        method: 'POST',
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });
      if (!res.ok) return fail('Signing a download', res);
      const body = (await res.json()) as { signedURL?: string; signedUrl?: string };
      const signed = body.signedURL ?? body.signedUrl;
      if (!signed) throw new StorageError('Signing a download returned no URL');
      return `${base}${signed.startsWith('/') ? '' : '/'}${signed}`;
    },

    async download(path) {
      const res = await call(`/object/authenticated/${objectPath(path)}`);
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      const body = (await res
        .clone()
        .json()
        .catch(() => ({}))) as {
        statusCode?: string;
        error?: string;
      };
      if (res.status === 404 || body.statusCode === '404' || body.error === 'not_found') {
        return null;
      }
      return fail('Downloading an object', res);
    },
  };
}
