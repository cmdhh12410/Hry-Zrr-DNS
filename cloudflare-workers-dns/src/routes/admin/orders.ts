import { Router } from '../../router';
import { successResponse, errorResponse } from '../../utils/response';
import { authMiddleware } from '../../middleware/auth';
import { generateRandomString } from '../../utils/crypto';

export function registerAdminOrderRoutes(router: Router) {
  /**
   * GET /api/admin/orders
   * 列出所有购买记录 (需要管理员权限)
   * Query: ?page=1&page_size=20&user_id=&domain_id=&search=
   */
  router.get('/api/admin/orders', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const userId = url.searchParams.get('user_id') || '';
    const domainId = url.searchParams.get('domain_id') || '';
    const search = url.searchParams.get('search') || '';

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (userId) {
      conditions.push('pr.user_id = ?');
      params.push(parseInt(userId));
    }
    if (domainId) {
      conditions.push('pr.domain_id = ?');
      params.push(parseInt(domainId));
    }
    if (search) {
      conditions.push('(pr.subdomain_name LIKE ? OR u.username LIKE ? OR u.email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const [ordersResult, totalResult] = await Promise.all([
      env.DB.prepare(
        `SELECT
          pr.id,
          pr.user_id,
          pr.subdomain_id,
          pr.domain_id,
          pr.amount,
          pr.discount_amount,
          pr.final_amount,
          pr.subdomain_name,
          pr.created_at,
          u.username,
          u.email,
          u.role,
          u.status as user_status,
          s.name as subdomain_name_current,
          s.full_name as subdomain_full_name,
          s.status as subdomain_status,
          c.code as coupon_code,
          c.name as coupon_name,
          c.type as coupon_type,
          c.value as coupon_value
        FROM purchase_records pr
        LEFT JOIN users u ON pr.user_id = u.id
        LEFT JOIN subdomains s ON pr.subdomain_id = s.id
        LEFT JOIN coupons c ON pr.coupon_id = c.id
        ${whereClause}
        ORDER BY pr.created_at DESC
        LIMIT ? OFFSET ?`
      ).bind(...params, pageSize, offset).all(),
      env.DB.prepare(
        `SELECT COUNT(*) as total
        FROM purchase_records pr
        LEFT JOIN users u ON pr.user_id = u.id
        ${whereClause}`
      ).bind(...params).first<{ total: number }>(),
    ]);

    const orders = (ordersResult.results as Record<string, unknown>[]).map((row) => ({
      id: row.id,
      user: {
        id: row.user_id,
        username: row.username,
        email: row.email,
        role: row.role,
        status: row.user_status,
      },
      subdomain: row.subdomain_id ? {
        id: row.subdomain_id,
        name: row.subdomain_name_current,
        full_name: row.subdomain_full_name,
        status: row.subdomain_status,
      } : null,
      amount: row.amount,
      discount_amount: row.discount_amount,
      final_amount: row.final_amount,
      coupon: row.coupon_code ? {
        code: row.coupon_code,
        name: row.coupon_name,
        type: row.coupon_type,
        value: row.coupon_value,
      } : null,
      created_at: row.created_at,
    }));

    return successResponse({
      orders,
      pagination: {
        page,
        page_size: pageSize,
        total: totalResult?.total || 0,
        total_pages: Math.ceil((totalResult?.total || 0) / pageSize),
      },
    });
  });

  /**
   * GET /api/admin/orders/:id
   * 获取订单详情 (需要管理员权限)
   */
  router.get('/api/admin/orders/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const orderId = parseInt(params.id);
    if (isNaN(orderId)) {
      return errorResponse('订单ID无效');
    }

    const order = await env.DB.prepare(
      `SELECT
        pr.id,
        pr.user_id,
        pr.subdomain_id,
        pr.domain_id,
        pr.plan_id,
        pr.amount,
        pr.discount_amount,
        pr.final_amount,
        pr.subdomain_name,
        pr.created_at,
        u.username,
        u.email,
        u.role,
        u.status as user_status,
        s.name as subdomain_name_current,
        s.full_name as subdomain_full_name,
        s.status as subdomain_status,
        c.code as coupon_code,
        c.name as coupon_name,
        c.type as coupon_type,
        c.value as coupon_value,
        d.name as domain_name,
        p.name as plan_name,
        p.price as plan_price
      FROM purchase_records pr
      LEFT JOIN users u ON pr.user_id = u.id
      LEFT JOIN subdomains s ON pr.subdomain_id = s.id
      LEFT JOIN coupons c ON pr.coupon_id = c.id
      LEFT JOIN domains d ON pr.domain_id = d.id
      LEFT JOIN plans p ON pr.plan_id = p.id
      WHERE pr.id = ?`
    ).bind(orderId).first<Record<string, unknown>>();

    if (!order) {
      return errorResponse('订单不存在', 404);
    }

    return successResponse({
      order: {
        id: order.id,
        user: {
          id: order.user_id,
          username: order.username,
          email: order.email,
          role: order.role,
          status: order.user_status,
        },
        subdomain: order.subdomain_id ? {
          id: order.subdomain_id,
          name: order.subdomain_name_current,
          full_name: order.subdomain_full_name,
          status: order.subdomain_status,
        } : null,
        domain: order.domain_id ? {
          id: order.domain_id,
          name: order.domain_name,
        } : null,
        plan: order.plan_id ? {
          id: order.plan_id,
          name: order.plan_name,
          price: order.plan_price,
        } : null,
        amount: order.amount,
        discount_amount: order.discount_amount,
        final_amount: order.final_amount,
        subdomain_name: order.subdomain_name,
        coupon: order.coupon_code ? {
          code: order.coupon_code,
          name: order.coupon_name,
          type: order.coupon_type,
          value: order.coupon_value,
        } : null,
        created_at: order.created_at,
      },
    });
  });

  // ==================== 兑换码管理 ====================

  /**
   * GET /api/admin/redeem-codes
   * 列出兑换码 (需要管理员权限)
   * Query: ?page=1&page_size=20&status=1&batch_id=&search=
   */
  router.get('/api/admin/redeem-codes', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const status = url.searchParams.get('status');
    const batchId = url.searchParams.get('batch_id') || '';
    const search = url.searchParams.get('search') || '';

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (status !== null && status !== '') {
      conditions.push('rc.status = ?');
      params.push(parseInt(status));
    }
    if (batchId) {
      conditions.push('rc.batch_id = ?');
      params.push(batchId);
    }
    if (search) {
      conditions.push('(rc.code LIKE ? OR rc.batch_id LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const [codesResult, totalResult] = await Promise.all([
      env.DB.prepare(
        `SELECT
          rc.id,
          rc.code,
          rc.amount,
          rc.status,
          rc.batch_id,
          rc.created_by,
          rc.used_by,
          rc.used_at,
          rc.created_at,
          rc.updated_at,
          cu.username as created_by_name,
          uu.username as used_by_name
        FROM redeem_codes rc
        LEFT JOIN users cu ON rc.created_by = cu.id
        LEFT JOIN users uu ON rc.used_by = uu.id
        ${whereClause}
        ORDER BY rc.created_at DESC
        LIMIT ? OFFSET ?`
      ).bind(...params, pageSize, offset).all(),
      env.DB.prepare(
        `SELECT COUNT(*) as total FROM redeem_codes rc ${whereClause}`
      ).bind(...params).first<{ total: number }>(),
    ]);

    const codes = (codesResult.results as Record<string, unknown>[]).map((row) => ({
      id: row.id,
      code: row.code,
      amount: row.amount,
      status: row.status,
      batch_id: row.batch_id,
      created_by: row.created_by_name || null,
      used_by: row.used_by_name || null,
      used_at: row.used_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    return successResponse({
      codes,
      pagination: {
        page,
        page_size: pageSize,
        total: totalResult?.total || 0,
        total_pages: Math.ceil((totalResult?.total || 0) / pageSize),
      },
    });
  });

  /**
   * POST /api/admin/redeem-codes
   * 生成兑换码 (需要管理员权限)
   * Body: { amount, count, batch_id? }
   */
  router.post('/api/admin/redeem-codes', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const body = await request.json() as {
      amount: number;
      count: number;
      batch_id?: string;
    };

    const { amount, count, batch_id } = body;

    if (!amount || amount <= 0) {
      return errorResponse('兑换金额必须大于0');
    }
    if (!count || count <= 0 || count > 1000) {
      return errorResponse('生成数量必须在1-1000之间');
    }

    const batchId = batch_id || `BATCH_${Date.now()}`;
    const codes: string[] = [];

    // 生成兑换码
    for (let i = 0; i < count; i++) {
      const code = generateRandomString(16).toUpperCase();
      codes.push(code);
    }

    // 批量插入
    const stmt = env.DB.prepare(
      `INSERT INTO redeem_codes (code, amount, status, batch_id, created_by, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, datetime('now'), datetime('now'))`
    );

    const batch = codes.map((code) => stmt.bind(code, amount, batchId, auth.user.user_id));
    await env.DB.batch(batch);

    return successResponse({
      batch_id: batchId,
      count,
      codes,
    }, '兑换码生成成功');
  });

  /**
   * GET /api/admin/redeem-codes/export
   * 导出兑换码为文本 (需要管理员权限)
   * Query: ?batch_id=
   * 注意: 此路由必须在 /api/admin/redeem-codes/:id 之前注册
   */
  router.get('/api/admin/redeem-codes/export', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const batchId = url.searchParams.get('batch_id') || '';

    if (!batchId) {
      return errorResponse('batch_id 不能为空');
    }

    const result = await env.DB.prepare(
      `SELECT code FROM redeem_codes WHERE batch_id = ? ORDER BY id ASC`
    ).bind(batchId).all<{ code: string }>();

    const text = result.results.map((r) => r.code).join('\n');

    return new Response(text, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="redeem_codes_${batchId}.txt"`,
      },
    });
  });

  /**
   * PUT /api/admin/redeem-codes/:id
   * 更新兑换码状态 (需要管理员权限)
   * Body: { status }
   */
  router.put('/api/admin/redeem-codes/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const codeId = parseInt(params.id);
    if (isNaN(codeId)) {
      return errorResponse('兑换码ID无效');
    }

    const body = await request.json() as { status: number };
    const { status } = body;

    if (status === undefined || status === null || ![0, 1, 2].includes(status)) {
      return errorResponse('状态值无效，必须为 0(未使用), 1(已使用), 2(已禁用)');
    }

    const existing = await env.DB.prepare(
      'SELECT id FROM redeem_codes WHERE id = ?'
    ).bind(codeId).first();

    if (!existing) {
      return errorResponse('兑换码不存在', 404);
    }

    await env.DB.prepare(
      `UPDATE redeem_codes SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(status, codeId).run();

    return successResponse(null, '兑换码状态更新成功');
  });

  /**
   * DELETE /api/admin/redeem-codes/:id
   * 删除兑换码 (需要管理员权限)
   */
  router.delete('/api/admin/redeem-codes/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const codeId = parseInt(params.id);
    if (isNaN(codeId)) {
      return errorResponse('兑换码ID无效');
    }

    const existing = await env.DB.prepare(
      'SELECT id FROM redeem_codes WHERE id = ?'
    ).bind(codeId).first();

    if (!existing) {
      return errorResponse('兑换码不存在', 404);
    }

    await env.DB.prepare(
      'DELETE FROM redeem_codes WHERE id = ?'
    ).bind(codeId).run();

    return successResponse(null, '兑换码已删除');
  });
}