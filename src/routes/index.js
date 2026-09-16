import { Router } from 'express';
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

export const router = Router();

router.get('/status', (req, res) => {
  res.json({ name: 'nailsbymandisa-api', status: 'ok' });
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
