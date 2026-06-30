import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { promises as fs } from 'fs';
import { VideoProcessor } from '../services/video-processor';
import { ExcelService } from '../services/excel.service';
import { ProcessingProgress, CalibrationData, DisplayRegion, ProcessingResult } from '../types';

// Em memória para esta demonstração. Em produção, usar banco de dados
const processingState = new Map<string, ProcessingProgress>();
const processedResults = new Map<string, ProcessingResult>();

export class VideoController {
  private excelService: ExcelService;
  private uploadsDir: string;

  constructor(uploadsDir: string = './uploads') {
    this.excelService = new ExcelService();
    this.uploadsDir = uploadsDir;
  }

  async uploadAndProcess(req: Request, res: Response): Promise<void> {
    const videoId = uuidv4();

    try {
      const files = (req as any).files;
      if (!files || !files.video) {
        res.status(400).json({ error: 'No video file provided' });
        return;
      }

      const videoFile = Array.isArray(files.video) ? files.video[0] : files.video;
      const uploadPath = path.join(this.uploadsDir, videoId + path.extname(videoFile.name));

      // Garantir que o diretório existe
      await fs.mkdir(this.uploadsDir, { recursive: true });

      // Salvar arquivo
      await videoFile.mv(uploadPath);

      // Inicializar progresso
      processingState.set(videoId, {
        videoId,
        currentFrame: 0,
        totalFrames: 0,
        percentage: 0,
        status: 'processing',
      });

      // Processar assincramente
      this.processVideoAsync(videoId, uploadPath);

      res.json({ videoId, message: 'Processing started' });
    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({ error: 'Upload failed' });
    }
  }

  private async processVideoAsync(videoId: string, videoPath: string): Promise<void> {
    try {
      let maxPercentage = 0;
      // A fresh instance per video keeps OCR session lifecycle and display-region
      // detection isolated — VideoController reuses itself across concurrent uploads.
      const videoProcessor = new VideoProcessor();
      const result = await videoProcessor.processVideo(videoPath, (progress, frame, total) => {
        maxPercentage = Math.max(maxPercentage, progress);
        const isExtracting = maxPercentage <= 50;
        processingState.set(videoId, {
          videoId,
          currentFrame: frame,
          totalFrames: total,
          percentage: maxPercentage,
          status: 'processing',
          message: isExtracting
            ? `Extraindo frames do vídeo...`
            : `Analisando frames com múltiplas threads paralelas...`,
        });
      });

      processedResults.set(videoId, result);

      processingState.set(videoId, {
        videoId,
        currentFrame: result.metadata.totalFrames,
        totalFrames: result.metadata.totalFrames,
        percentage: 100,
        status: 'completed',
      });

      // Limpar arquivo de vídeo após processamento
      await fs.unlink(videoPath).catch(() => {
        // Ignorar erros ao deletar
      });
    } catch (error) {
      console.error('Processing error:', error);

      processingState.set(videoId, {
        videoId,
        currentFrame: 0,
        totalFrames: 0,
        percentage: 0,
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  getProgress(req: Request, res: Response): void {
    const { videoId } = req.params;
    const progress = processingState.get(videoId);

    if (!progress) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }

    res.json(progress);
  }

  getResults(req: Request, res: Response): void {
    const { videoId } = req.params;
    const result = processedResults.get(videoId);

    if (!result) {
      res.status(404).json({ error: 'Results not found' });
      return;
    }

    res.json(result);
  }

  async exportExcel(req: Request, res: Response): Promise<void> {
    const { videoId } = req.params;
    const result = processedResults.get(videoId);

    if (!result) {
      res.status(404).json({ error: 'Results not found' });
      return;
    }

    try {
      const outputPath = path.join(this.uploadsDir, `${videoId}.xlsx`);
      await this.excelService.export(result, outputPath);

      res.download(outputPath, `${videoId}.xlsx`, (err) => {
        if (err) console.error('Download error:', err);

        // Limpar arquivo após download
        fs.unlink(outputPath).catch(() => {
          // Ignorar erros
        });
      });
    } catch (error) {
      console.error('Export error:', error);
      res.status(500).json({ error: 'Export failed' });
    }
  }

  getCalibration(req: Request, res: Response): void {
    // TODO: Implementar leitura de arquivo de calibração
    res.json({ calibration: null });
  }

  async saveCalibration(req: Request, res: Response): Promise<void> {
    const { displayRegion } = req.body;

    if (!displayRegion) {
      res.status(400).json({ error: 'Display region is required' });
      return;
    }

    try {
      const calibrationFile = path.join(this.uploadsDir, '..', 'calibration.json');
      const calibrationData: CalibrationData = {
        displayRegion,
        videoDimensions: { width: 1920, height: 1080 }, // TODO: Obter de req.body
        calibratedAt: new Date(),
      };

      await fs.mkdir(path.dirname(calibrationFile), { recursive: true });
      await fs.writeFile(calibrationFile, JSON.stringify(calibrationData, null, 2));

      res.json({ message: 'Calibration saved' });
    } catch (error) {
      console.error('Calibration error:', error);
      res.status(500).json({ error: 'Failed to save calibration' });
    }
  }
}
