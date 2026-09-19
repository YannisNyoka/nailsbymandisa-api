import { Router } from 'express';
import multer from 'multer';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { uploadLimiter } from '../middleware/rateLimit.js';
import { uploadImage, uploadVideo } from '../config/cloudinaryClient.js';
import { PERMISSIONS } from '../config/constants.js';
import { badRequest } from '../utils/AppError.js';

export const router = Router();

const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) return cb(badRequest('Only JPEG, PNG, WEBP or GIF images are allowed.'));
    cb(null, true);
  },
});

const ALLOWED_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB — the hero video autoplays muted/looped, so it's meant to be short anyway

const uploadVideoFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_VIDEO_MIME_TYPES.has(file.mimetype)) return cb(badRequest('Only MP4, WEBM or MOV videos are allowed.'));
    cb(null, true);
  },
});

// Any authenticated user can upload (a customer submitting a before/after photo, or an
// admin posting to the curated gallery) — both eventually go through the same moderation/
// publish flow those features already have, this just replaces "paste a URL you hosted
// elsewhere" with an actual file picker (§4.9/§4.12 gap-fix).
router.post('/image', authenticate, uploadLimiter, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw badRequest('No file was uploaded.');
    const result = await uploadImage(req.file.buffer, { folder: 'nailsbymandisa/gallery' });
    res.status(201).json({ url: result.secure_url });
  } catch (err) {
    next(err);
  }
});

// Admin-only (unlike /image above) — the only caller is the home page hero editor
// (§gap-fix: hero video used to be "paste a URL you hosted elsewhere" only), and video
// storage/bandwidth is more expensive to leave open to every authenticated user than
// image uploads already are.
router.post(
  '/video',
  authenticate,
  requirePermission(PERMISSIONS.MANAGE_SETTINGS),
  uploadLimiter,
  uploadVideoFile.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) throw badRequest('No file was uploaded.');
      const result = await uploadVideo(req.file.buffer, { folder: 'nailsbymandisa/hero' });
      res.status(201).json({ url: result.secure_url });
    } catch (err) {
      next(err);
    }
  }
);
