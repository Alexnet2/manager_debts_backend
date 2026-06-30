import FFmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import path from 'path';
import { ConfigService, VideoProcessingConfig } from './config.service';

export interface FrameMetadata {
  fps: number;
  width: number;
  height: number;
  totalFrames: number;
  duration: number;
}

export class FrameService {
  private config: VideoProcessingConfig;

  constructor(configService: ConfigService) {
    this.config = configService.getVideoProcessingConfig();
  }

  // fluent-ffmpeg flattens the Display Matrix side_data onto the stream object as
  // `rotation` (newer ffmpeg/phones); older containers use the `tags.rotate` field
  // instead. Normalizes to one of 0/90/180/270.
  private getRotationDegrees(videoStream: any): number {
    const raw = videoStream.rotation ?? parseFloat(videoStream.tags?.rotate || '0');
    return ((Math.round(raw / 90) * 90) % 360 + 360) % 360;
  }

  async getVideoMetadata(videoPath: string): Promise<FrameMetadata> {
    return new Promise((resolve, reject) => {
      FFmpeg(videoPath).ffprobe((err, data) => {
        if (err) {
          reject(new Error(`Failed to probe video: ${err.message}`));
          return;
        }

        const videoStream = data.streams.find((s: any) => s.codec_type === 'video');
        if (!videoStream) {
          reject(new Error('No video stream found'));
          return;
        }

        const fpsStr = String(videoStream.r_frame_rate || '30/1');
        const fpsParts = fpsStr.split('/');
        const fps = parseFloat(fpsParts[0]) / parseFloat(fpsParts[1]);
        const duration = parseFloat(String(data.format.duration || '0'));

        // ffmpeg auto-rotates raw frame output to match the stream's rotation tag,
        // but ffprobe's width/height are the pre-rotation coded dimensions. A 90/270
        // rotation swaps the dimensions ffmpeg actually emits; if we don't mirror that
        // swap here, extractFramesRawPipe's frameSize math silently misreads every row
        // (same total byte count, wrong stride), shearing every extracted frame.
        const rotation = this.getRotationDegrees(videoStream);
        const rotated = Math.abs(rotation) === 90 || Math.abs(rotation) === 270;
        const width = (rotated ? videoStream.height : videoStream.width) || 1920;
        const height = (rotated ? videoStream.width : videoStream.height) || 1080;

        resolve({
          fps,
          width,
          height,
          duration,
          totalFrames: Math.floor(duration * fps),
        });
      });
    });
  }

  async extractFrames(
    videoPath: string,
    outputDir: string,
    onProgress?: (progress: number, currentFrame: number, totalFrames: number) => void,
  ): Promise<{ frames: string[]; metadata: FrameMetadata }> {
    const metadata = await this.getVideoMetadata(videoPath);
    await fs.mkdir(outputDir, { recursive: true });

    const framePattern = path.join(outputDir, 'frame_%06d.png');
    const frameInterval = this.config.frameInterval || 1;
    const fps = metadata.fps / frameInterval;

    return new Promise((resolve, reject) => {
      FFmpeg(videoPath)
        .outputOptions([
          `-vf fps=${fps}`,
          '-f image2',
        ])
        .output(framePattern)
        .on('progress', (progress: any) => {
          if (onProgress && progress.frames) {
            const currentFrame = Math.min(progress.frames, metadata.totalFrames);
            const progressPercent = Math.min(Math.round((currentFrame / metadata.totalFrames) * 100), 100);
            onProgress(progressPercent, currentFrame, metadata.totalFrames);
          }
        })
        .on('end', async () => {
          try {
            const files = await fs.readdir(outputDir);
            const frames = files
              .filter((f) => f.endsWith('.png'))
              .sort()
              .map((f) => path.join(outputDir, f));

            if (frames.length === 0) {
              reject(new Error('No frames were extracted'));
              return;
            }

            const limitedFrames = this.config.maxFrames
              ? frames.slice(0, this.config.maxFrames)
              : frames;

            resolve({
              frames: limitedFrames,
              metadata: {
                ...metadata,
                totalFrames: limitedFrames.length,
              },
            });
          } catch (error) {
            reject(error);
          }
        })
        .on('error', (err: Error) => {
          reject(new Error(`FFmpeg error: ${err.message}`));
        })
        .run();
    });
  }

