import { verifyToken, extractToken, extractCookieToken } from '../utils/jwt';
import { errorResponse, getClientIP } from '../utils/response';
import type { JwtPayload } from '../utils/jwt';
import type { Env } from '../utils/types';

export interface AuthContext {
  user: JwtPayload;
  isAdmin: boolean;
  isDemo: boolean;
}

/**
 * JWT 认证中间件 - 验证 Bearer Token 或 Cookie
 */
export async function authMiddleware(
  request: Request,
  env: Env,
  requireAdmin = false
): Promise<AuthContext | Response> {
  // 检查 IP 黑名单
  const clientIP = getClientIP(request);
  const blacklist = await env.KV.get(`ip_blacklist:${clientIP}`);
  if (blacklist) {
    return errorResponse('IP已被封禁', 403);
  }

  const token = extractToken(request) || extractCookieToken(request);
  if (!token) {
    return errorResponse('缺少认证Token', 401);
  }

  const payload = await verifyToken(token);
  if (!payload) {
    return errorResponse('Token已过期或无效', 401);
  }

  // 检查用户是否存在且状态正常
  const user = await env.DB.prepare(
    'SELECT id, status FROM users WHERE id = ?'
  ).bind(payload.user_id).first<{ id: number; status: number }>();

  if (!user) {
    return errorResponse('用户不存在', 401);
  }

  if (user.status === 0) {
    return errorResponse('账户已被封禁', 403);
  }

  if (user.status === 2) {
    return errorResponse('账户处于沉睡状态，请验证邮箱', 403);
  }

  // 管理员权限检查
  if (requireAdmin && payload.role !== 'admin') {
    return errorResponse('需要管理员权限', 403);
  }

  return {
    user: payload,
    isAdmin: payload.role === 'admin',
    isDemo: payload.role === 'demo',
  };
}

/**
 * API Key 认证中间件 (用于开放 API)
 */
export async function apiKeyAuthMiddleware(
  request: Request,
  env: Env
): Promise<AuthContext | Response> {
  const apiKey = request.headers.get('X-API-Key');
  const timestamp = request.headers.get('X-Timestamp');
  const signature = request.headers.get('X-Signature');

  if (!apiKey || !timestamp || !signature) {
    return errorResponse('缺少API认证参数', 401);
  }

  // 查找 API Key
  const user = await env.DB.prepare(
    'SELECT * FROM users WHERE api_key = ? AND api_enabled = 1'
  ).bind(apiKey).first<{ id: number; api_secret: string; api_ip_whitelist: string | null; status: number; role: string }>();

  if (!user) {
    return errorResponse('API Key无效或未启用', 401);
  }

  if (user.status !== 1) {
    return errorResponse('账户状态异常', 403);
  }

  // 验证 IP 白名单
  if (user.api_ip_whitelist) {
    try {
      const whitelist = JSON.parse(user.api_ip_whitelist) as string[];
      const clientIP = getClientIP(request);
      if (whitelist.length > 0 && !whitelist.includes(clientIP)) {
        return errorResponse('IP不在白名单中', 403);
      }
    } catch { /* ignore */ }
  }

  // 验证签名 (5分钟有效)
  const ts = parseInt(timestamp);
  if (Math.abs(Date.now() / 1000 - ts) > 300) {
    return errorResponse('签名已过期', 401);
  }

  const url = new URL(request.url);
  const message = `${timestamp}${request.method.toUpperCase()}${url.pathname}${url.search}`;
  const { hmacSign } = await import('../utils/crypto');
  const expectedSig = await hmacSign(message, user.api_secret);

  if (signature !== expectedSig) {
    return errorResponse('签名验证失败', 401);
  }

  return {
    user: {
      user_id: user.id,
      username: '',
      email: '',
      role: user.role as 'user' | 'admin' | 'demo',
    },
    isAdmin: false,
    isDemo: false,
  };
}