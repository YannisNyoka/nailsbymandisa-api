import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDb, closeDb } from './config/db.js';
import { applySchemaValidation } from './models/validation.js';

async function main() {
  // §4.4 — webhook signature verification must fail closed. If the secret isn't
  // configured, env.js already refused to boot (JWT-style min-length/entropy check),
  // so by the time we get here YOCO_WEBHOOK_SECRET is guaranteed present.

  await connectDb();
  await applySchemaValidation();

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'nailsbymandisa API listening');
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
