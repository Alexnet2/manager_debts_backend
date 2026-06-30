import { Router } from 'express';
import { VideoController } from '../controllers/video-controller';

export function createVideoRoutes(uploadsDir: string): Router {
  const router = Router();
  const controller = new VideoController(uploadsDir);

  // Upload e iniciar processamento
  router.post('/upload', (req, res) => controller.uploadAndProcess(req, res));

  // Obter progresso do processamento
  router.get('/progress/:videoId', (req, res) => controller.getProgress(req, res));

  // Obter resultados do processamento
  router.get('/results/:videoId', (req, res) => controller.getResults(req, res));

  // Exportar para Excel
  router.get('/export/:videoId', (req, res) => controller.exportExcel(req, res));

  // Obter configuração de calibração
  router.get('/calibration', (req, res) => controller.getCalibration(req, res));

  // Salvar configuração de calibração
  router.post('/calibration', (req, res) => controller.saveCalibration(req, res));

  return router;
}
