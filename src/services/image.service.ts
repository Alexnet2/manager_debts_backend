import sharp from 'sharp';
import { ConfigService, ImageProcessingConfig } from './config.service';
import { DisplayRegion } from '../types';

export interface ProcessedImage {
  buffer: Buffer;
  width: number;
  height: number;
  metadata: sharp.Metadata;
}

let index = 0;

export class ImageService {
  private config: ImageProcessingConfig;

  constructor(configService: ConfigService) {
    this.config = configService.getImageProcessingConfig();
  }

  // Process the entire frame for full-frame OCR: grayscale → normalize → sharpen.
  // Downscales to at most MAX_OCR_WIDTH so Tesseract runs fast without losing readability.
  async processFullFrameRaw(rawRgb: Buffer, width: number, height: number): Promise<ProcessedImage> {
    const MAX_OCR_WIDTH = 1280;
    const scale = width > MAX_OCR_WIDTH ? MAX_OCR_WIDTH / width : 1;
    const outW = Math.round(width * scale);
    const outH = Math.round(height * scale);

    try {
      const { data: buffer, info } = await sharp(rawRgb, { raw: { width, height, channels: 3 } })
        .grayscale()
        .normalize()
        .sharpen({ sigma: 1 })
        .resize({ width: outW, height: outH, fit: 'fill' })
        .withMetadata({ density: 300 })
        .png()
        .toBuffer({ resolveWithObject: true });

      return {
        buffer,
        width: info.width,
        height: info.height,
        metadata: info as unknown as sharp.Metadata,
      };
    } catch (error) {
      throw new Error(`Failed to process full frame: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async processFrameRaw(rawRgb: Buffer, width: number, height: number): Promise<ProcessedImage> {
    try {
      let pipeline = sharp(rawRgb, { raw: { width, height, channels: 3 } });

      pipeline = this.cropDisplay(pipeline);
      pipeline = this.applyGrayscale(pipeline);
      pipeline = this.enhanceContrast(pipeline);
      pipeline = this.applySharpening(pipeline);
      pipeline = this.resizeForOcr(pipeline);

      const { data: buffer, info } = await pipeline
        .withMetadata({ density: 300 })
        .png()
        .toBuffer({ resolveWithObject: true });

      return {
        buffer,
        width: info.width,
        height: info.height,
        metadata: info as unknown as sharp.Metadata,
      };
    } catch (error) {
      throw new Error(`Failed to process raw image: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async preprocessForSegmentDetectionRaw(rawRgb: Buffer, width: number, height: number): Promise<ProcessedImage> {
    try {
      let pipeline = sharp(rawRgb, { raw: { width, height, channels: 3 } });

      pipeline = this.cropDisplay(pipeline);
      pipeline = this.applyGrayscale(pipeline);
      pipeline = pipeline.clahe({ width: 8, height: 8, maxSlope: 3 });
      pipeline = this.resizeForOcr(pipeline);

      const { data: buffer, info } = await pipeline
        .withMetadata({ density: 300 })
        .png()
        .toBuffer({ resolveWithObject: true });

      return {
        buffer,
        width: info.width,
        height: info.height,
        metadata: info as unknown as sharp.Metadata,
      };
    } catch (error) {
      throw new Error(
        `Failed to preprocess raw for segment detection: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async processFrame(imagePath: string): Promise<ProcessedImage> {
    try {
      let pipeline = sharp(imagePath);

      pipeline = this.cropDisplay(pipeline);
      pipeline = this.applyGrayscale(pipeline);
      pipeline = this.enhanceContrast(pipeline);
      pipeline = this.applySharpening(pipeline);
      pipeline = this.resizeForOcr(pipeline);

      const { data: buffer, info } = await pipeline
        .withMetadata({ density: 300 })
        .png()
        .toBuffer({ resolveWithObject: true });

      return {
        buffer,
        width: info.width,
        height: info.height,
        metadata: info as unknown as sharp.Metadata,
      };
    } catch (error) {
      throw new Error(`Failed to process image: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async preprocessForSegmentDetection(imagePath: string): Promise<ProcessedImage> {
    try {
      let pipeline = sharp(imagePath);

      pipeline = this.cropDisplay(pipeline);
      pipeline = this.applyGrayscale(pipeline);
      // Native CLAHE via libvips — replaces custom JS triple-nested loop (~10x faster)
      pipeline = pipeline.clahe({ width: 8, height: 8, maxSlope: 3 });
      pipeline = this.resizeForOcr(pipeline);

      const { data: buffer, info } = await pipeline
        .withMetadata({ density: 300 })
        .png()
        .toBuffer({ resolveWithObject: true });

      return {
        buffer,
        width: info.width,
        height: info.height,
        metadata: info as unknown as sharp.Metadata,
      };
    } catch (error) {
      throw new Error(
        `Failed to preprocess for segment detection: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  private cropDisplay(pipeline: sharp.Sharp): sharp.Sharp {
    if (this.config.cropWidth > 0 && this.config.cropHeight > 0) {
      return pipeline.extract({
        left: this.config.cropX,
        top: this.config.cropY,
        width: this.config.cropWidth,
        height: this.config.cropHeight,
      });
    }
    return pipeline;
  }

  private applyGrayscale(pipeline: sharp.Sharp): sharp.Sharp {
    if (this.config.grayscale) {
      return pipeline.grayscale();
    }
    return pipeline;
  }

  private enhanceContrast(pipeline: sharp.Sharp): sharp.Sharp {
    if (this.config.contrast !== 1) {
      return pipeline.modulate({
        brightness: 1 + this.config.brightness,
        saturation: this.config.contrast,
      });
    }
    return pipeline;
  }

  private applySharpening(pipeline: sharp.Sharp): sharp.Sharp {
    if (this.config.sharpen) {
      return pipeline.sharpen({ sigma: 1.5 });
    }
    return pipeline;
  }

  private resizeForOcr(pipeline: sharp.Sharp): sharp.Sharp {
    if (this.config.resizeScale !== 1 && this.config.cropWidth > 0 && this.config.cropHeight > 0) {
      const scale = Math.max(this.config.resizeScale, 3);
      return pipeline.resize({
        width: Math.round(this.config.cropWidth * scale),
        height: Math.round(this.config.cropHeight * scale),
        fit: 'fill',
      });
    }
    return pipeline;
  }

  // Single Sharp pipeline per frame: crops to the display region BEFORE the full-frame
  // resize, so only the small display area is scaled — not the entire video frame.
  // displayRegion coordinates must be in the post-config-crop + post-resize space
  // (i.e. the same space returned by preprocessForSegmentDetectionRaw).
  async extractDisplayRegionRaw(
    rawRgb: Buffer,
    frameWidth: number,
    frameHeight: number,
    displayRegion: DisplayRegion,
  ): Promise<{ data: Buffer; width: number; height: number }> {
    const { cropX, cropY, cropWidth, cropHeight, contrast, brightness, resizeScale } = this.config;
    const scale = Math.max(resizeScale, 3);
    const hasCrop = cropWidth > 0 && cropHeight > 0;

    // Origin of the config crop in frame space, clamped to frame bounds.
    const originX = hasCrop ? Math.max(0, Math.min(cropX, frameWidth - 1)) : 0;
    const originY = hasCrop ? Math.max(0, Math.min(cropY, frameHeight - 1)) : 0;
    // Dimensions of the config crop, clamped so the crop stays within the frame.
    const cropW = hasCrop ? Math.max(1, Math.min(cropWidth, frameWidth - originX)) : frameWidth;
    const cropH = hasCrop ? Math.max(1, Math.min(cropHeight, frameHeight - originY)) : frameHeight;

    // Map displayRegion from scaled crop-space back to unscaled crop-space.
    // A 2-pixel safety margin compensates for sub-pixel rounding during detection.
    const margin = 2;
    const rx = Math.max(0, Math.floor(displayRegion.x / scale) - margin);
    const ry = Math.max(0, Math.floor(displayRegion.y / scale) - margin);
    const rx2 = Math.min(cropW, Math.ceil((displayRegion.x + displayRegion.width) / scale) + margin);
    const ry2 = Math.min(cropH, Math.ceil((displayRegion.y + displayRegion.height) / scale) + margin);

    // Enforce a minimum 4-px size, then pull origin back if size pushes past the boundary.
    let rw = Math.max(4, rx2 - rx);
    let rh = Math.max(4, ry2 - ry);
    const rxCrop = Math.max(0, Math.min(rx, cropW - rw));
    const ryCrop = Math.max(0, Math.min(ry, cropH - rh));
    rw = Math.min(rw, cropW - rxCrop);
    rh = Math.min(rh, cropH - ryCrop);

    // Translate from crop-space to frame-space and do a SINGLE extract.
    // Chaining two .extract() calls is unreliable in Sharp — the second call's
    // bounds validation runs against the original frame dimensions in some versions,
    // which can produce internal coordinate offsets that libvips rejects.
    const extractLeft = originX + rxCrop;
    const extractTop = originY + ryCrop;
    const extractW = Math.min(rw, frameWidth - extractLeft);
    const extractH = Math.min(rh, frameHeight - extractTop);

    // Output at 2× the extracted (un-scaled) region size.
    // displayRegion is in detection-scale space; rw/rh are in original frame pixels.
    const outW = Math.max(rw * 2, 64);
    const outH = Math.max(rh * 2, 64);

    const { data, info } = await sharp(rawRgb, { raw: { width: frameWidth, height: frameHeight, channels: 3 } })
      .extract({ left: extractLeft, top: extractTop, width: extractW, height: extractH })
      .grayscale()
      .modulate(contrast !== 1 ? { brightness: 1 + brightness } : undefined)
      .normalize()
      .resize({ width: outW, height: outH, fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    return { data, width: info.width, height: info.height };
  }

  updateConfig(config: Partial<ImageProcessingConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
