import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { DisplayRegion, FrameReading, ProcessingResult, Statistics } from '../types';
import { FrameService, FrameMetadata } from './frame.service';
import { ImageService } from './image.service';
import { OcrService } from './ocr.service';
import { ValidationService } from './validation.service';
import { ConfigService } from './config.service';
import { DisplayDetector } from '../segments/display-detector';
import { DisplayReader } from '../segments/display-reader';

const MAX_CONCURRENCY = Math.min(os.cpus().length * 4, 64);
// Frames buffered between FFmpeg ingestion and OCR consumer.
// FFmpeg only pauses when this fills up, not when OCR workers are busy.
const QUEUE_CAPACITY = MAX_CONCURRENCY * 2;

interface FrameQueueItem {
  rawBuffer: Buffer;
  frameIndex: number;
}

// Bounded async FIFO: push() waits only for queue space (never for consumer completion),
// pop() waits only for an item (or returns null when closed).
class AsyncQueue<T> {
  private items: T[] = [];
  private popWaiters: Array<(v: T | null) => void> = [];
  private pushWaiters: Array<{ item: T; resolve: () => void }> = [];
  private closed = false;

  constructor(private readonly capacity: number) {}

  async push(item: T): Promise<void> {
    if (this.popWaiters.length > 0) {
      this.popWaiters.shift()!(item);
      return;
    }
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return;
    }
    await new Promise<void>((resolve) => this.pushWaiters.push({ item, resolve }));
  }

  async pop(): Promise<T | null> {
    if (this.items.length > 0) {
      const item = this.items.shift()!;
      if (this.pushWaiters.length > 0) {
        const { item: pending, resolve } = this.pushWaiters.shift()!;
        this.items.push(pending);
        resolve();
      }
      return item;
    }
    if (this.pushWaiters.length > 0) {
      const { item, resolve } = this.pushWaiters.shift()!;
      resolve();
      return item;
    }
    if (this.closed) return null;
    return new Promise<T | null>((resolve) => this.popWaiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    for (const w of this.popWaiters) w(null);
    this.popWaiters = [];
  }
}

export class VideoProcessor {
  private frameService: FrameService;
  private imageService: ImageService;
  private ocrService: OcrService;
  private validationService: ValidationService;
  private configService: ConfigService;
  private displayDetector: DisplayDetector;
  private displayReader: DisplayReader;
  private displayDetectionPromise: Promise<DisplayRegion | null> | null = null;

  constructor() {
    this.configService = new ConfigService();
    this.frameService = new FrameService(this.configService);
    this.imageService = new ImageService(this.configService);
    this.ocrService = new OcrService(this.configService);
    this.validationService = new ValidationService(this.configService);
    this.displayDetector = new DisplayDetector();
    this.displayReader = new DisplayReader();

    // Let libvips use all cores; our own concurrency pool controls Node.js-level parallelism.
    sharp.concurrency(0);
  }

  async processVideo(
    videoPath: string,
    onProgress?: (progress: number, frame: number, total: number) => void,
  ): Promise<ProcessingResult> {
    try {
      this.displayDetectionPromise = null;
      await this.ocrService.initialize();

      const metadata = await this.frameService.getVideoMetadata(videoPath);
      const samplingFps = this.configService.getVideoProcessingConfig().targetSampleFps || 5;
      const sampledTotal = Math.round(metadata.duration * samplingFps);

      const readings: FrameReading[] = [];
      let completedReadings = 0;
      const processingTasks: Promise<void>[] = [];

      const concurrency = Math.min(MAX_CONCURRENCY, sampledTotal || MAX_CONCURRENCY);
      let activeWorkers = 0;
      const semaphoreQueue: Array<() => void> = [];

      const acquireSlot = (): Promise<void> =>
        new Promise((resolve) => {
          if (activeWorkers < concurrency) {
            activeWorkers++;
            resolve();
          } else {
            semaphoreQueue.push(resolve);
          }
        });

      const releaseSlot = (): void => {
        const next = semaphoreQueue.shift();
        if (next) next();
        else activeWorkers--;
      };

      const scheduleProcessing = (rawBuffer: Buffer, frameIndex: number): void => {
        const task = (async () => {
          try {
            const reading = await this.readFrameRaw(rawBuffer, frameIndex, metadata, samplingFps);
            readings[frameIndex] = reading;
            completedReadings++;
            const knownTotal = sampledTotal || completedReadings;
            if (knownTotal > 0) {
              onProgress?.(
                50 + Math.round((completedReadings / knownTotal) * 50),
                completedReadings,
                knownTotal,
              );
            }
          } finally {
            releaseSlot();
          }
        })();
        processingTasks.push(task);
      };

      const frameQueue = new AsyncQueue<FrameQueueItem>(QUEUE_CAPACITY);

      const consumer = (async () => {
        while (true) {
          const item = await frameQueue.pop();
          if (item === null) break;
          await acquireSlot();
          scheduleProcessing(item.rawBuffer, item.frameIndex);
        }
      })();

      await this.frameService.extractFramesRawPipe(
        videoPath,
        metadata,
        async (rawBuffer, frameIndex) => {
          await frameQueue.push({ rawBuffer, frameIndex });
        },
        (progress, frame, total) => onProgress?.(Math.round(progress * 0.5), frame, total),
      );

      frameQueue.close();
      await consumer;
      await Promise.all(processingTasks);

      const validatedReadings = this.validationService.validateReadings(readings.filter(Boolean));
      const statistics = this.calculateStatistics(validatedReadings);
      return this.buildResult(videoPath, metadata, validatedReadings, new Date(), statistics);
    } finally {
      await this.ocrService.terminate();
    }
  }

