const crypto = require('crypto');

// Constant-time string comparison for secrets and tokens. Hashing first gives
// equal-length buffers (timingSafeEqual requires that) and avoids leaking the
// expected value's length.
function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { secretMatches };
