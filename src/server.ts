import express, { Request, Response } from 'express';
import sharp from 'sharp';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import os from 'os';

// 調整可能な設定
const MAX_DIMENSION = 4000;             // 幅/高さの上限
const REQUEST_TIMEOUT_MS = 8000;        // 画像取得のタイムアウト
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']); // SSRF対策（最低限）

// sharp の並列度（デフォルト=CPU数）。状況に応じて調整してください。
sharp.concurrency(Math.min(os.cpus().length, 8));

// Node18+ の fetch にタイムアウトを付与
async function fetchWithTimeout(
  resource: string,
  options: (RequestInit & { timeout?: number }) = {}
): Promise<Response> {
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

// クエリ値を string に正規化
function qp(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v[0] != null ? String(v[0]) : undefined;
  if (typeof v === 'object') return undefined; // ネストは未対応（必要に応じて拡張）
  return String(v);
}

// バリデーション/正規化
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

const app = express();

// 例: GET /resize?url=...&w=800&h=600&fit=cover&format=webp&q=80
app.get('/resize', async (req: Request, res: Response) => {
  try {
    const imageUrl = qp(req.query.url);
    if (!imageUrl) {
      return res.status(400).json({ error: 'Missing required query parameter: url' });
    }

    // URL 検証（最低限の SSRF 対策）
    let parsed: URL;
    try {
      parsed = new URL(imageUrl);
    } catch {
      return res.status(400).json({ error: 'Invalid url' });
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      return res.status(400).json({ error: 'Unsupported protocol. Use http or https.' });
    }

    // 「クエリが url のみ」か（厳密）
    const hasOnlyUrl = Object.keys(req.query).length === 1 && req.query.url !== undefined;

    // 画像取得
    let upstream: Response;
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

    // url のみならパススルー（ストリーミングでそのまま返す）
    if (hasOnlyUrl) {
      const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
      const contentLength = upstream.headers.get('content-length');
      res.set('Content-Type', contentType);
      if (contentLength) res.set('Content-Length', contentLength);
      res.set('Cache-Control', upstream.headers.get('cache-control') || 'public, max-age=3600');

      if (!upstream.body) return res.status(502).end();
      try {
        await pipeline(Readable.fromWeb(upstream.body), res);
        return;
      } catch (e) {
        console.error('Pass-through pipeline error:', e);
        if (!res.headersSent) res.status(502);
        return res.end();
      }
    }

    // ここから変換あり（ストリーミングで sharp に流し込む）
    const width = parseDimension(qp(req.query.w));
    const height = parseDimension(qp(req.query.h));
    const fit = normalizeFit(qp(req.query.fit));
    const outFormat = normalizeFormat(qp(req.query.format));
    const quality = normalizeQuality(qp(req.query.q));

    const transformer = sharp({ failOn: 'none' }).rotate(); // EXIFによる回転補正

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

    // 出力ヘッダ（変換あり: Content-Length は未確定なので付与しない）
    res.set('Cache-Control', 'public, max-age=3600');
    if (outFormat) {
      res.set('Content-Type', `image/${outFormat}`);
    } else {
      const orig = upstream.headers.get('content-type');
      res.set('Content-Type', orig && orig.startsWith('image/') ? orig : 'application/octet-stream');
    }

    if (!upstream.body) return res.status(502).end();
    try {
      await pipeline(Readable.fromWeb(upstream.body), transformer, res);
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

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Image server listening on http://localhost:${port}`);
});
