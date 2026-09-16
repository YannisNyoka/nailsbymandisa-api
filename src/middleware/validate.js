import { badRequest } from '../utils/AppError.js';

// §5.6 — input validation on every write endpoint, applied the same way everywhere via
// this one wrapper, rather than each route hand-rolling (and sometimes forgetting) checks.
export function validate(schema, part = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[part]);
    if (!result.success) {
      const message = result.error.issues.map((i) => `${i.path.join('.') || part}: ${i.message}`).join('; ');
      return next(badRequest(message));
    }
    req[part] = result.data;
    next();
  };
}
