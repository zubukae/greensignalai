import jwt, { JwtPayload } from 'jsonwebtoken';
import { randomBytes } from 'crypto';

const configuredJwtSecret = process.env.JWT_SECRET;
if (process.env.NODE_ENV === 'production' && !configuredJwtSecret) {
  throw new Error('JWT_SECRET must be configured in production.');
}

export const JWT_SECRET = configuredJwtSecret || randomBytes(32).toString('hex');

export interface AuthTokenPayload extends JwtPayload {
  userId: string;
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (typeof payload === 'string' || typeof payload.userId !== 'string') {
      return null;
    }
    return payload as AuthTokenPayload;
  } catch {
    return null;
  }
}
