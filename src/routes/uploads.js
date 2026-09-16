import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.js';
import { uploadLimiter } from '../middleware/rateLimit.js';
import { uploadImage } from '../config/cloudinaryClient.js';
import { badRequest } from '../utils/AppError.js';

export const router = Router();

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) return cb(badRequest('Only JPEG, PNG, WEBP or GIF images are allowed.'));
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
