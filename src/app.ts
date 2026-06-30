import express from 'express';
import cors from 'cors';
import fileUpload from 'express-fileupload';
import dotenv from 'dotenv';
import { createVideoRoutes } from './routes/video-routes';

dotenv.config();

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';

const allowedOrigins = (
  process.env.FRONTEND_URL || 'http://localhost:4200,https://reading-metrics-db.vercel.app'
)
  .split(',')
  .map((o) => o.trim());

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

const app = express();

app.options('*', cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json());
app.use(fileUpload({ limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '500000000') } }));

const videoRoutes = createVideoRoutes(UPLOAD_DIR);
app.use('/api/video', videoRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export { app, UPLOAD_DIR };
