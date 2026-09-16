const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

// Parses strings like "15m", "30d", "12h" (the same format used for JWT_*_TTL) into
// milliseconds, so refresh-token expiry can be computed without pulling in a dependency.
export function parseDurationMs(input) {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(input.trim());
  if (!match) throw new Error(`Invalid duration string: ${input}`);
  const [, amount, unit] = match;
  return Number(amount) * UNIT_MS[unit];
}
