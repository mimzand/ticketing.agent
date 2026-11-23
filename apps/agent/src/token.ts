import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Fresh session token: 32 CSPRNG bytes, base64url (43 characters). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Constant-time comparison. Both sides are hashed first, so the comparison runs
 * over equal-length digests and the time does not depend on where or whether the
 * inputs differ, nor on their lengths.
 */
export function tokensEqual(received: string, expected: string): boolean {
  const a = createHash('sha256').update(received, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
