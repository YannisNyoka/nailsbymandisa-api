// Thrown deliberately by services/routes for expected failure cases (validation,
// not-found, forbidden, conflict). The error handler trusts `message` on these to be
// safe to show a client; anything else gets a generic message in production.
export class AppError extends Error {
  constructor(message, statusCode = 400, code) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }
}

export const notFound = (resource = 'Resource') => new AppError(`${resource} not found`, 404, 'NOT_FOUND');
export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError(message, 403, 'FORBIDDEN');
export const unauthorized = (message = 'Authentication required') => new AppError(message, 401, 'UNAUTHORIZED');
export const conflict = (message) => new AppError(message, 409, 'CONFLICT');
export const badRequest = (message) => new AppError(message, 400, 'BAD_REQUEST');
