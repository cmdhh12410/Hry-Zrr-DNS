import { Router } from '../../router';
import { successResponse, errorResponse } from '../../utils/response';
import { authMiddleware } from '../../middleware/auth';
import { hashPassword } from '../../utils/crypto';
import type { Env, UserRow } from '../../utils/types';

export function registerAdminUserRoutes(router: Router) {
  /**
   * GET /api/admin/users
   * 列出所有用户，支持分页、搜索和筛选 (需要管理员权限)
   */
  router.get('/api/admin/users', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const offset = (page - 1) * pageSize;
    const search = url.searchParams.get('search') || '';
    const status = url.searchParams.get('status');
    const role = url.searchParams.get('role');

    const conditions: string[] = [];
    const binds: (string | number)[] = [];

    if (search) {
      conditions.push('(u.username LIKE ? OR u.email LIKE ?)');
      binds.push(`%${search}%`, `%${search}%`);
    }

    if (status !== null && status !== '') {
      conditions.push('u.status = ?');
      binds.push(parseInt(status));
    }

    if (role) {
      conditions.push('u.role = ?');
      binds.push(role);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as total FROM users u ${whereClause}`
    ).bind(...binds).first<{ total: number }>();

    const total = countResult?.total || 0;

    const users = await env.DB.prepare(
      `SELECT u.id, u.username, u.email, u.phone, u.role, u.status, u.balance,
              u.max_domains, u.points, u.host_status, u.host_commission_rate,
              u.last_login_at, u.last_login_ip, u.created_at, u.updated_at,
              (SELECT COUNT(*) FROM subdomains WHERE user_id = u.id) as subdomain_count
       FROM users u
       ${whereClause}
       ORDER BY u.id DESC
       LIMIT ? OFFSET ?`
    ).bind(...binds, pageSize, offset).all();

    return successResponse({
      users: users.results,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize),
      },
    });
  });

  /**
   * GET /api/admin/users/:id
   * 获取用户详情，包含统计信息 (需要管理员权限)
   */
  router.get('/api/admin/users/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const userId = parseInt(params.id);
    if (isNaN(userId)) {
      return errorResponse('无效的用户ID');
    }

    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE id = ?'
    ).bind(userId).first<UserRow>();

    if (!user) {
      return errorResponse('用户不存在', 404);
    }

    const [subdomainCount, totalSpent, orderCount] = await Promise.all([
      env.DB.prepare(
        'SELECT COUNT(*) as count FROM subdomains WHERE user_id = ?'
      ).bind(userId).first<{ count: number }>(),
      env.DB.prepare(
        'SELECT COALESCE(SUM(final_amount), 0) as total FROM purchase_records WHERE user_id = ?'
      ).bind(userId).first<{ total: number }>(),
      env.DB.prepare(
        'SELECT COUNT(*) as count FROM purchase_records WHERE user_id = ?'
      ).bind(userId).first<{ count: number }>(),
    ]);

    return successResponse({
      user,
      stats: {
        subdomain_count: subdomainCount?.count || 0,
        total_spent: totalSpent?.total || 0,
        order_count: orderCount?.count || 0,
      },
    });
  });

  /**
   * PUT /api/admin/users/:id
   * 更新用户信息 (需要管理员权限)
   */
  router.put('/api/admin/users/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const userId = parseInt(params.id);
    if (isNaN(userId)) {
      return errorResponse('无效的用户ID');
    }

    const body = await request.json() as {
      status?: number;
      role?: string;
      balance?: number;
      max_domains?: number;
      points?: number;
      host_status?: string;
      host_commission_rate?: number;
    };

    const { status, role, balance, max_domains, points, host_status, host_commission_rate } = body;

    const updates: string[] = [];
    const binds: (string | number)[] = [];

    if (status !== undefined) {
      updates.push('status = ?');
      binds.push(status);
    }

    if (role !== undefined) {
      if (!['user', 'admin', 'demo'].includes(role)) {
        return errorResponse('无效的角色类型');
      }
      updates.push('role = ?');
      binds.push(role);
    }

    if (balance !== undefined) {
      if (typeof balance !== 'number' || balance < -1) {
        return errorResponse('无效的余额值');
      }
      updates.push('balance = ?');
      binds.push(balance);
    }

    if (max_domains !== undefined) {
      if (typeof max_domains !== 'number' || max_domains < 0) {
        return errorResponse('无效的最大域名数');
      }
      updates.push('max_domains = ?');
      binds.push(max_domains);
    }

    if (points !== undefined) {
      if (typeof points !== 'number' || points < 0) {
        return errorResponse('无效的积分数');
      }
      updates.push('points = ?');
      binds.push(points);
    }

    if (host_status !== undefined) {
      if (!['none', 'pending', 'approved', 'suspended'].includes(host_status)) {
        return errorResponse('无效的经销商状态');
      }
      updates.push('host_status = ?');
      binds.push(host_status);
    }

    if (host_commission_rate !== undefined) {
      if (typeof host_commission_rate !== 'number' || host_commission_rate < 0 || host_commission_rate > 100) {
        return errorResponse('佣金比例必须在0-100之间');
      }
      updates.push('host_commission_rate = ?');
      binds.push(host_commission_rate);
    }

    if (updates.length === 0) {
      return errorResponse('没有需要更新的字段');
    }

    updates.push("updated_at = datetime('now')");
    binds.push(userId);

    await env.DB.prepare(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...binds).run();

    return successResponse(null, '用户更新成功');
  });

  /**
   * PUT /api/admin/users/:id/password
   * 重置用户密码 (需要管理员权限)
   */
  router.put('/api/admin/users/:id/password', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const userId = parseInt(params.id);
    if (isNaN(userId)) {
      return errorResponse('无效的用户ID');
    }

    const body = await request.json() as {
      password: string;
    };

    const { password } = body;

    if (!password) {
      return errorResponse('密码不能为空');
    }

    if (password.length < 6) {
      return errorResponse('密码长度不能少于6个字符');
    }

    const hashed = await hashPassword(password);

    await env.DB.prepare(
      "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(hashed, userId).run();

    return successResponse(null, '密码重置成功');
  });

  /**
   * PUT /api/admin/users/:id/balance
   * 调整用户余额 (需要管理员权限)
   */
  router.put('/api/admin/users/:id/balance', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const userId = parseInt(params.id);
    if (isNaN(userId)) {
      return errorResponse('无效的用户ID');
    }

    const body = await request.json() as {
      amount: number;
      type: 'add' | 'deduct' | 'set';
      reason?: string;
    };

    const { amount, type, reason } = body;

    if (amount === undefined || amount === null) {
      return errorResponse('金额不能为空');
    }

    if (typeof amount !== 'number' || amount < 0) {
      return errorResponse('金额必须为非负数');
    }

    if (!['add', 'deduct', 'set'].includes(type)) {
      return errorResponse('操作类型无效，必须是 add、deduct 或 set');
    }

    const user = await env.DB.prepare(
      'SELECT balance FROM users WHERE id = ?'
    ).bind(userId).first<{ balance: number }>();

    if (!user) {
      return errorResponse('用户不存在', 404);
    }

    let newBalance: number;
    let changeAmount: number;

    switch (type) {
      case 'add':
        newBalance = user.balance === -1 ? amount : user.balance + amount;
        changeAmount = amount;
        break;
      case 'deduct':
        if (user.balance === -1) {
          return errorResponse('无限余额用户不能扣款');
        }
        if (user.balance < amount) {
          return errorResponse('余额不足');
        }
        newBalance = user.balance - amount;
        changeAmount = -amount;
        break;
      case 'set':
        newBalance = amount;
        changeAmount = amount - user.balance;
        break;
      default:
        return errorResponse('无效的操作类型');
    }

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE users SET balance = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(newBalance, userId),
      env.DB.prepare(
        `INSERT INTO balance_logs (user_id, amount, type, balance_before, balance_after, reason, operator_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(userId, changeAmount, type, user.balance, newBalance, reason || null, auth.user.user_id),
    ]);

    return successResponse({
      balance_before: user.balance,
      balance_after: newBalance,
      change: changeAmount,
      type,
    }, '余额调整成功');
  });

  /**
   * PUT /api/admin/users/:id/points
   * 调整用户积分 (需要管理员权限)
   */
  router.put('/api/admin/users/:id/points', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const userId = parseInt(params.id);
    if (isNaN(userId)) {
      return errorResponse('无效的用户ID');
    }

    const body = await request.json() as {
      points: number;
      type: 'add' | 'deduct' | 'set';
      description?: string;
    };

    const { points, type, description } = body;

    if (points === undefined || points === null) {
      return errorResponse('积分不能为空');
    }

    if (typeof points !== 'number' || points < 0) {
      return errorResponse('积分必须为非负数');
    }

    if (!['add', 'deduct', 'set'].includes(type)) {
      return errorResponse('操作类型无效，必须是 add、deduct 或 set');
    }

    const user = await env.DB.prepare(
      'SELECT points FROM users WHERE id = ?'
    ).bind(userId).first<{ points: number }>();

    if (!user) {
      return errorResponse('用户不存在', 404);
    }

    let newPoints: number;
    let changePoints: number;

    switch (type) {
      case 'add':
        newPoints = user.points + points;
        changePoints = points;
        break;
      case 'deduct':
        if (user.points < points) {
          return errorResponse('积分不足');
        }
        newPoints = user.points - points;
        changePoints = -points;
        break;
      case 'set':
        newPoints = points;
        changePoints = points - user.points;
        break;
      default:
        return errorResponse('无效的操作类型');
    }

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE users SET points = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(newPoints, userId),
      env.DB.prepare(
        `INSERT INTO point_records (user_id, points, type, points_before, points_after, description, operator_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(userId, changePoints, type, user.points, newPoints, description || null, auth.user.user_id),
    ]);

    return successResponse({
      points_before: user.points,
      points_after: newPoints,
      change: changePoints,
      type,
    }, '积分调整成功');
  });

  /**
   * DELETE /api/admin/users/:id
   * 删除用户（软删除，status 设为 0）(需要管理员权限)
   */
  router.delete('/api/admin/users/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const userId = parseInt(params.id);
    if (isNaN(userId)) {
      return errorResponse('无效的用户ID');
    }

    const user = await env.DB.prepare(
      'SELECT id FROM users WHERE id = ?'
    ).bind(userId).first<{ id: number }>();

    if (!user) {
      return errorResponse('用户不存在', 404);
    }

    await env.DB.prepare(
      "UPDATE users SET status = 0, updated_at = datetime('now') WHERE id = ?"
    ).bind(userId).run();

    return successResponse(null, '用户已删除');
  });
}