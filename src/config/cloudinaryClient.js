import { v2 as cloudinary } from 'cloudinary';
import { env } from './env.js';
import { AppError } from '../utils/AppError.js';

// Optional — image storage for the gallery (§4.9/§4.12 gap-fix: uploads were URL-paste
// only until this). CLOUDINARY_* are optional env vars (see .env.example); when unset,
// uploadImage() throws a clear, documented error instead of a confusing failure deeper
// in cloudinary's SDK, same "no silent pretend-success" rule as sendMail()/sendSms().
const isConfigured = Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

if (isConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export async function uploadImage(buffer, { folder }) {
  if (!isConfigured) {
    throw new AppError(
      'Image uploads are not configured yet — ask an admin to set CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET.',
      503,
      'UPLOADS_NOT_CONFIGURED'
    );
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder, resource_type: 'image' }, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    stream.end(buffer);
  });
}
