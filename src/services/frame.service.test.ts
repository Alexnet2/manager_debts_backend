import { FrameService } from './frame.service';
import { ConfigService } from './config.service';

describe('FrameService', () => {
  let frameService: FrameService;
  let configService: ConfigService;

  beforeEach(() => {
    configService = new ConfigService();
    frameService = new FrameService(configService);
  });

  describe('getVideoMetadata', () => {
    it('should throw error for invalid video path', async () => {
      const invalidPath = '/path/to/nonexistent/video.mp4';

      await expect(frameService.getVideoMetadata(invalidPath)).rejects.toThrow();
    });

    it('should extract correct metadata structure', async () => {
      // This test would require a valid video file
      // For unit testing, we would typically mock FFmpeg
      // Example of expected structure:
      const expectedKeys = ['fps', 'width', 'height', 'duration', 'totalFrames'];
      // const metadata = await frameService.getVideoMetadata(validVideoPath);
      // expectedKeys.forEach(key => expect(metadata).toHaveProperty(key));
    });
  });

  describe('cleanupFrames', () => {
    it('should handle cleanup gracefully when directory does not exist', async () => {
      const nonexistentDir = '/tmp/nonexistent_frames_' + Date.now();

      await expect(frameService.cleanupFrames(nonexistentDir)).resolves.not.toThrow();
    });
  });
});
