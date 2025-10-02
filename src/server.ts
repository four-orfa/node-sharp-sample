import express, { Request, Response } from 'express';
import sharp from 'sharp';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import os from 'os';

const app = express();
sharp.concurrency(Math.min(os.cpus().length, 8));

const MAX_DIMENSION = 4000;
const REQUEST_TIMEOUT_MS = 8000;

// 許可ドメイン/サブドメイン（必要なら拡張）
const ALLOWED_DOMAIN = /^img\.example\.com$/;
// S3パス部（英数字、スラッシュのみ、4階層、ファイル名は拡張子必須）
const S3_PATH_REGEX = /^\/([a-zA-Z0-9_\-]+\/){4}[a-zA-Z0-9_\-]+\.[a-zA-Z]+$/;

// S3画像の取得先（AWS S3のHTTP公開URL等）
const S3_BASE_URL = 'https://img.example.com'; // S3公開URLのルート

async function fetchWithTimeout(
  resource: string,
  options: (RequestInit & { timeout?: number }) = {}
): Promise<globalThis.Response> {
  const { timeout = REQUEST_TIMEOUT_MS, ...rest } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(resource, { ...rest, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function parseDimension(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.floor(n), MAX_DIMENSION);
}

type Fit = 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
function normalizeFit(value?: string): Fit {
  const allowed: Fit[] = ['cover', 'contain', 'fill', 'inside', 'outside'];
  const v = (value ?? '').toLowerCase();
  return (allowed as string[]).includes(v) ? (v as Fit) : 'cover';
}

type OutFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'gif' | 'tiff';
function normalizeFormat(value?: string): OutFormat | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === 'jpg') return 'jpeg';
  const allowed: OutFormat[] = ['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff'];
  return (allowed as string[]).includes(v) ? (v as OutFormat) : undefined;
}

function normalizeQuality(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

// すべてのリクエストを画像パスとして受ける
app.get('/:p1/:p2/:p3/:p4/:p5/:fileName', async (req: Request, res: Response) => {
  try {
    // Express の req.hostname でサーバのドメインを取得
    const host = req.hostname;
    if (!ALLOWED_DOMAIN.test(host)) {
      return res.status(403).json({ error: 'Forbidden domain' });
    }

    // パスを組み立て
    const s3Path = req.path; // 例: /images/product/2025/09/24/12345.jpg
    if (!S3_PATH_REGEX.test(s3Path)) {
      return res.status(400).json({ error: 'Invalid path format' });
    }

    // 画像URL（S3公開URL）を組み立て
    const imageUrl = `${S3_BASE_URL}${s3Path}`;

    // クエリ取得
    const width = parseDimension(req.query.w as string | undefined);
    const height = parseDimension(req.query.h as string | undefined);
    const fit = normalizeFit(req.query.fit as string | undefined);
    const outFormat = normalizeFormat(req.query.format as string | undefined);
    const quality = normalizeQuality(req.query.q as string | undefined);

    // 画像取得
    let upstream: globalThis.Response;
    try {
      upstream = await fetchWithTimeout(imageUrl);
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        return res.status(504).json({ error: 'Upstream image fetch timed out' });
      }
      console.error(e);
      return res.status(502).json({ error: 'Failed to fetch upstream image' });
    }

    if (!upstream.ok) {
      return res
        .status(400)
        .json({ error: `Failed to fetch image: ${upstream.status} ${upstream.statusText}` });
    }

    // パススルー（変換パラメータなし）
    const hasResizeParams = width || height || outFormat || req.query.fit || req.query.q;
    if (!hasResizeParams) {
      const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
      const contentLength = upstream.headers.get('content-length');
      res.set('Content-Type', contentType);
      if (contentLength) res.set('Content-Length', contentLength);
      res.set('Cache-Control', upstream.headers.get('cache-control') || 'public, max-age=3600');

      if (!upstream.body) return res.status(502).end();
      try {
        await pipeline(
          Readable.fromWeb(upstream.body as ReadableStream<any>),
          res
        );
        return;
      } catch (e) {
        console.error('Pass-through pipeline error:', e);
        if (!res.headersSent) res.status(502);
        res.end();
        return;
      }
    }

    // sharpによる変換
    const transformer = sharp({ failOn: 'none' }).rotate();
    if (width || height) {
      transformer.resize(width || null, height || null, {
        fit,
        withoutEnlargement: true
      });
    }
    if (outFormat) {
      const fmtOpts: Record<string, unknown> = {};
      if (quality !== undefined && ['jpeg', 'png', 'webp', 'avif', 'tiff'].includes(outFormat)) {
        fmtOpts.quality = quality;
      }
      transformer.toFormat(outFormat, fmtOpts);
    }

    res.set('Cache-Control', 'public, max-age=3600');
    if (outFormat) {
      res.set('Content-Type', `image/${outFormat}`);
    } else {
      const orig = upstream.headers.get('content-type');
      res.set('Content-Type', orig && orig.startsWith('image/') ? orig : 'application/octet-stream');
    }

    if (!upstream.body) return res.status(502).end();
    try {
      await pipeline(
        Readable.fromWeb(upstream.body as ReadableStream<any>),
        transformer,
        res
      );
    } catch (e) {
      console.error('Transform pipeline error:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Image transform failed' });
      else res.end();
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 必要に応じて 404 ハンドラ等追加
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Image server listening on http://localhost:${port}`);
});