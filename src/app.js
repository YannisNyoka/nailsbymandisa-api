import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { router as apiRouter } from './routes/index.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false,
    })
  );

  // §5.9 — CORS locked to real frontend origin(s), driven by validated required config.
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
    })
  );

  app.use(compression());
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  // Stripe/Yoco-style webhooks need the raw body for signature verification — mounted
  // before the JSON body parser, scoped to just that route, in routes/payments.js.
  app.use((req, res, next) => {
    if (req.path === '/api/payments/webhook') return next();
    express.json({ limit: '1mb' })(req, res, next);
  });

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
