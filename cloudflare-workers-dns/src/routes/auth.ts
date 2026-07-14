import { Router } from '../router';
import { successResponse, errorResponse, getClientIP } from '../utils/response';
import { createToken, verifyToken } from '../utils/jwt';
import { hashPassword, verifyPassword, generateVerifyCode, generateRandomString, generateInviteCode } from '../utils/crypto';
import { authMiddleware } from '../middleware/auth';
import type { Env, UserRow } from '../utils/types';

export function registerAuthRoutes(router: Router) {
  /**
   * POST /api/auth/register
   * 用户注册
   */
  router.post('/api/auth/register', async (request, env) => {
    const body = await request.json() as {
      username: string;
      email: string;
      password: string;
      invite_code?: string;
    };

    const { username, email, password, invite_code } = body;

    // 验证输入
    if (!username || !email || !password) {
      return errorResponse('用户名、邮箱和密码不能为空');
    }

    if (username.length < 2 || username.length > 50) {
      return errorResponse('用户名长度应为2-50个字符');
    }

    if (password.length < 6) {
      return errorResponse('密码长度至少6位');
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return errorResponse('邮箱格式不正确');
    }

    // 检查注册开关
    const registerEnabled = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'register_enabled'"
    ).first<{ value: string }>();
    if (registerEnabled && registerEnabled.value === '0') {
      return errorResponse('注册功能已关闭');
    }

    // 检查用户名和邮箱是否已存在
    const existing = await env.DB.prepare(
      'SELECT id FROM users WHERE username = ? OR email = ?'
    ).bind(username, email).first();

    if (existing) {
      return errorResponse('用户名或邮箱已被注册');
    }

    // 处理邀请码
    let inviterId: number | null = null;
    if (invite_code) {
      const inviter = await env.DB.prepare(
        'SELECT id FROM users WHERE invite_code = ?'
      ).bind(invite_code).first<{ id: number }>();
      if (inviter) {
        inviterId = inviter.id;
      }
    }

    // 创建用户
    const passwordHash = await hashPassword(password);
    const ip = getClientIP(request);
    const newInviteCode = generateInviteCode();

    const result = await env.DB.prepare(
      `INSERT INTO users (username, email, password_hash, invite_code, last_login_ip, last_login_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(username, email, passwordHash, newInviteCode, ip).run();

    const userId = result.meta.last_row_id;

    // 处理邀请奖励
    if (inviterId) {
      const inviteRewardPoints = parseInt(
        (await env.DB.prepare("SELECT value FROM settings WHERE key = 'invite_reward_points'").first<{ value: string }>())?.value || '100'
      );
      const inviteeRewardPoints = parseInt(
        (await env.DB.prepare("SELECT value FROM settings WHERE key = 'invitee_reward_points'").first<{ value: string }>())?.value || '50'
      );

      await env.DB.batch([
        env.DB.prepare(
          'INSERT INTO user_invites (inviter_id, invitee_id, invite_code, register_reward, invitee_reward) VALUES (?, ?, ?, ?, ?)'
        ).bind(inviterId, userId, invite_code!, inviteRewardPoints, inviteeRewardPoints),
        env.DB.prepare('UPDATE users SET points = points + ?, total_points = total_points + ? WHERE id = ?')
          .bind(inviteRewardPoints, inviteRewardPoints, inviterId),
        env.DB.prepare('UPDATE users SET points = points + ?, total_points = total_points + ? WHERE id = ?')
          .bind(inviteeRewardPoints, inviteeRewardPoints, userId),
      ]);
    }

    // 生成 Token
    const token = await createToken({
      user_id: userId,
      username,
      email,
      role: 'user',
    });

    return successResponse({
      token,
      user: {
        id: userId,
        username,
        email,
        role: 'user',
      },
    }, '注册成功');
  });

  /**
   * POST /api/auth/login
   * 用户登录 (支持邮箱+密码 或 用户名+密码)
   */
  router.post('/api/auth/login', async (request, env) => {
    const body = await request.json() as {
      account: string;
      password: string;
    };

    const { account, password } = body;

    if (!account || !password) {
      return errorResponse('账号和密码不能为空');
    }

    // 通过邮箱或用户名查找
    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE email = ? OR username = ?'
    ).bind(account, account).first<UserRow>();

    if (!user) {
      return errorResponse('账号或密码错误');
    }

    // 检查用户状态
    if (user.status === 0) {
      return errorResponse('账户已被封禁');
    }

    // 验证密码
    if (!user.password_hash) {
      return errorResponse('该账号未设置密码，请使用第三方登录');
    }

    const isValid = await verifyPassword(password, user.password_hash);
    if (!isValid) {
      return errorResponse('账号或密码错误');
    }

    // 更新登录信息
    const ip = getClientIP(request);
    await env.DB.prepare(
      `UPDATE users SET last_login_at = datetime('now'), last_login_ip = ?, login_count = login_count + 1, last_activity_at = datetime('now') WHERE id = ?`
    ).bind(ip, user.id).run();

    // 生成 Token
    const token = await createToken({
      user_id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    });

    return successResponse({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        balance: user.balance,
        points: user.points,
        max_domains: user.max_domains,
        verified: user.verified === 1,
        phone_bound: !!user.phone,
        totp_enabled: user.totp_enabled === 1,
      },
    }, '登录成功');
  });

  /**
   * POST /api/auth/send-code
   * 发送邮箱验证码
   */
  router.post('/api/auth/send-code', async (request, env) => {
    const body = await request.json() as {
      email: string;
      type: string;
    };

    const { email, type = 'register' } = body;

    if (!email) {
      return errorResponse('邮箱不能为空');
    }

    // 检查发送频率 (60秒内只能发一次)
    const recent = await env.DB.prepare(
      "SELECT id FROM email_verifications WHERE email = ? AND created_at > datetime('now', '-60 seconds')"
    ).bind(email).first();

    if (recent) {
      return errorResponse('请60秒后再试');
    }

    // 生成验证码
    const code = generateVerifyCode(6);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5分钟

    // 保存验证码
    await env.DB.prepare(
      'INSERT INTO email_verifications (email, code, type, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(email, code, type, expiresAt).run();

    // 发送邮件 (需要配置邮件服务)
    // 这里使用 Cloudflare 的 Mailchannels 或其他邮件服务
    // 暂时返回验证码 (开发环境)
    console.log(`[DEV] Verification code for ${email}: ${code}`);

    return successResponse({
      message: '验证码已发送',
      // 开发环境返回验证码，生产环境需删除此行
      code: code,
    }, '发送成功');
  });

  /**
   * POST /api/auth/verify-code
   * 验证邮箱验证码
   */
  router.post('/api/auth/verify-code', async (request, env) => {
    const body = await request.json() as {
      email: string;
      code: string;
      type: string;
    };

    const { email, code, type = 'register' } = body;

    const verification = await env.DB.prepare(
      "SELECT * FROM email_verifications WHERE email = ? AND code = ? AND type = ? AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
    ).bind(email, code, type).first<{ id: number; email: string }>();

    if (!verification) {
      return errorResponse('验证码无效或已过期');
    }

    // 标记已使用
    await env.DB.prepare('UPDATE email_verifications SET used = 1 WHERE id = ?')
      .bind(verification.id).run();

    return successResponse({ verified: true }, '验证成功');
  });

  /**
   * POST /api/auth/reset-password
   * 重置密码
   */
  router.post('/api/auth/reset-password', async (request, env) => {
    const body = await request.json() as {
      email: string;
      code: string;
      password: string;
    };

    const { email, code, password } = body;

    if (!email || !code || !password) {
      return errorResponse('参数不完整');
    }

    if (password.length < 6) {
      return errorResponse('密码长度至少6位');
    }

    // 验证验证码
    const verification = await env.DB.prepare(
      "SELECT * FROM email_verifications WHERE email = ? AND code = ? AND type = 'reset_password' AND used = 0 AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
    ).bind(email, code).first<{ id: number }>();

    if (!verification) {
      return errorResponse('验证码无效或已过期');
    }

    // 更新密码
    const passwordHash = await hashPassword(password);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = ? WHERE email = ?')
        .bind(passwordHash, email),
      env.DB.prepare('UPDATE email_verifications SET used = 1 WHERE id = ?')
        .bind(verification.id),
    ]);

    return successResponse(null, '密码重置成功');
  });

  /**
   * GET /api/auth/me
   * 获取当前用户信息
   */
  router.get('/api/auth/me', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(auth.user.user_id).first<UserRow>();

    if (!user) {
      return errorResponse('用户不存在', 404);
    }

    return successResponse({
      id: user.id,
      username: user.username,
      email: user.email,
      phone: user.phone ? user.phone.slice(0, 3) + '****' + user.phone.slice(-4) : null,
      role: user.role,
      status: user.status,
      balance: user.balance,
      balance_text: user.balance === -1 ? '无限' : `¥${user.balance}`,
      points: user.points,
      total_points: user.total_points,
      max_domains: user.max_domains,
      verified: user.verified === 1,
      phone_bound: !!user.phone,
      totp_enabled: user.totp_enabled === 1,
      host_status: user.host_status,
      host_balance: user.host_balance,
      invite_code: user.invite_code,
      login_count: user.login_count,
      last_login_at: user.last_login_at,
      last_login_ip: user.last_login_ip,
      created_at: user.created_at,
      oauth_bindings: {
        github: !!user.github_id,
        google: !!user.google_id,
        nodeloc: !!user.nodeloc_id,
      },
    });
  });

  /**
   * PUT /api/auth/change-password
   * 修改密码 (需要登录)
   */
  router.put('/api/auth/change-password', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const body = await request.json() as {
      old_password: string;
      new_password: string;
    };

    const { old_password, new_password } = body;

    if (!old_password || !new_password) {
      return errorResponse('参数不完整');
    }

    if (new_password.length < 6) {
      return errorResponse('新密码长度至少6位');
    }

    const user = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
      .bind(auth.user.user_id).first<{ password_hash: string | null }>();

    if (!user) {
      return errorResponse('用户不存在', 404);
    }

    if (!user.password_hash) {
      return errorResponse('该账号未设置密码');
    }

    const isValid = await verifyPassword(old_password, user.password_hash);
    if (!isValid) {
      return errorResponse('原密码错误');
    }

    const newHash = await hashPassword(new_password);
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .bind(newHash, auth.user.user_id).run();

    return successResponse(null, '密码修改成功');
  });
}