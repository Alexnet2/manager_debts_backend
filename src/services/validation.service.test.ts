import { ValidationService } from './validation.service';
import { ConfigService } from './config.service';
import { FrameReading } from '../types';

describe('ValidationService', () => {
  let validationService: ValidationService;
  let configService: ConfigService;

  beforeEach(() => {
    configService = new ConfigService();
    validationService = new ValidationService(configService);
  });

  describe('validateReadings', () => {
    it('should filter out null values', () => {
      const readings: FrameReading[] = [
        { frame: 0, time: 0, db: 100, confidence: 90, method: 'segments', raw: '100' },
        { frame: 1, time: 0.033, db: null, confidence: 0, method: 'ocr', raw: '' },
        { frame: 2, time: 0.066, db: 101, confidence: 85, method: 'segments', raw: '101' },
      ];

      const result = validationService.validateReadings(readings);

      expect(result).toHaveLength(2);
      expect(result.every((r) => r.db !== null)).toBe(true);
    });

    it('should filter out NaN values', () => {
      const readings: FrameReading[] = [
        { frame: 0, time: 0, db: 100, confidence: 90, method: 'segments', raw: '100' },
        { frame: 1, time: 0.033, db: NaN, confidence: 50, method: 'ocr', raw: 'invalid' },
        { frame: 2, time: 0.066, db: 101, confidence: 85, method: 'segments', raw: '101' },
      ];

      const result = validationService.validateReadings(readings);

      expect(result).toHaveLength(2);
      expect(result.every((r) => !isNaN(r.db!))).toBe(true);
    });

    it('should filter out values outside valid range', () => {
      const readings: FrameReading[] = [
        { frame: 0, time: 0, db: -5, confidence: 90, method: 'segments', raw: '-5' },
        { frame: 1, time: 0.033, db: 100, confidence: 85, method: 'segments', raw: '100' },
        { frame: 2, time: 0.066, db: 150, confidence: 80, method: 'segments', raw: '150' },
      ];

      const result = validationService.validateReadings(readings);

      expect(result).toHaveLength(1);
      expect(result[0].db).toBe(100);
    });

    it('should remove consecutive duplicates when enabled', () => {
      const readings: FrameReading[] = [
        { frame: 0, time: 0, db: 100, confidence: 90, method: 'segments', raw: '100' },
        { frame: 1, time: 0.033, db: 100, confidence: 90, method: 'segments', raw: '100' },
        { frame: 2, time: 0.066, db: 101, confidence: 85, method: 'segments', raw: '101' },
        { frame: 3, time: 0.1, db: 101, confidence: 85, method: 'segments', raw: '101' },
      ];

      const result = validationService.validateReadings(readings);

      expect(result).toHaveLength(2);
      expect(result[0].db).toBe(100);
      expect(result[1].db).toBe(101);
    });
  });
});
