import { ConfigService } from './config.service';
import { OnnxOcrService, OcrResult } from '../ocr/onnx-ocr.service';

export type { OcrResult };

/**
 * Public OCR façade — same interface as the removed Tesseract implementation.
 * VideoProcessor calls initialize() / readNumber() / terminate() unchanged.
 */
export class OcrService {
  private readonly onnx: OnnxOcrService;
  private initialized = false;

  constructor(configService: ConfigService) {
    const { modelPath, workerCount } = configService.getOcrConfig();
    this.onnx = new OnnxOcrService(modelPath, workerCount);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.onnx.initialize();
    this.initialized = true;
  }

  async readNumber(imageBuffer: Buffer): Promise<OcrResult> {
    if (!this.initialized) await this.initialize();
    return this.onnx.readNumber(imageBuffer);
  }

  async terminate(): Promise<void> {
    await this.onnx.terminate();
    this.initialized = false;
  }
}
