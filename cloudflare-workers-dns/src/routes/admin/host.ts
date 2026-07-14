import { Router } from '../../router';
import { successResponse, errorResponse } from '../../utils/response';
import { authMiddleware } from '../../middleware/auth';

export function registerAdminHostRoutes(router: Router) {
  // ============================================================
  // 托管申请审核
  // ============================================================

  /**
   * GET /api/admin/host/applications
   * 获取托管申请列表（JOIN users），支持分页和状态筛选
   */
  router.get('/api/admin/host/applications', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const offset = (page - 1) * pageSize;
    const status = url.searchParams.get('status');

    const conditions: string[] = [];
    const binds: (string | number)[] = [];

    if (status) {
      conditions.push('a.status = ?');
      binds.push(status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as total FROM host_applications a ${whereClause}`
    ).bind(...binds).first<{ total: number }>();

    const total = countResult?.total || 0;

    const applications = await env.DB.prepare(
      `SELECT a.*, u.username, u.email
       FROM host_applications a
       LEFT JOIN users u ON a.user_id = u.id
       ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...binds, pageSize, offset).all();

    return successResponse({
      items: applications.results,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize),
      },
    });
  });

  /**
   * GET /api/admin/host/applications/:id
   * 获取托管申请详情（含用户信息）
   */
  router.get('/api/admin/host/applications/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (isNaN(id)) {
      return errorResponse('无效的申请ID');
    }

    const application = await env.DB.prepare(
      `SELECT a.*, u.username, u.email
       FROM host_applications a
       LEFT JOIN users u ON a.user_id = u.id
       WHERE a.id = ?`
    ).bind(id).first();

    if (!application) {
      return errorResponse('申请不存在', 404);
    }

    return successResponse(application);
  });

  /**
   * PUT /api/admin/host/applications/:id
   * 审核托管申请（批准/拒绝）
   */
  router.put('/api/admin/host/applications/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (isNaN(id)) {
      return errorResponse('无效的申请ID');
    }

    const application = await env.DB.prepare(
      'SELECT * FROM host_applications WHERE id = ?'
    ).bind(id).first<{ id: number; user_id: number; status: string }>();

    if (!application) {
      return errorResponse('申请不存在', 404);
    }

    if (application.status !== 'pending') {
      return errorResponse('该申请已处理', 400);
    }

    let body: { status?: string; admin_remark?: string };
    try {
      body = await request.json();
    } catch {
      return errorResponse('请求体格式错误');
    }

    const { status, admin_remark } = body;

    if (!status || !['approved', 'rejected'].includes(status)) {
      return errorResponse('状态值必须为 approved 或 rejected');
    }

    const now = new Date().toISOString();

    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `UPDATE host_applications SET status = ?, admin_remark = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ?`
      ).bind(status, admin_remark || null, auth.user.user_id, now, now, id),
    ];

    if (status === 'approved') {
      statements.push(
        env.DB.prepare(
          `UPDATE users SET host_status = 'approved', host_approved_at = ?, updated_at = datetime('now')
           WHERE id = ?`
        ).bind(now, application.user_id)
      );
    } else {
      statements.push(
        env.DB.prepare(
          `UPDATE users SET host_status = 'rejected', updated_at = datetime('now')
           WHERE id = ?`
        ).bind(application.user_id)
      );
    }

    await env.DB.batch(statements);

    return successResponse({ status, admin_remark }, status === 'approved' ? '申请已通过' : '申请已拒绝');
  });

  // ============================================================
  // 托管商管理
  // ============================================================

  /**
   * GET /api/admin/host/hosts
   * 列出已批准的托管商，支持分页和搜索，含统计数据
   */
  router.get('/api/admin/host/hosts', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const offset = (page - 1) * pageSize;
    const search = url.searchParams.get('search') || '';

    const conditions: string[] = ["u.host_status = 'approved'"];
    const binds: (string | number)[] = [];

    if (search) {
      conditions.push('(u.username LIKE ? OR u.email LIKE ?)');
      binds.push(`%${search}%`, `%${search}%`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as total FROM users u ${whereClause}`
    ).bind(...binds).first<{ total: number }>();

    const total = countResult?.total || 0;

    const hosts = await env.DB.prepare(
      `SELECT u.id, u.username, u.email, u.host_status, u.host_balance, u.host_commission_rate,
              u.host_approved_at, u.host_suspended_at, u.host_suspended_reason, u.created_at,
              (SELECT COUNT(*) FROM domains WHERE owner_id = u.id) as domain_count,
              (SELECT COUNT(*) FROM plans WHERE owner_id = u.id) as plan_count,
              (SELECT COUNT(*) FROM dns_channels WHERE owner_id = u.id) as channel_count,
              (SELECT COALESCE(SUM(host_earnings), 0) FROM host_transactions WHERE host_id = u.id) as total_earnings
       FROM users u
       ${whereClause}
       ORDER BY u.id DESC
       LIMIT ? OFFSET ?`
    ).bind(...binds, pageSize, offset).all();

    return successResponse({
      items: hosts.results,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize),
      },
    });
  });

  /**
   * GET /api/admin/host/hosts/:id
   * 获取托管商详情（含统计）
   */
  router.get('/api/admin/host/hosts/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const hostId = parseInt(params.id);
    if (isNaN(hostId)) {
      return errorResponse('无效的托管商ID');
    }

    const host = await env.DB.prepare(
      `SELECT u.id, u.username, u.email, u.host_status, u.host_balance, u.host_commission_rate,
              u.host_approved_at, u.host_suspended_at, u.host_suspended_reason, u.created_at,
              (SELECT COUNT(*) FROM domains WHERE owner_id = u.id) as domain_count,
              (SELECT COUNT(*) FROM plans WHERE owner_id = u.id) as plan_count,
              (SELECT COUNT(*) FROM dns_channels WHERE owner_id = u.id) as channel_count,
              (SELECT COALESCE(SUM(host_earnings), 0) FROM host_transactions WHERE host_id = u.id) as total_earnings,
              (SELECT COUNT(*) FROM host_transactions WHERE host_id = u.id) as transaction_count,
              (SELECT COUNT(*) FROM host_withdrawals WHERE host_id = u.id) as withdrawal_count,
              (SELECT COALESCE(SUM(amount), 0) FROM host_withdrawals WHERE host_id = u.id AND status = 'completed') as total_withdrawn
       FROM users u
       WHERE u.id = ?`
    ).bind(hostId).first();

    if (!host) {
      return errorResponse('托管商不存在', 404);
    }

    // 最近交易
    const recentTransactions = await env.DB.prepare(
      `SELECT ht.*, pr.subdomain_name
       FROM host_transactions ht
       LEFT JOIN purchase_records pr ON ht.purchase_record_id = pr.id
       WHERE ht.host_id = ?
       ORDER BY ht.created_at DESC
       LIMIT 10`
    ).bind(hostId).all();

    // 最近提现
    const recentWithdrawals = await env.DB.prepare(
      `SELECT * FROM host_withdrawals WHERE host_id = ? ORDER BY created_at DESC LIMIT 10`
    ).bind(hostId).all();

    return successResponse({
      ...host,
      recent_transactions: recentTransactions.results,
      recent_withdrawals: recentWithdrawals.results,
    });
  });

  /**
   * PUT /api/admin/host/hosts/:id
   * 更新托管商信息（状态、佣金率、暂停原因等）
   */
  router.put('/api/admin/host/hosts/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const hostId = parseInt(params.id);
    if (isNaN(hostId)) {
      return errorResponse('无效的托管商ID');
    }

    const user = await env.DB.prepare(
      'SELECT id, host_status FROM users WHERE id = ?'
    ).bind(hostId).first<{ id: number; host_status: string }>();

    if (!user) {
      return errorResponse('用户不存在', 404);
    }

    let body: { host_status?: string; host_commission_rate?: number; host_suspended_reason?: string };
    try {
      body = await request.json();
    } catch {
      return errorResponse('请求体格式错误');
    }

    const { host_status, host_commission_rate, host_suspended_reason } = body;

    const updates: string[] = [];
    const binds: (string | number | null)[] = [];
    const now = new Date().toISOString();

    if (host_status !== undefined) {
      const validStatuses = ['none', 'pending', 'approved', 'rejected', 'suspended', 'revoked'];
      if (!validStatuses.includes(host_status)) {
        return errorResponse(`无效的托管商状态，有效值为: ${validStatuses.join(', ')}`);
      }
      updates.push('host_status = ?');
      binds.push(host_status);

      if (host_status === 'suspended') {
        updates.push('host_suspended_at = ?');
        binds.push(now);
      }
    }

    if (host_commission_rate !== undefined) {
      if (typeof host_commission_rate !== 'number' || host_commission_rate < 0 || host_commission_rate > 100) {
        return errorResponse('佣金率必须在 0-100 之间');
      }
      updates.push('host_commission_rate = ?');
      binds.push(host_commission_rate);
    }

    if (host_suspended_reason !== undefined) {
      updates.push('host_suspended_reason = ?');
      binds.push(host_suspended_reason || null);
    }

    if (updates.length === 0) {
      return errorResponse('没有需要更新的字段');
    }

    updates.push("updated_at = datetime('now')");
    binds.push(hostId);

    await env.DB.prepare(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...binds).run();

    return successResponse(null, '托管商信息更新成功');
  });

  // ============================================================
  // 提现管理
  // ============================================================

  /**
   * GET /api/admin/host/withdrawals
   * 列出提现申请，支持分页和状态筛选
   */
  router.get('/api/admin/host/withdrawals', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const offset = (page - 1) * pageSize;
    const status = url.searchParams.get('status');

    const conditions: string[] = [];
    const binds: (string | number)[] = [];

    if (status) {
      conditions.push('w.status = ?');
      binds.push(status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as total FROM host_withdrawals w ${whereClause}`
    ).bind(...binds).first<{ total: number }>();

    const total = countResult?.total || 0;

    const withdrawals = await env.DB.prepare(
      `SELECT w.*, u.username, u.email, u.host_balance
       FROM host_withdrawals w
       LEFT JOIN users u ON w.host_id = u.id
       ${whereClause}
       ORDER BY w.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...binds, pageSize, offset).all();

    return successResponse({
      items: withdrawals.results,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize),
      },
    });
  });

  /**
   * PUT /api/admin/host/withdrawals/:id
   * 审核提现申请（批准/拒绝/完成）
   */
  router.put('/api/admin/host/withdrawals/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (isNaN(id)) {
      return errorResponse('无效的提现ID');
    }

    const withdrawal = await env.DB.prepare(
      'SELECT * FROM host_withdrawals WHERE id = ?'
    ).bind(id).first<{ id: number; host_id: number; amount: number; status: string }>();

    if (!withdrawal) {
      return errorResponse('提现申请不存在', 404);
    }

    if (withdrawal.status !== 'pending') {
      return errorResponse('该提现申请已处理', 400);
    }

    let body: { status?: string; admin_remark?: string };
    try {
      body = await request.json();
    } catch {
      return errorResponse('请求体格式错误');
    }

    const { status, admin_remark } = body;

    if (!status || !['approved', 'rejected', 'completed'].includes(status)) {
      return errorResponse('状态值必须为 approved、rejected 或 completed');
    }

    const now = new Date().toISOString();

    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `UPDATE host_withdrawals
         SET status = ?, admin_remark = ?, reviewed_by = ?, reviewed_at = ?,
             completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
             updated_at = ?
         WHERE id = ?`
      ).bind(status, admin_remark || null, auth.user.user_id, now, status, now, now, id),
    ];

    if (status === 'completed') {
      // 扣除托管商余额
      statements.push(
        env.DB.prepare(
          `UPDATE users SET host_balance = MAX(0, host_balance - ?), updated_at = datetime('now')
           WHERE id = ? AND host_balance >= ?`
        ).bind(withdrawal.amount, withdrawal.host_id, withdrawal.amount)
      );
    }

    await env.DB.batch(statements);

    return successResponse({ status, admin_remark }, status === 'completed' ? '提现已完成' : '提现审核已处理');
  });

  // ============================================================
  // 托管设置
  // ============================================================

  /**
   * GET /api/admin/host/settings
   * 获取托管相关设置（佣金率等）
   */
  router.get('/api/admin/host/settings', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const rows = await env.DB.prepare(
      `SELECT key, value FROM settings WHERE key LIKE 'host_%' ORDER BY key`
    ).all<{ key: string; value: string | null }>();

    const settings: Record<string, string | null> = {};
    for (const row of rows.results) {
      settings[row.key] = row.value;
    }

    return successResponse(settings);
  });

  /**
   * PUT /api/admin/host/settings
   * 更新托管设置
   */
  router.put('/api/admin/host/settings', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    let body: { host_commission_rate?: number };
    try {
      body = await request.json();
    } catch {
      return errorResponse('请求体格式错误');
    }

    const { host_commission_rate } = body;

    if (host_commission_rate === undefined) {
      return errorResponse('没有需要更新的设置项');
    }

    if (typeof host_commission_rate !== 'number' || host_commission_rate < 0 || host_commission_rate > 100) {
      return errorResponse('佣金率必须在 0-100 之间');
    }

    await env.DB.prepare(
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`
    ).bind('host_commission_rate', String(host_commission_rate)).run();

    return successResponse({ host_commission_rate }, '托管设置更新成功');
  });
}