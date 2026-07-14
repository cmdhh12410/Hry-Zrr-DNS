import { SignJWT, jwtVerify } from 'jose';

export interface JwtPayload {
  user_id: number;
  username: string;
  email: string;
  role: 'user' | 'admin' | 'demo';
  exp?: number;
}

const getSecret = () => {
  // 使用环境变量或默认值
  const secret = typeof JWT_SECRET !== 'undefined' ? JWT_SECRET : 'jwt-secret-key-change-me';
  return new TextEncoder().encode(secret);
};

const EXPIRES_IN = typeof JWT_ACCESS_TOKEN_EXPIRES !== 'undefined'
  ? parseInt(JWT_ACCESS_TOKEN_EXPIRES)
  : 86400;

export async function createToken(payload: Omit<JwtPayload, 'exp'>): Promise<string> {
  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${EXPIRES_IN}s`)
    .sign(getSecret());
  return token;
}

export async function verifyToken(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as unknown as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * 从请求中提取 Bearer Token
 */
export function extractToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * 从 Cookie 中提取 Token
 */
export function extractCookieToken(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/token=([^;]+)/);
  return match ? match[1] : null;
}