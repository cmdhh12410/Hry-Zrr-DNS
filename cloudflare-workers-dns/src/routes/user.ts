import { Router } from '../router';
import { successResponse, errorResponse } from '../utils/response';
import { authMiddleware } from '../middleware/auth';
import { generateRandomString } from '../utils/crypto';
import type { Env, UserRow, PurchaseRecordRow } from '../utils/types';

export function registerUserRoutes(router: Router) {
  /**
   * PUT /api/user/profile
   * 更新用户个人资料 (需要登录)
   */
  router.put('/api/user/profile', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const body = await request.json() as {
      username?: string;
    };

    const { username } = body;

    if (!username) {
      return errorResponse('用户名不能为空');
    }

    if (username.length < 2 || username.length > 50) {
      return errorResponse('用户名长度应为2-50个字符');
    }

    // 检查用户名是否已被占用
    const existing = await env.DB.prepare(
      'SELECT id FROM users WHERE username = ? AND id != ?'
    ).bind(username, auth.user.user_id).first();

    if (existing) {
      return errorResponse('用户名已被占用');
    }

    await env.DB.prepare(
      'UPDATE users SET username = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(username, auth.user.user_id).run();

    return successResponse({ username }, '个人资料更新成功');
  });

  /**
   * PUT /api/user/email
   * 修改邮箱 (需要登录)
   */
  router.put('/api/user/email', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const body = await request.json() as {
      email: string;
      code: string;
    };

    const { email, code } = body;

    if (!email || !code) {
      return errorResponse('邮箱和验证码不能为空');
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return errorResponse('邮箱格式不正确');
    }

    // 检查邮箱是否已被占用
    const emailTaken = await env.DB.prepare(
      'SELECT id FROM users WHERE email = ? AND id != ?'
    ).bind(email, auth.user.user_id).first();

    if (emailTaken) {
      return errorResponse('该邮箱已被其他账号绑定');
    }

    // 验证验证码
    const verification = await env.DB.prepare(
      "SELECT * FROM email_verifications WHERE email = ? AND code = ? AND type = 'change_email' AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
    ).bind(email, code).first<{ id: number }>();

    if (!verification) {
      return errorResponse('验证码无效或已过期');
    }

    // 更新邮箱并标记验证码已使用
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET email = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .bind(email, auth.user.user_id),
      env.DB.prepare('UPDATE email_verifications SET used = 1 WHERE id = ?')
        .bind(verification.id),
    ]);

    return successResponse({ email }, '邮箱修改成功');
  });

  /**
   * PUT /api/user/phone
   * 绑定/修改手机号 (需要登录)
   */
  router.put('/api/user/phone', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const body = await request.json() as {
      phone: string;
      code: string;
    };

    const { phone, code } = body;

    if (!phone || !code) {
      return errorResponse('手机号和验证码不能为空');
    }

    const phoneRegex = /^1[3-9]\d{9}$/;
    if (!phoneRegex.test(phone)) {
      return errorResponse('手机号格式不正确');
    }

    // 检查手机号是否已被占用
    const phoneTaken = await env.DB.prepare(
      'SELECT id FROM users WHERE phone = ? AND id != ?'
    ).bind(phone, auth.user.user_id).first();

    if (phoneTaken) {
      return errorResponse('该手机号已被其他账号绑定');
    }

    // 验证短信验证码
    const verification = await env.DB.prepare(
      "SELECT * FROM sms_verifications WHERE phone = ? AND code = ? AND type = 'bind_phone' AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
    ).bind(phone, code).first<{ id: number }>();

    if (!verification) {
      return errorResponse('验证码无效或已过期');
    }

    // 更新手机号并标记验证码已使用
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET phone = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .bind(phone, auth.user.user_id),
      env.DB.prepare('UPDATE sms_verifications SET used = 1 WHERE id = ?')
        .bind(verification.id),
    ]);

    return successResponse({ phone: phone.slice(0, 3) + '****' + phone.slice(-4) }, '手机号绑定成功');
  });

  /**
   * GET /api/user/api-keys
   * 获取 API Key 信息 (需要登录)
   */
  router.get('/api/user/api-keys', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const user = await env.DB.prepare(
      'SELECT api_key, api_enabled, api_ip_whitelist FROM users WHERE id = ?'
    ).bind(auth.user.user_id).first<{ api_key: string | null; api_enabled: number; api_ip_whitelist: string | null }>();

    if (!user) {
      return errorResponse('用户不存在', 404);
    }

    let apiIpWhitelist: string[] = [];
    if (user.api_ip_whitelist) {
      try {
        apiIpWhitelist = JSON.parse(user.api_ip_whitelist) as string[];
      } catch { /* ignore */ }
    }

    return successResponse({
      api_key: user.api_key,
      api_enabled: user.api_enabled === 1,
      api_ip_whitelist: apiIpWhitelist,
    });
  });

  /**
   * POST /api/user/api-keys
   * 生成新的 API Key (需要登录)
   */
  router.post('/api/user/api-keys', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const apiKey = 'ak_' + generateRandomString(32);
    const apiSecret = 'as_' + generateRandomString(48);

    await env.DB.prepare(
      'UPDATE users SET api_key = ?, api_secret = ?, api_enabled = 1, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(apiKey, apiSecret, auth.user.user_id).run();

    return successResponse({
      api_key: apiKey,
      api_secret: apiSecret,
    }, 'API Key 生成成功');
  });

  /**
   * PUT /api/user/api-keys
   * 更新 API 设置 (需要登录)
   */
  router.put('/api/user/api-keys', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const body = await request.json() as {
      api_enabled?: boolean;
      api_ip_whitelist?: string[];
    };

    const { api_enabled, api_ip_whitelist } = body;

    const updates: string[] = [];
    const binds: (string | number)[] = [];

    if (api_enabled !== undefined) {
      updates.push('api_enabled = ?');
      binds.push(api_enabled ? 1 : 0);
    }

    if (api_ip_whitelist !== undefined) {
      if (!Array.isArray(api_ip_whitelist)) {
        return errorResponse('IP白名单格式不正确');
      }
      updates.push('api_ip_whitelist = ?');
      binds.push(JSON.stringify(api_ip_whitelist));
    }

    if (updates.length === 0) {
      return errorResponse('没有需要更新的字段');
    }

    updates.push("updated_at = datetime('now')");
    binds.push(auth.user.user_id);

    await env.DB.prepare(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...binds).run();

    return successResponse(null, 'API 设置更新成功');
  });

  /**
   * GET /api/user/security
   * 获取安全设置 (需要登录)
   */
  router.get('/api/user/security', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const user = await env.DB.prepare(
      'SELECT totp_enabled, allowed_ips, last_login_at, last_login_ip FROM users WHERE id = ?'
    ).bind(auth.user.user_id).first<{
      totp_enabled: number;
      allowed_ips: string | null;
      last_login_at: string | null;
      last_login_ip: string | null;
    }>();

    if (!user) {
      return errorResponse('用户不存在', 404);
    }

    let allowedIps: string[] = [];
    if (user.allowed_ips) {
      try {
        allowedIps = JSON.parse(user.allowed_ips) as string[];
      } catch { /* ignore */ }
    }

    return successResponse({
      totp_enabled: user.totp_enabled === 1,
      allowed_ips: allowedIps,
      last_login: {
        at: user.last_login_at,
        ip: user.last_login_ip,
      },
    });
  });

  /**
   * PUT /api/user/security/ips
   * 更新允许的 IP 列表 (需要登录)
   */
  router.put('/api/user/security/ips', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const body = await request.json() as {
      ips: string[];
    };

    const { ips } = body;

    if (!ips || !Array.isArray(ips)) {
      return errorResponse('IP列表格式不正确');
    }

    // 验证每个 IP 格式
    for (const ip of ips) {
      if (typeof ip !== 'string' || ip.trim().length === 0) {
        return errorResponse('IP地址格式不正确');
      }
    }

    const ipsJson = JSON.stringify(ips);

    await env.DB.prepare(
      "UPDATE users SET allowed_ips = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(ipsJson, auth.user.user_id).run();

    return successResponse({ ips }, 'IP白名单更新成功');
  });

  /**
   * GET /api/user/orders
   * 获取用户购买记录 (需要登录)
   */
  router.get('/api/user/orders', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const offset = (page - 1) * pageSize;

    const totalResult = await env.DB.prepare(
      'SELECT COUNT(*) as total FROM purchase_records WHERE user_id = ?'
    ).bind(auth.user.user_id).first<{ total: number }>();

    const total = totalResult?.total || 0;

    const orders = await env.DB.prepare(
      'SELECT * FROM purchase_records WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).bind(auth.user.user_id, pageSize, offset).all<PurchaseRecordRow>();

    return successResponse({
      orders: orders.results,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize),
      },
    });
  });

  /**
   * GET /api/user/balance
   * 获取余额信息 (需要登录)
   */
  router.get('/api/user/balance', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const user = await env.DB.prepare(
      'SELECT balance, points FROM users WHERE id = ?'
    ).bind(auth.user.user_id).first<{ balance: number; points: number }>();

    if (!user) {
      return errorResponse('用户不存在', 404);
    }

    const transactionsResult = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM purchase_records WHERE user_id = ?'
    ).bind(auth.user.user_id).first<{ count: number }>();

    return successResponse({
      balance: user.balance,
      balance_text: user.balance === -1 ? '无限' : `¥${user.balance}`,
      points: user.points,
      transactions: transactionsResult?.count || 0,
    });
  });
}