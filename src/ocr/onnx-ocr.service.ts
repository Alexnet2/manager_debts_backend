import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import path from 'path';
import { access, readFile } from 'fs/promises';

const DB_MIN = 30;
const DB_MAX = 140;

// Default character set matching the standard PaddleOCR en_dict.txt (95 chars).
// Order: digits → lowercase → uppercase → punctuation  (CTC blank = index 0).
// This is used as a fallback when en_dict.txt is not present on disk.
const EN_CHARSET_DEFAULT =
  '0123456789' +
  'abcdefghijklmnopqrstuvwxyz' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
  '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

export const DEFAULT_MODEL_PATH = path.resolve(
  __dirname,
  '../../models/en_PP-OCRv4_rec_infer.onnx',
);
export const DEFAULT_DICT_PATH = path.resolve(
  __dirname,
  '../../models/en_dict.txt',
);

export interface OcrResult {
  text: string;
  value: number | null;
  confidence: number;
  raw: string;
}

/**
 * ONNX-based OCR service using PaddleOCR's English recognition model.
 *
 * Drop-in replacement for the Tesseract-based OcrService.
 * One InferenceSession is shared across all concurrent inferences —
 * ONNX Runtime's C++ engine is thread-safe at this level, so no worker
 * pool is needed. A lightweight semaphore limits parallelism so the
 * memory footprint stays flat regardless of video length.
 */
export class OnnxOcrService {
  private session: ort.InferenceSession | null = null;
  private charset: string = EN_CHARSET_DEFAULT;
  private initPromise: Promise<void> | null = null;
  private readonly modelPath: string;
  private readonly dictPath: string;
  private readonly maxConcurrency: number;
  private activeCount = 0;
  private waitQueue: Array<() => void> = [];

