export interface FrameReading {
  frame: number;
  time: number;
  db: number | null;
  confidence: number;
  method: 'segments' | 'ocr';
  raw: string;
}

export interface VideoMetadata {
  duration: number;
  fps: number;
  width: number;
  height: number;
  totalFrames: number;
}

export interface ProcessingResult {
  videoId: string;
  metadata: VideoMetadata;
  readings: FrameReading[];
  statistics: Statistics;
  processedAt: Date;
}

export interface Statistics {
  min: number;
  max: number;
  mean: number;
  median: number;
  stdDev: number;
  validReadings: number;
  totalReadings: number;
}

export interface CalibrationData {
  displayRegion: DisplayRegion;
  videoDimensions: {
    width: number;
    height: number;
  };
  calibratedAt: Date;
}

export interface DisplayRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProcessingProgress {
  videoId: string;
  currentFrame: number;
  totalFrames: number;
  percentage: number;
  status: 'processing' | 'completed' | 'failed';
  message?: string;
}
