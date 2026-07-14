import { Router } from '../../router';
import { successResponse, errorResponse } from '../../utils/response';
import { authMiddleware } from '../../middleware/auth';

export function registerAdminPlanRoutes(router: Router) {
  /**
   * GET /api/admin/plans
   * 列出所有套餐 (包括非活跃), 关联 plan_domains 获取域名名称
   */
  router.get('/api/admin/plans', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const plans = await env.DB.prepare(
      `SELECT p.*, GROUP_CONCAT(d.name) as domain_names
       FROM plans p
       LEFT JOIN plan_domains pd ON p.id = pd.plan_id
       LEFT JOIN domains d ON pd.domain_id = d.id
       GROUP BY p.id
       ORDER BY p.sort_order ASC, p.id ASC`
    ).all();

    const results = plans.results.map((plan: Record<string, unknown>) => ({
      ...plan,
      domain_names: plan.domain_names ? String(plan.domain_names).split(',') : [],
    }));

    return successResponse(results);
  });

  /**
   * POST /api/admin/plans
   * 创建套餐
   * Body: { name, price, duration_days, domain_ids: number[], min_length?, max_length?,
   *         max_records?, description?, is_free?, max_purchase_count?, renew_before_days?,
   *         points_per_day?, sort_order?, dns_channel_id?, upstream_plan_id?, upstream_price? }
   */
  router.post('/api/admin/plans', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return errorResponse('请求体JSON格式无效');
    }

    const name = body.name as string;
    const price = body.price as number;
    const duration_days = body.duration_days as number;
    const domain_ids = body.domain_ids as number[];

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return errorResponse('套餐名称不能为空');
    }
    if (price === undefined || price === null || typeof price !== 'number' || price < 0) {
      return errorResponse('价格无效');
    }
    if (!duration_days || typeof duration_days !== 'number' || duration_days < 1) {
      return errorResponse('有效期天数无效');
    }
    if (!domain_ids || !Array.isArray(domain_ids) || domain_ids.length === 0) {
      return errorResponse('至少需要一个关联域名');
    }

    const min_length = body.min_length !== undefined ? (body.min_length as number) : 1;
    const max_length = body.max_length !== undefined ? (body.max_length as number) : 63;
    const max_records = body.max_records !== undefined ? (body.max_records as number) : 10;
    const description = body.description !== undefined ? (body.description as string) : null;
    const is_free = body.is_free !== undefined ? (body.is_free as number) : 0;
    const max_purchase_count = body.max_purchase_count !== undefined ? (body.max_purchase_count as number) : 0;
    const renew_before_days = body.renew_before_days !== undefined ? (body.renew_before_days as number) : 0;
    const points_per_day = body.points_per_day !== undefined ? (body.points_per_day as number) : 0;
    const sort_order = body.sort_order !== undefined ? (body.sort_order as number) : 0;
    const dns_channel_id = body.dns_channel_id !== undefined ? (body.dns_channel_id as number) : null;
    const upstream_plan_id = body.upstream_plan_id !== undefined ? (body.upstream_plan_id as number) : null;
    const upstream_price = body.upstream_price !== undefined ? (body.upstream_price as number) : null;

    // 检查关联域名是否存在
    const placeholders = domain_ids.map(() => '?').join(',');
    const domainCheck = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM domains WHERE id IN (${placeholders})`
    ).bind(...domain_ids).first<{ count: number }>();

    if (!domainCheck || domainCheck.count !== domain_ids.length) {
      return errorResponse('部分关联域名不存在');
    }

    const now = new Date().toISOString();

    const result = await env.DB.prepare(
      `INSERT INTO plans (name, price, duration_days, min_length, max_length, max_records,
        description, is_free, max_purchase_count, renew_before_days, points_per_day,
        sort_order, dns_channel_id, upstream_plan_id, upstream_price, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).bind(
      name.trim(), price, duration_days, min_length, max_length, max_records,
      description, is_free, max_purchase_count, renew_before_days, points_per_day,
      sort_order, dns_channel_id, upstream_plan_id, upstream_price, now, now
    ).run();

    const planId = result.meta.last_row_id;

    // 插入 plan_domains 关联
    if (domain_ids.length > 0) {
      const insertStmts = domain_ids.map(domainId =>
        env.DB.prepare('INSERT INTO plan_domains (plan_id, domain_id) VALUES (?, ?)').bind(planId, domainId)
      );
      await env.DB.batch(insertStmts);
    }

    const plan = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(planId).first();

    return successResponse(plan, '套餐创建成功');
  });

  /**
   * PUT /api/admin/plans/:id
   * 更新套餐
   * Body: 任意可更新字段, 如果提供 domain_ids 则删除旧关联并重新插入
   */
  router.put('/api/admin/plans/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const planId = parseInt(params.id);
    if (isNaN(planId)) {
      return errorResponse('无效的套餐ID');
    }

    const existing = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(planId).first();
    if (!existing) {
      return errorResponse('套餐不存在', 404);
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return errorResponse('请求体JSON格式无效');
    }

    const allowedFields = [
      'name', 'price', 'duration_days', 'min_length', 'max_length',
      'max_records', 'description', 'is_free', 'max_purchase_count',
      'renew_before_days', 'points_per_day', 'sort_order', 'dns_channel_id',
      'upstream_plan_id', 'upstream_price', 'status',
    ];

    const updates: string[] = [];
    const values: unknown[] = [];

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        const col = field === 'name' ? 'name' : field;
        if (field === 'name') {
          const val = body[field] as string;
          if (typeof val !== 'string' || val.trim().length === 0) {
            return errorResponse('套餐名称不能为空');
          }
          updates.push(`${col} = ?`);
          values.push(val.trim());
        } else {
          updates.push(`${col} = ?`);
          values.push(body[field]);
        }
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(planId);

      await env.DB.prepare(
        `UPDATE plans SET ${updates.join(', ')} WHERE id = ?`
      ).bind(...values).run();
    }

    // 处理 domain_ids
    if (body.domain_ids !== undefined) {
      const domain_ids = body.domain_ids as number[];
      if (!Array.isArray(domain_ids) || domain_ids.length === 0) {
        return errorResponse('至少需要一个关联域名');
      }

      // 验证域名存在
      const placeholders = domain_ids.map(() => '?').join(',');
      const domainCheck = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM domains WHERE id IN (${placeholders})`
      ).bind(...domain_ids).first<{ count: number }>();

      if (!domainCheck || domainCheck.count !== domain_ids.length) {
        return errorResponse('部分关联域名不存在');
      }

      const stmts = [
        env.DB.prepare('DELETE FROM plan_domains WHERE plan_id = ?').bind(planId),
        ...domain_ids.map(domainId =>
          env.DB.prepare('INSERT INTO plan_domains (plan_id, domain_id) VALUES (?, ?)').bind(planId, domainId)
        ),
      ];
      await env.DB.batch(stmts);
    }

    const updated = await env.DB.prepare(
      `SELECT p.*, GROUP_CONCAT(d.name) as domain_names
       FROM plans p
       LEFT JOIN plan_domains pd ON p.id = pd.plan_id
       LEFT JOIN domains d ON pd.domain_id = d.id
       WHERE p.id = ?
       GROUP BY p.id`
    ).bind(planId).first<Record<string, unknown>>();

    const result = {
      ...updated,
      domain_names: updated && updated.domain_names ? String(updated.domain_names).split(',') : [],
    };

    return successResponse(result, '套餐更新成功');
  });

  /**
   * DELETE /api/admin/plans/:id
   * 删除套餐, 检查是否有子域名正在使用
   */
  router.delete('/api/admin/plans/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const planId = parseInt(params.id);
    if (isNaN(planId)) {
      return errorResponse('无效的套餐ID');
    }

    const existing = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(planId).first();
    if (!existing) {
      return errorResponse('套餐不存在', 404);
    }

    // 检查是否有子域名使用此套餐
    const subdomainCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM subdomains WHERE plan_id = ?'
    ).bind(planId).first<{ count: number }>();

    if (subdomainCount && subdomainCount.count > 0) {
      return errorResponse(`该套餐下有 ${subdomainCount.count} 个子域名正在使用，无法删除`);
    }

    // 删除套餐 (plan_domains 会通过 CASCADE 自动删除)
    await env.DB.prepare('DELETE FROM plans WHERE id = ?').bind(planId).run();

    return successResponse(null, '套餐删除成功');
  });

  /**
   * GET /api/admin/free-plan-applications
   * 列出免费套餐申请
   * Query: ?page=1&page_size=20&status=pending
   * JOIN users 和 plans
   */
  router.get('/api/admin/free-plan-applications', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const status = url.searchParams.get('status') || '';

    const offset = (page - 1) * pageSize;

    let whereClause = '';
    const bindValues: unknown[] = [];

    if (status && ['pending', 'approved', 'rejected', 'cancelled', 'used'].includes(status)) {
      whereClause = 'WHERE fpa.status = ?';
      bindValues.push(status);
    }

    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM free_plan_applications fpa ${whereClause}`
    ).bind(...bindValues).first<{ count: number }>();

    const total = countResult?.count || 0;

    const applications = await env.DB.prepare(
      `SELECT fpa.*, u.username, u.email, p.name as plan_name
       FROM free_plan_applications fpa
       LEFT JOIN users u ON fpa.user_id = u.id
       LEFT JOIN plans p ON fpa.plan_id = p.id
       ${whereClause}
       ORDER BY fpa.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...bindValues, pageSize, offset).all();

    return successResponse({
      list: applications.results,
      total,
      page,
      page_size: pageSize,
      total_pages: Math.ceil(total / pageSize),
    });
  });

  /**
   * PUT /api/admin/free-plan-applications/:id
   * 审核免费套餐申请
   * Body: { status: 'approved'|'rejected', admin_note?, rejection_reason? }
   * 如果 approved, 可选自动创建子域名
   */
  router.put('/api/admin/free-plan-applications/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const appId = parseInt(params.id);
    if (isNaN(appId)) {
      return errorResponse('无效的申请ID');
    }

    const application = await env.DB.prepare(
      `SELECT fpa.*, p.name as plan_name, p.duration_days, p.max_records,
              p.dns_channel_id, p.is_free, d.name as domain_name
       FROM free_plan_applications fpa
       LEFT JOIN plans p ON fpa.plan_id = p.id
       LEFT JOIN domains d ON fpa.domain_id = d.id
       WHERE fpa.id = ?`
    ).bind(appId).first<Record<string, unknown>>();

    if (!application) {
      return errorResponse('申请不存在', 404);
    }

    if (application.status !== 'pending') {
      return errorResponse('该申请已经审核过了');
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return errorResponse('请求体JSON格式无效');
    }

    const newStatus = body.status as string;
    if (!newStatus || !['approved', 'rejected'].includes(newStatus)) {
      return errorResponse('审核状态必须是 approved 或 rejected');
    }

    const admin_note = body.admin_note !== undefined ? (body.admin_note as string) : null;
    const rejection_reason = body.rejection_reason !== undefined ? (body.rejection_reason as string) : null;
    const now = new Date().toISOString();

    if (newStatus === 'rejected') {
      if (!rejection_reason) {
        return errorResponse('拒绝时必须填写拒绝原因');
      }

      await env.DB.prepare(
        `UPDATE free_plan_applications
         SET status = ?, rejection_reason = ?, admin_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ?`
      ).bind('rejected', rejection_reason, admin_note, auth.user.user_id, now, now, appId).run();

      return successResponse(null, '申请已拒绝');
    }

    // approved
    const subdomainName = (application.subdomain_name as string) || '';
    const domainId = application.domain_id as number;
    const planId = application.plan_id as number;
    const userId = application.user_id as number;
    const durationDays = (application.duration_days as number) || 30;
    const domainName = (application.domain_name as string) || '';

    const fullName = subdomainName ? `${subdomainName}.${domainName}` : '';

    // 如果提供了子域名信息, 自动创建子域名
    let subdomainId: number | null = null;
    let provisionError: string | null = null;

    if (subdomainName && domainId && planId && userId && fullName) {
      try {
        // 检查 full_name 是否已存在
        const existingSub = await env.DB.prepare(
          'SELECT id FROM subdomains WHERE full_name = ?'
        ).bind(fullName).first<{ id: number }>();

        if (existingSub) {
          provisionError = `子域名 ${fullName} 已存在`;
        } else {
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + durationDays);

          const subResult = await env.DB.prepare(
            `INSERT INTO subdomains (user_id, domain_id, plan_id, name, full_name, status, expires_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
          ).bind(userId, domainId, planId, subdomainName, fullName, expiresAt.toISOString(), now, now).run();

          subdomainId = subResult.meta.last_row_id as number;
        }
      } catch (e: unknown) {
        provisionError = e instanceof Error ? e.message : '自动开通子域名失败';
      }
    }

    const provisionAttempted = subdomainId !== null || provisionError !== null ? 1 : 0;

    await env.DB.prepare(
      `UPDATE free_plan_applications
       SET status = ?, admin_note = ?, reviewed_by = ?, reviewed_at = ?,
           provision_attempted = ?, provision_error = ?, subdomain_id = ?, updated_at = ?
       WHERE id = ?`
    ).bind(
      'approved', admin_note, auth.user.user_id, now,
      provisionAttempted, provisionError, subdomainId, now, appId
    ).run();

    return successResponse({
      application_id: appId,
      subdomain_id: subdomainId,
      provision_error: provisionError,
    }, '申请已通过');
  });
}