  /**
   * Streams frame paths via callback as FFmpeg writes them, enabling pipeline
   * processing to start before all frames are extracted. Uses a 2-frame safety
   * buffer to ensure files are fully flushed before signalling.
   */
  async extractFramesPipelined(
    videoPath: string,
    outputDir: string,
    metadata: FrameMetadata,
    onFrame: (framePath: string, frameIndex: number) => void,
    onProgress?: (progress: number, currentFrame: number, totalFrames: number) => void,
  ): Promise<number> {
    await fs.mkdir(outputDir, { recursive: true });

    const framePattern = path.join(outputDir, 'frame_%06d.png');
    const frameInterval = this.config.frameInterval || 1;
    const ffmpegFps = metadata.fps / frameInterval;
    let lastEmitted = 0;

    const emitFramesUpTo = (count: number): void => {
      const limited = this.config.maxFrames ? Math.min(count, this.config.maxFrames) : count;
      for (let i = lastEmitted; i < limited; i++) {
        const fname = `frame_${String(i + 1).padStart(6, '0')}.png`;
        onFrame(path.join(outputDir, fname), i);
      }
      lastEmitted = limited;
    };

    return new Promise((resolve, reject) => {
      FFmpeg(videoPath)
        .outputOptions([`-vf fps=${ffmpegFps}`, '-f image2'])
        .output(framePattern)
        .on('progress', (progress: any) => {
          if (progress.frames > 2) {
            // 2-frame safety buffer: the frame being written may not be flushed yet
            const safe = Math.min(progress.frames - 2, metadata.totalFrames);
            emitFramesUpTo(safe);
            onProgress?.(
              Math.min(Math.round((progress.frames / metadata.totalFrames) * 100), 99),
              progress.frames,
              metadata.totalFrames,
            );
          }
        })
        .on('end', async () => {
          try {
            const files = await fs.readdir(outputDir);
            const total = files.filter((f) => f.endsWith('.png')).length;
            emitFramesUpTo(total);
            onProgress?.(100, lastEmitted, lastEmitted);
            resolve(lastEmitted);
          } catch (e) {
            reject(e);
          }
        })
        .on('error', (err: Error) => reject(new Error(`FFmpeg error: ${err.message}`)))
        .run();
    });
  }

  /**
   * Streams frames directly from FFmpeg as raw RGB24 buffers via stdout pipe.
   * No frame files are written to disk. The onFrame callback is awaited before
   * the next frame is consumed, so the caller controls backpressure: if all
   * processing slots are full, FFmpeg's OS pipe buffer fills up and it naturally
   * pauses until a slot frees.
   */
  async extractFramesRawPipe(
    videoPath: string,
    metadata: FrameMetadata,
    onFrame: (rawRgb: Buffer, frameIndex: number) => Promise<void>,
    onProgress?: (progress: number, currentFrame: number, totalFrames: number) => void,
  ): Promise<number> {
    const ffmpegFps = this.config.targetSampleFps || 5;
    const frameSize = metadata.width * metadata.height * 3; // rgb24: 3 bytes per pixel
    const maxFrames = this.config.maxFrames;
    const estimatedFrames = Math.round(metadata.duration * ffmpegFps);

    const command = FFmpeg(videoPath)
      .inputOptions(['-loglevel', 'error'])
      .outputOptions([`-vf fps=${ffmpegFps}`, '-pix_fmt rgb24'])
      .format('rawvideo');

    // pipe() without args returns a PassThrough connected to stdout and starts the command
    const proc = command.pipe() as unknown as AsyncIterable<Buffer>;

    let frameIndex = 0;
    let remainder = Buffer.alloc(0);

    try {
      for await (const chunk of proc) {
        const combined = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
        let offset = 0;

        while (offset + frameSize <= combined.length) {
          if (maxFrames !== undefined && frameIndex >= maxFrames) break;

          // subarray shares memory with combined; combined stays alive until after onFrame resolves
          const frameBuffer = combined.subarray(offset, offset + frameSize);
          offset += frameSize;

          await onFrame(frameBuffer, frameIndex);
          frameIndex++;

          if (onProgress && estimatedFrames > 0) {
            onProgress(
              Math.min(Math.round((frameIndex / estimatedFrames) * 100), 99),
              frameIndex,
              estimatedFrames,
            );
          }
        }

        remainder = offset < combined.length ? Buffer.from(combined.subarray(offset)) : Buffer.alloc(0);

        if (maxFrames !== undefined && frameIndex >= maxFrames) break;
      }
    } catch (err) {
      throw new Error(`FFmpeg pipe error: ${err instanceof Error ? err.message : String(err)}`);
    }

    onProgress?.(100, frameIndex, frameIndex);
    return frameIndex;
  }

  async cleanupFrames(frameDir: string): Promise<void> {
    try {
      const files = await fs.readdir(frameDir);
      await Promise.all(files.map((f) => fs.unlink(path.join(frameDir, f))));
      await fs.rmdir(frameDir);
    } catch (error) {
      console.warn(`Failed to cleanup frames directory: ${error}`);
    }
  }
}
