import { corsHeaders } from '../utils/response';
import type { Env } from '../utils/types';

/**
 * Rate Limiter 使用 Workers KV 实现
 */
export async function rateLimiter(
  request: Request,
  env: Env,
  maxRequests: number = 60,
  windowSeconds: number = 60
): Promise<Response | null> {
  const url = new URL(request.url);
  const clientIP = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const key = `rate_limit:${clientIP}:${url.pathname}`;

  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - windowSeconds;

  // 获取当前计数
  const record = await env.KV.get(key, 'json') as { count: number; resetAt: number } | null;

  if (record && record.resetAt > now) {
    if (record.count >= maxRequests) {
      return new Response(JSON.stringify({
        code: 429,
        message: '请求过于频繁，请稍后再试',
        error: 'rate_limited',
        retryAfter: record.resetAt - now,
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Retry-After': String(record.resetAt - now),
          ...corsHeaders(),
        },
      });
    }
    record.count++;
    await env.KV.put(key, JSON.stringify(record), { expirationTtl: windowSeconds });
  } else {
    await env.KV.put(key, JSON.stringify({ count: 1, resetAt: now + windowSeconds }), { expirationTtl: windowSeconds });
  }

  return null; // 未触发限流
}