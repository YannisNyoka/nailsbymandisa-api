import { Router } from 'express';
import { getDb } from '../config/db.js';
import { router as authRouter } from './auth.js';
import { router as settingsRouter } from './settings.js';
import { router as servicesRouter } from './services.js';
import { router as employeesRouter } from './employees.js';
import { router as availabilityRouter } from './availability.js';
import { router as appointmentsRouter } from './appointments.js';
import { router as paymentsRouter } from './payments.js';
import { router as notificationsRouter } from './notifications.js';
import { router as adminRouter } from './admin.js';
import { router as loyaltyRouter } from './loyalty.js';
import { router as referralsRouter } from './referrals.js';
import { router as discountCodesRouter } from './discountCodes.js';
import { router as giftCardsRouter } from './giftCards.js';
import { router as subscriptionsRouter } from './subscriptions.js';
import { router as galleryRouter } from './gallery.js';
import { router as clientGalleryRouter } from './clientGallery.js';
import { router as uploadsRouter } from './uploads.js';
import { router as cronRouter } from './cron.js';

export const router = Router();

// Process-alive check only — deliberately no DB round-trip, so it stays cheap and fast
// even under DB slowness. Point an uptime pinger here just to keep the dyno warm.
router.get('/status', (req, res) => {
  res.json({ name: 'nailsbymandisa-api', status: 'ok' });
});

// Real readiness check — also confirms MongoDB is actually reachable, not just that
// Express is listening. Point monitoring/alerting here instead of /status if you want to
// be told about a dropped DB connection, not just a dead process.
router.get('/health', async (req, res) => {
  try {
    await getDb().command({ ping: 1 });
    res.json({ name: 'nailsbymandisa-api', status: 'ok', db: 'ok' });
  } catch (err) {
    res.status(503).json({ name: 'nailsbymandisa-api', status: 'error', db: 'unreachable' });
  }
});

router.use('/auth', authRouter);
router.use('/settings', settingsRouter);
router.use('/services', servicesRouter);
router.use('/staff', employeesRouter);
router.use('/availability', availabilityRouter);
router.use('/appointments', appointmentsRouter);
router.use('/payments', paymentsRouter);
router.use('/notifications', notificationsRouter);
router.use('/admin', adminRouter);
router.use('/loyalty', loyaltyRouter);
router.use('/referrals', referralsRouter);
router.use('/discount-codes', discountCodesRouter);
router.use('/gift-cards', giftCardsRouter);
router.use('/subscriptions', subscriptionsRouter);
router.use('/gallery', galleryRouter);
router.use('/client-gallery', clientGalleryRouter);
router.use('/uploads', uploadsRouter);
router.use('/cron', cronRouter);
