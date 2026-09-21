import { errorHandler } from '../../src/middleware/errorHandler.js';

function fakeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

describe('errorHandler', () => {
  it('normalizes a BSONError into a clean 400', () => {
    const err = new Error('bad id');
    err.name = 'BSONError';
    const res = fakeRes();
    errorHandler(err, {}, res, () => {});
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ID');
  });

  it('normalizes a MulterError file-size rejection into a clean 400', () => {
    const err = new Error('File too large');
    err.name = 'MulterError';
    err.code = 'LIMIT_FILE_SIZE';
    const res = fakeRes();
    errorHandler(err, {}, res, () => {});
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toBe('That file is too large.');
  });

  // Regression: Cloudinary's SDK rejects with a plain object carrying `http_code: 400`
  // (not a real Error's `statusCode`) when the uploaded file itself is invalid — e.g. an
  // unsupported/corrupt video. This used to fall through to the generic 500 branch,
  // hiding a legitimate "your file is the problem" response behind "Internal Server
  // Error" — found via a real video upload in routes/uploads.js.
  it('normalizes a Cloudinary http_code:400 rejection into a clean 400, not a 500', () => {
    const err = { message: 'Unsupported video format or file', http_code: 400, name: 'Error' };
    const res = fakeRes();
    errorHandler(err, {}, res, () => {});
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toBe('Unsupported video format or file');
    expect(res.body.error.code).toBe('UPLOAD_REJECTED');
  });

  it('does not pass through a Cloudinary-shaped error with a non-400 http_code (e.g. bad credentials) as if it were the caller\'s fault', () => {
    const err = { message: 'Invalid API key', http_code: 401, name: 'Error' };
    const res = fakeRes();
    errorHandler(err, {}, res, () => {});
    expect(res.statusCode).toBe(500);
  });

  // Regression for a real production incident: a genuine ~18MB video upload hit
  // Cloudinary's own SDK-level timeout (`http_code: 499, name: 'TimeoutError'`) at the
  // ~2-minute mark. This used to fall through to a generic, unhelpful 500 — now it's a
  // clean 504 with a message that tells the admin what actually happened.
  it('normalizes a Cloudinary upload timeout (http_code 499) into a clean 504, not a 500', () => {
    const err = { message: 'Request Timeout', http_code: 499, name: 'TimeoutError' };
    const res = fakeRes();
    errorHandler(err, {}, res, () => {});
    expect(res.statusCode).toBe(504);
    expect(res.body.error.code).toBe('UPLOAD_TIMEOUT');
  });

  it('falls back to a generic 500 for an unrecognized error', () => {
    const res = fakeRes();
    errorHandler(new Error('something unexpected'), {}, res, () => {});
    expect(res.statusCode).toBe(500);
  });
});