  constructor(modelPath = DEFAULT_MODEL_PATH, maxConcurrency = 8, dictPath = DEFAULT_DICT_PATH) {
    this.modelPath = modelPath;
    this.dictPath = dictPath;
    this.maxConcurrency = maxConcurrency;
  }

  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.loadSession();
    return this.initPromise;
  }

  private async loadSession(): Promise<void> {
    try {
      await access(this.modelPath);
    } catch {
      throw new Error(
        `ONNX model not found: ${this.modelPath}\n` +
          'Run: npm run download-models',
      );
    }

    // Load character dictionary from disk if available; fall back to built-in.
    try {
      const dictContent = await readFile(this.dictPath, 'utf8');
      const chars = dictContent.split(/\r?\n/).filter((line) => line.length > 0);
      if (chars.length > 0) {
        this.charset = chars.join('');
      }
    } catch {
    }

    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      // 2 intra-op threads per inference × maxConcurrency concurrent calls
      // stays well within a typical machine's core budget.
      intraOpNumThreads: 2,
      interOpNumThreads: 1,
    });
  }

  async readNumber(imageBuffer: Buffer): Promise<OcrResult> {
    if (!this.initPromise) await this.initialize();
    await this.initPromise;

    await this.acquire();
    try {
      const tensor = await this.buildInputTensor(imageBuffer);
      const inputName = this.session!.inputNames[0];
      const results = await this.session!.run({ [inputName]: tensor });

      const outputName = this.session!.outputNames[0];
      const output = results[outputName];
      const text = this.ctcGreedyDecode(
        output.data as Float32Array,
        output.dims as number[],
      );

      const { value, raw } = this.findBestDbCandidate(text);
      return {
        text: text.trim(),
        value,
        confidence: value !== null ? 85 : 0,
        raw,
      };
    } catch (error) {
      console.error('[ONNX OCR] inference error:', error);
      return { text: '', value: null, confidence: 0, raw: '' };
    } finally {
      this.release();
    }
  }

  // ── concurrency control ────────────────────────────────────────────────────

  private acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waitQueue.push(resolve));
  }

  private release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.activeCount--;
    }
  }

  // ── preprocessing ──────────────────────────────────────────────────────────

  /**
   * Resize to height=48 (PaddleOCR rec model standard), normalize to [-1, 1],
   * and return an NCHW Float32 tensor [1, 3, 48, W].
   */
  private async buildInputTensor(imageBuffer: Buffer): Promise<ort.Tensor> {
    const TARGET_H = 48;
    const MAX_W = 1200;

    const meta = await sharp(imageBuffer).metadata();
    const origH = meta.height ?? TARGET_H;
    const origW = meta.width ?? MAX_W;

    const scale = TARGET_H / origH;
    const targetW = Math.min(MAX_W, Math.max(10, Math.round(origW * scale)));

    const { data, info } = await sharp(imageBuffer)
      .resize(targetW, TARGET_H, { fit: 'fill' })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });

    const W = info.width;
    const H = info.height;
    const tensor = new Float32Array(3 * H * W);

    // NCHW: channel-first layout expected by PaddleOCR models
    for (let c = 0; c < 3; c++) {
      for (let h = 0; h < H; h++) {
        for (let w = 0; w < W; w++) {
          const src = (h * W + w) * 3 + c;
          tensor[c * H * W + h * W + w] = (data[src] / 255.0 - 0.5) / 0.5;
        }
      }
    }

    return new ort.Tensor('float32', tensor, [1, 3, H, W]);
  }

  // ── CTC decoding ───────────────────────────────────────────────────────────

  /**
   * Greedy (best-path) CTC decode.
   * Dims are [batch=1, seqLen, numClasses]; blank is class index 0.
   */
  private ctcGreedyDecode(data: Float32Array, dims: number[]): string {
    const seqLen = dims[1];
    const numClasses = dims[2];
    let prevIdx = 0;
    let result = '';

    for (let t = 0; t < seqLen; t++) {
      const offset = t * numClasses;
      let maxVal = data[offset];
      let maxIdx = 0;

      for (let c = 1; c < numClasses; c++) {
        if (data[offset + c] > maxVal) {
          maxVal = data[offset + c];
          maxIdx = c;
        }
      }

      // Skip blank (0) and repeated tokens
      if (maxIdx !== 0 && maxIdx !== prevIdx) {
        result += this.charset[maxIdx - 1] ?? '';
      }
      prevIdx = maxIdx;
    }

    return result;
  }

  // ── candidate scoring ──────────────────────────────────────────────────────

  private findBestDbCandidate(text: string): { value: number | null; raw: string } {
    const tokens = text.split(/[\s\n\r]+/).filter(Boolean);
    let bestValue: number | null = null;
    let bestRaw = '';
    let bestScore = -Infinity;

    for (const token of tokens) {
      const cleaned = token.replace(/[^\d.]/g, '');
      if (!cleaned || cleaned.length < 2) continue;
      if ((cleaned.match(/\./g) ?? []).length > 1) continue;

      let value = parseFloat(cleaned);
      let scoredRaw = cleaned;

      // Recover missed decimal: "633" → "63.3"
      if (
        !cleaned.includes('.') &&
        (isNaN(value) || value > DB_MAX) &&
        cleaned.length >= 3 &&
        cleaned.length <= 4
      ) {
        const candidate = cleaned.slice(0, -1) + '.' + cleaned.slice(-1);
        const cv = parseFloat(candidate);
        if (!isNaN(cv) && cv >= DB_MIN && cv <= DB_MAX) {
          value = cv;
          scoredRaw = candidate;
        }
      }

      if (isNaN(value) || value < 0 || value > DB_MAX) continue;

      const score = this.scoreCandidate(value, scoredRaw);
      if (score > bestScore) {
        bestScore = score;
        bestValue = value;
        bestRaw = scoredRaw;
      }
    }

    return bestScore >= 10 ? { value: bestValue, raw: bestRaw } : { value: null, raw: '' };
  }

  private scoreCandidate(value: number, raw: string): number {
    let score = 0;
    if (value >= DB_MIN && value <= DB_MAX) score += 10;
    if (value >= 40 && value <= 120) score += 5;
    const dot = raw.indexOf('.');
    if (dot !== -1 && raw.length - dot - 1 === 1) score += 5; // exactly 1 decimal
    if (raw.length >= 3 && raw.length <= 5) score += 2;
    return score;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async terminate(): Promise<void> {
    this.session = null;
    this.initPromise = null;
    this.activeCount = 0;
    this.waitQueue = [];
  }
}
