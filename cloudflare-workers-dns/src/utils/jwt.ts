import { SignJWT, jwtVerify } from 'jose';
import type { Env } from './types';

export interface JwtPayload {
  user_id: number;
  username: string;
  email: string;
  role: 'user' | 'admin' | 'demo';
  exp?: number;
}

// 全局缓存 env，让没有 env 参数的函数也能访问
let _env: Env | null = null;

export function setEnv(env: Env) {
  _env = env;
}

const getSecret = () => {
  const secret = _env?.JWT_SECRET || 'jwt-secret-key-change-me';
  return new TextEncoder().encode(secret);
};

const getExpiresIn = () => {
  const val = _env?.JWT_ACCESS_TOKEN_EXPIRES;
  return val ? parseInt(val) : 86400;
};

export async function createToken(payload: Omit<JwtPayload, 'exp'>): Promise<string> {
  const expiresIn = getExpiresIn();
  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)
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
