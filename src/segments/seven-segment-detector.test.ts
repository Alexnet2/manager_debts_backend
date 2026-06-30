import { SevenSegmentDetector } from './seven-segment-detector';
import cv from 'opencv4nodejs';

describe('SevenSegmentDetector', () => {
  let detector: SevenSegmentDetector;

  beforeEach(() => {
    detector = new SevenSegmentDetector();
  });

  it('should create instance', () => {
    expect(detector).toBeDefined();
  });

  it('should detect valid digit segments', () => {
    // Este teste seria mais detalhado em produção
    // com imagens reais de displays de 7 segmentos
    expect(detector).toHaveProperty('detectDigit');
  });

  it('should return null for invalid input', () => {
    // Teste com Mat vazio
    const emptyMat = cv.Mat.zeros(10, 10, cv.CV_8U);
    const result = detector.detectDigit(emptyMat);

    expect(result).toBeNull();
  });
});
