import os from 'os';
import path from 'path';
import { DEFAULT_MODEL_PATH } from '../ocr/onnx-ocr.service';

export interface ImageProcessingConfig {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  grayscale: boolean;
  contrast: number;
  brightness: number;
  sharpen: boolean;
  threshold: number;
  resizeScale: number;
}

export interface VideoProcessingConfig {
  fps: number;
  frameInterval: number;
  targetSampleFps: number;
  tempDir: string;
  maxFrames?: number;
}

export interface OcrConfig {
  modelPath: string;
  workerCount: number;
}

export interface ValidationConfig {
  minValue: number;
  maxValue: number;
  smoothingThreshold: number;
  removeDuplicates: boolean;
}

export class ConfigService {
  private imageConfig: ImageProcessingConfig;
  private videoConfig: VideoProcessingConfig;
  private ocrConfig: OcrConfig;
  private validationConfig: ValidationConfig;

  constructor() {
    this.imageConfig = this.loadImageConfig();
    this.videoConfig = this.loadVideoConfig();
    this.ocrConfig = this.loadOcrConfig();
    this.validationConfig = this.loadValidationConfig();
  }

  private loadImageConfig(): ImageProcessingConfig {
    return {
      cropX: parseInt(process.env.IMAGE_CROP_X || '0'),
      cropY: parseInt(process.env.IMAGE_CROP_Y || '0'),
      cropWidth: 0,
      cropHeight: 0,
      grayscale: process.env.IMAGE_GRAYSCALE !== 'false',
      contrast: parseFloat(process.env.IMAGE_CONTRAST || '1.2'),
      brightness: parseFloat(process.env.IMAGE_BRIGHTNESS || '0'),
      sharpen: process.env.IMAGE_SHARPEN !== 'false',
      threshold: parseInt(process.env.IMAGE_THRESHOLD || '128'),
      resizeScale: parseFloat(process.env.IMAGE_RESIZE_SCALE || '2'),
    };
  }

  setImageConfigFromVideoDimensions(videoWidth: number, videoHeight: number): void {
    const cropX = parseInt(process.env.IMAGE_CROP_X || '0');
    const cropY = parseInt(process.env.IMAGE_CROP_Y || '0');
    const cropWidthPercent = parseFloat(process.env.IMAGE_CROP_WIDTH_PERCENT || '1.0');
    const cropHeightPercent = parseFloat(process.env.IMAGE_CROP_HEIGHT_PERCENT || '1.0');

    const calculatedWidth = Math.round(videoWidth * cropWidthPercent);
    const calculatedHeight = Math.round(videoHeight * cropHeightPercent);

    this.imageConfig.cropWidth = Math.max(100, Math.min(calculatedWidth, videoWidth - cropX));
    this.imageConfig.cropHeight = Math.max(50, Math.min(calculatedHeight, videoHeight - cropY));
  }

  private loadVideoConfig(): VideoProcessingConfig {
    return {
      fps: parseInt(process.env.VIDEO_FPS || '30'),
      frameInterval: parseInt(process.env.VIDEO_FRAME_INTERVAL || '1'),
      targetSampleFps: parseInt(process.env.VIDEO_SAMPLE_FPS || '5'),
      tempDir: process.env.TEMP_DIR || './temp',
      maxFrames: process.env.VIDEO_MAX_FRAMES ? parseInt(process.env.VIDEO_MAX_FRAMES) : undefined,
    };
  }

  private loadOcrConfig(): OcrConfig {
    // Parallel inference slots: more than CPU cores is fine because ONNX Runtime
    // releases the JS thread during native inference, so more slots = better GPU/CPU
    // utilisation without blocking Node's event loop.
    const defaultWorkers = Math.min(16, Math.max(2, os.cpus().length * 2));
    return {
      modelPath: process.env.OCR_MODEL_PATH
        ? path.resolve(process.env.OCR_MODEL_PATH)
        : DEFAULT_MODEL_PATH,
      workerCount: parseInt(process.env.OCR_WORKER_COUNT || String(defaultWorkers)),
    };
  }

  private loadValidationConfig(): ValidationConfig {
    return {
      minValue: parseFloat(process.env.VALIDATION_MIN_VALUE || '0'),
      maxValue: parseFloat(process.env.VALIDATION_MAX_VALUE || '140'),
      smoothingThreshold: parseFloat(process.env.VALIDATION_SMOOTHING_THRESHOLD || '5'),
      removeDuplicates: process.env.VALIDATION_REMOVE_DUPLICATES !== 'false',
    };
  }

  getImageProcessingConfig(): ImageProcessingConfig { return { ...this.imageConfig }; }
  getVideoProcessingConfig(): VideoProcessingConfig { return { ...this.videoConfig }; }
  getOcrConfig(): OcrConfig { return { ...this.ocrConfig }; }
  getValidationConfig(): ValidationConfig { return { ...this.validationConfig }; }

  updateImageConfig(config: Partial<ImageProcessingConfig>): void {
    this.imageConfig = { ...this.imageConfig, ...config };
  }

  updateVideoConfig(config: Partial<VideoProcessingConfig>): void {
    this.videoConfig = { ...this.videoConfig, ...config };
  }

  updateOcrConfig(config: Partial<OcrConfig>): void {
    this.ocrConfig = { ...this.ocrConfig, ...config };
  }

  updateValidationConfig(config: Partial<ValidationConfig>): void {
    this.validationConfig = { ...this.validationConfig, ...config };
  }
}