  private async readFrameRaw(
    rawBuffer: Buffer,
    frameIndex: number,
    metadata: FrameMetadata,
    samplingFps: number,
  ): Promise<FrameReading> {
    const time = frameIndex / samplingFps;

    try {
      // Detection promise is created atomically on the first call (JS single-threaded sync
      // check+assign = no race condition). All subsequent frames await the same promise.
      if (!this.displayDetectionPromise) {
        this.displayDetectionPromise = sharp(rawBuffer, {
          raw: { width: metadata.width, height: metadata.height, channels: 3 },
        })
          .png()
          .toBuffer()
          .then((rawPng) => this.displayDetector.detectDisplayFromBuffer(rawPng))
          .then((region) => {
            if (region) {
              console.log(`[DisplayDetector] found region: x=${region.x} y=${region.y} w=${region.width} h=${region.height}`);
              return region;
            }
            // Close-up mode: display fills the frame — use full frame with small inset.
            const insetX = Math.floor(metadata.width * 0.02);
            const insetY = Math.floor(metadata.height * 0.02);
            const fallback = { x: insetX, y: insetY, width: metadata.width - insetX * 2, height: metadata.height - insetY * 2 };
            console.log(`[DisplayDetector] no region found, using full-frame fallback: ${JSON.stringify(fallback)}`);
            return fallback;
          });
      }
      const displayRegion = await this.displayDetectionPromise;

      if (displayRegion) {
        const left = Math.max(0, displayRegion.x);
        const top = Math.max(0, displayRegion.y);
        const w = Math.min(displayRegion.width, metadata.width - left);
        const h = Math.min(displayRegion.height, metadata.height - top);

        // Primary path: 7-segment detection (fast, no PNG roundtrip)
        const { data: segRaw, info: segInfo } = await sharp(rawBuffer, {
          raw: { width: metadata.width, height: metadata.height, channels: 3 },
        })
          .extract({ left, top, width: w, height: h })
          .grayscale()
          .normalize()
          .resize({ width: w * 2, height: h * 2, fit: 'fill' })
          .raw()
          .toBuffer({ resolveWithObject: true });

        if (frameIndex === 0) {
          sharp(segRaw, { raw: { width: segInfo.width, height: segInfo.height, channels: 1 } })
            .png()
            .toFile('./debug_seg_input.png')
            .catch(() => {});
        }

        const segResult = this.displayReader.readFromRaw(segRaw, segInfo.width, segInfo.height);
        if (segResult.value !== null && segResult.confidence > 0) {
          return {
            frame: frameIndex,
            time,
            db: segResult.value,
            confidence: segResult.confidence,
            method: 'segments' as const,
            raw: String(segResult.value),
          };
        }

        // Fallback: OCR with heavy preprocessing for 7-segment fonts
        const ocrBuffer = await sharp(rawBuffer, {
          raw: { width: metadata.width, height: metadata.height, channels: 3 },
        })
          .extract({ left, top, width: w, height: h })
          .grayscale()
          .normalize()
          .blur(5)
          .threshold(200)
          .resize({ width: w * 4, height: h * 4, fit: 'fill' })
          .withMetadata({ density: 300 })
          .png()
          .toBuffer();

        if (frameIndex < 3) {
          sharp(ocrBuffer).toFile(`./imagens/ocr_input_${frameIndex}.png`).catch(() => {});
        }

        const ocrResult = await this.ocrService.readNumber(ocrBuffer);
        return {
          frame: frameIndex,
          time,
          db: ocrResult.value,
          confidence: ocrResult.confidence,
          method: 'ocr' as const,
          raw: ocrResult.raw,
        };
      }

      const processed = await this.imageService.processFullFrameRaw(rawBuffer, metadata.width, metadata.height);
      const ocrResult = await this.ocrService.readNumber(processed.buffer);
      return {
        frame: frameIndex,
        time,
        db: ocrResult.value,
        confidence: ocrResult.confidence,
        method: 'ocr' as const,
        raw: ocrResult.raw,
      };
    } catch (error) {
      console.error(`Error reading frame ${frameIndex}:`, error);
      return { frame: frameIndex, time, db: null, confidence: 0, method: 'ocr', raw: '' };
    }
  }

  private buildResult(
    videoPath: string,
    metadata: FrameMetadata,
    readings: FrameReading[],
    processedAt: Date,
    statistics?: Statistics,
  ): ProcessingResult {
    return {
      videoId: path.basename(videoPath, path.extname(videoPath)),
      metadata: {
        duration: metadata.duration,
        fps: metadata.fps,
        width: metadata.width,
        height: metadata.height,
        totalFrames: readings.length,
      },
      readings,
      statistics: statistics ?? this.calculateStatistics(readings),
      processedAt,
    };
  }

  private calculateStatistics(readings: FrameReading[]): Statistics {
    const values = readings.filter((r) => r.db !== null).map((r) => r.db!);

    if (values.length === 0) {
      return { min: 0, max: 0, mean: 0, median: 0, stdDev: 0, validReadings: 0, totalReadings: 0 };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    const variance = values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    return { min, max, mean, median, stdDev, validReadings: values.length, totalReadings: readings.length };
  }
}
