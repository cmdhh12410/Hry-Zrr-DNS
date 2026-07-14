/**
 * Workers KV 存储工具
 * 用于会话管理、缓存、配置等
 */
import type { Env, SettingRow } from '../utils/types';

/**
 * 设置缓存 (从 KV 读取，减少 D1 查询)
 */
export async function getSetting(env: Env, key: string, defaultValue: string = ''): Promise<string> {
  const cacheKey = `setting:${key}`;
  const cached = await env.KV.get(cacheKey);
  if (cached !== null) return cached;

  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key).first<SettingRow>();

  const value = row?.value ?? defaultValue;
  await env.KV.put(cacheKey, value, { expirationTtl: 3600 }); // 缓存1小时
  return value;
}

/**
 * 批量获取设置
 */
export async function getSettings(env: Env, keys: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const uncached: string[] = [];

  for (const key of keys) {
    const cached = await env.KV.get(`setting:${key}`);
    if (cached !== null) {
      result[key] = cached;
    } else {
      uncached.push(key);
    }
  }

  if (uncached.length > 0) {
    const placeholders = uncached.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT key, value FROM settings WHERE key IN (${placeholders})`
    ).bind(...uncached).all<SettingRow>();

    for (const row of rows.results) {
      result[row.key] = row.value || '';
      await env.KV.put(`setting:${row.key}`, row.value || '', { expirationTtl: 3600 });
    }

    for (const key of uncached) {
      if (!(key in result)) {
        result[key] = '';
      }
    }
  }

  return result;
}

/**
 * 清除设置缓存
 */
export async function clearSettingCache(env: Env, key?: string): Promise<void> {
  if (key) {
    await env.KV.delete(`setting:${key}`);
  } else {
    // 清除所有设置缓存 (需要列出所有 key)
    const list = await env.KV.list({ prefix: 'setting:' });
    for (const item of list.keys) {
      await env.KV.delete(item.name);
    }
  }
}

/**
 * 会话管理 (基于 KV 的简单 session)
 */
export async function createSession(env: Env, userId: number, data: Record<string, unknown>): Promise<string> {
  const sessionId = crypto.randomUUID();
  const sessionData = {
    user_id: userId,
    ...data,
    created_at: Date.now(),
  };
  await env.KV.put(`session:${sessionId}`, JSON.stringify(sessionData), { expirationTtl: 86400 });
  return sessionId;
}

export async function getSession(env: Env, sessionId: string): Promise<Record<string, unknown> | null> {
  const data = await env.KV.get(`session:${sessionId}`);
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await env.KV.delete(`session:${sessionId}`);
}

/**
 * 限流计数
 */
export async function incrementRateLimit(env: Env, key: string, windowSeconds: number): Promise<{ count: number; limited: boolean }> {
  const current = await env.KV.get(key);
  const count = current ? parseInt(current) + 1 : 1;

  if (count === 1) {
    await env.KV.put(key, '1', { expirationTtl: windowSeconds });
  } else {
    // D1 doesn't support increment, so we use get-set
    await env.KV.put(key, String(count), { expirationTtl: windowSeconds });
  }

  return { count, limited: false };
}

/**
 * 缓存 ARK (自动刷新缓存)
 */
export async function cacheWithTTL<T>(
  env: Env,
  key: string,
  ttl: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const cached = await env.KV.get(key, 'json');
  if (cached) return cached as T;

  const data = await fetcher();
  await env.KV.put(key, JSON.stringify(data), { expirationTtl: ttl });
  return data;
}

/**
 * 清除所有用户相关缓存
 */
export async function clearUserCache(env: Env, userId: number): Promise<void> {
  const list = await env.KV.list({ prefix: `user:${userId}:` });
  for (const item of list.keys) {
    await env.KV.delete(item.name);
  }
}