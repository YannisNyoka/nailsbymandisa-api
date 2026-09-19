import { isProd } from '../config/env.js';
import { logger } from '../config/logger.js';

// A malformed :id route param (anything not a 24-char hex string) throws BSONError from
// `new ObjectId(...)` deep in a service function — every route with an :id param is
// exposed to this, so it's handled once here rather than validated per-route (§5.6/§6.2:
// one input-shape rule, not dozens of copies of it). Without this it would otherwise
// reach the generic 500 branch below as an unoperational error.
function normalizeError(err) {
  if (err.name === 'BSONError' || err.name === 'BSONTypeError') {
    const wrapped = new Error('Invalid id format.');
    wrapped.statusCode = 400;
    wrapped.code = 'INVALID_ID';
    wrapped.isOperational = true;
    return wrapped;
  }
  // multer throws its own error class for oversized/malformed uploads (routes/uploads.js)
  // — without this it reaches the generic 500 branch below as an unoperational error.
  // No fixed MB figure in the message: routes/uploads.js has two different size limits
  // (image vs video), and multer's error doesn't carry which one was configured.
  if (err.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : 'Could not process the uploaded file.';
    const wrapped = new Error(message);
    wrapped.statusCode = 400;
    wrapped.code = err.code;
    wrapped.isOperational = true;
    return wrapped;
  }
  // Cloudinary's SDK rejects with a plain object carrying `http_code: 400` (not
  // `statusCode`) when the uploaded file itself is the problem — e.g. an unsupported/
  // corrupt video — rather than a real Error instance. Without this it reaches the
  // generic 500 branch below even though it's the caller's file at fault, not ours
  // (found via a real upload in routes/uploads.js's video endpoint returning a bare 500
  // for a bad file). Only 400 specifically is passed through this way — other Cloudinary
  // codes (401 bad credentials, 5xx their own outage) are our problem, not the
  // uploader's, and should stay in the generic 500 branch rather than surface confusingly
  // as if the admin's own request/session were at fault.
  if (err.http_code === 400 && err.message) {
    const wrapped = new Error(err.message);
    wrapped.statusCode = 400;
    wrapped.code = 'UPLOAD_REJECTED';
    wrapped.isOperational = true;
    return wrapped;
  }
  return err;
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(rawErr, req, res, next) {
  const err = normalizeError(rawErr);
  const statusCode = err.statusCode || 500;
  const isOperational = err.isOperational === true;

  req.log?.error({ err, statusCode }, err.message) ?? logger.error({ err, statusCode }, err.message);

  const body = {
    error: {
      message: isOperational || !isProd ? err.message : 'Something went wrong. Please try again.',
      code: err.code,
    },
  };

  if (!isProd && !isOperational) {
    body.error.stack = err.stack;
  }

  res.status(statusCode).json(body);
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { message: 'Route not found', code: 'NOT_FOUND' } });
}
