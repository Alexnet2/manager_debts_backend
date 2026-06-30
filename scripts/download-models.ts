/**
 * Downloads the PaddleOCR ONNX recognition model + character dictionary
 * required by OnnxOcrService.
 *
 * Usage:
 *   npm run download-models
 *   npx ts-node scripts/download-models.ts
 */
import https from 'https';
import http from 'http';
import { createWriteStream, existsSync } from 'fs';
import { mkdir, unlink, stat } from 'fs/promises';
import path from 'path';
import { URL } from 'url';

const MODELS_DIR = path.resolve(__dirname, '../models');

interface ModelSpec {
  /** Local filename saved under MODELS_DIR */
  name: string;
  /** Ordered list of URLs to try; first success wins */
  urls: string[];
}

const MODELS: ModelSpec[] = [
  {
    name: 'en_PP-OCRv4_rec_infer.onnx',
    urls: [
      // Primary: deepghs/paddleocr — en_PP-OCRv4_rec, confirmed 7.67 MB ONNX
      'https://huggingface.co/deepghs/paddleocr/resolve/main/rec/en_PP-OCRv4_rec/model.onnx',
      // Fallback: monkt/paddleocr-onnx — English rec model, 7.83 MB
      'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/english/rec.onnx',
    ],
  },
  {
    name: 'en_dict.txt',
    urls: [
      // Character dictionary from the same deepghs source (190 bytes, matches model)
      'https://huggingface.co/deepghs/paddleocr/resolve/main/rec/en_PP-OCRv4_rec/dict.txt',
      // Fallback: monkt/paddleocr-onnx English dict
      'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/english/dict.txt',
    ],
  },
];

// ── download helpers ───────────────────────────────────────────────────────────

async function fileHasContent(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return s.size > 0;
  } catch {
    return false;
  }
}

function tryDownload(url: string, dest: string, maxRedirects = 10): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    let received = 0;

    const fetch = (targetUrl: string, redirectsLeft: number): void => {
      const parsed = new URL(targetUrl);
      const client = parsed.protocol === 'https:' ? https : http;

      const req = client.get(targetUrl, { timeout: 60_000 }, (res) => {
        const { statusCode = 0, headers } = res;

        // Follow any 3xx redirect
        if (statusCode >= 300 && statusCode < 400) {
          const location = headers.location;
          if (!location) { reject(new Error(`Redirect (${statusCode}) without Location`)); return; }
          if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return; }
          res.resume();
          fetch(new URL(location, targetUrl).href, redirectsLeft - 1);
          return;
        }

        if (statusCode !== 200) {
          res.resume();
          file.close();
          unlink(dest).catch(() => {});
          reject(new Error(`HTTP ${statusCode} from ${targetUrl}`));
          return;
        }

        const total = parseInt(headers['content-length'] ?? '0', 10);

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (total > 0) {
            const pct = Math.round((received / total) * 100);
            process.stdout.write(
              `\r  ${pct.toString().padStart(3)}%  ${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`,
            );
          }
        });

        res.pipe(file);
        file.on('finish', () => {
          process.stdout.write('\n');
          resolve();
        });
      });

      req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${targetUrl}`)); });
      req.on('error', reject);
    };

    file.on('error', (err) => {
      file.close();
      // Remove partial file so next run doesn't skip this download
      unlink(dest).catch(() => {});
      reject(err);
    });
    fetch(url, maxRedirects);
  });
}

async function downloadWithFallback(spec: ModelSpec): Promise<void> {
  const dest = path.join(MODELS_DIR, spec.name);

  if (existsSync(dest) && await fileHasContent(dest)) {
    console.log(`✓ ${spec.name} — already present, skipping`);
    return;
  }

  // Remove empty/partial file left by a previous failed attempt
  if (existsSync(dest)) {
    await unlink(dest);
    console.log(`  Removed empty/partial ${spec.name}, re-downloading…`);
  }

  for (let i = 0; i < spec.urls.length; i++) {
    const url = spec.urls[i];
    const label = i === 0 ? 'primary' : `fallback ${i}`;
    console.log(`↓ ${spec.name}  [${label}]`);
    console.log(`  ${url}`);

    try {
      await tryDownload(url, dest);
      console.log(`✓ Saved → ${dest}`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ✗ ${msg}`);
      if (i + 1 < spec.urls.length) {
        console.log('  Trying next URL…');
      }
    }
  }

  throw new Error(
    `All URLs failed for ${spec.name}.\n` +
      'Download the file manually and place it in: ' +
      MODELS_DIR,
  );
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await mkdir(MODELS_DIR, { recursive: true });

  for (const spec of MODELS) {
    await downloadWithFallback(spec);
  }

  console.log('\n✅ All models ready. You can now start the server (npm run dev).');
}

main().catch((err) => {
  console.error('\n' + (err instanceof Error ? err.message : err));
  process.exit(1);
});
