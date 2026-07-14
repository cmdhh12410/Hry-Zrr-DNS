import { Router } from '../../router';
import { successResponse, errorResponse } from '../../utils/response';
import { authMiddleware } from '../../middleware/auth';
import type { CouponRow } from '../../utils/types';

export function registerAdminCouponRoutes(router: Router) {
  /**
   * GET /api/admin/coupons
   * 列出所有优惠券 (管理员)
   * Query: ?page=1&page_size=20&status=1&search=keyword
   */
  router.get('/api/admin/coupons', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const status = url.searchParams.get('status');
    const search = url.searchParams.get('search')?.trim() || '';

    let whereClauses: string[] = [];
    let bindValues: (string | number)[] = [];

    if (status !== null && status !== '') {
      whereClauses.push('status = ?');
      bindValues.push(parseInt(status));
    }

    if (search) {
      whereClauses.push('(code LIKE ? OR name LIKE ?)');
      bindValues.push(`%${search}%`, `%${search}%`);
    }

    const whereSQL = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM coupons ${whereSQL}`
    ).bind(...bindValues).first<{ count: number }>();

    const total = countResult?.count || 0;
    const offset = (page - 1) * pageSize;

    const coupons = await env.DB.prepare(
      `SELECT * FROM coupons ${whereSQL} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(...bindValues, pageSize, offset).all<CouponRow>();

    const results = coupons.results.map((c) => ({
      ...c,
      applicable_plans: c.applicable_plans ? (() => {
        try { return JSON.parse(c.applicable_plans); } catch { return null; }
      })() : null,
      excluded_domains: c.excluded_domains ? (() => {
        try { return JSON.parse(c.excluded_domains); } catch { return null; }
      })() : null,
    }));

    return successResponse({
      coupons: results,
      total,
      page,
      page_size: pageSize,
      total_pages: Math.ceil(total / pageSize),
    });
  });

  /**
   * POST /api/admin/coupons
   * 创建优惠券 (管理员)
   * Body: { code, name, type, value, min_amount?, max_discount?, total_count?, per_user_limit?, applicable_plans?, applicable_type?, excluded_domains?, starts_at?, expires_at? }
   */
  router.post('/api/admin/coupons', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const body = await request.json() as {
      code: string;
      name: string;
      type: string;
      value: number;
      min_amount?: number;
      max_discount?: number | null;
      total_count?: number;
      per_user_limit?: number;
      applicable_plans?: number[] | null;
      applicable_type?: string;
      excluded_domains?: string[] | null;
      starts_at?: string | null;
      expires_at?: string | null;
    };

    const { code, name, type, value } = body;

    if (!code?.trim()) return errorResponse('优惠券代码不能为空');
    if (!name?.trim()) return errorResponse('优惠券名称不能为空');
    if (!type || !['percent', 'fixed'].includes(type)) return errorResponse('优惠券类型无效');
    if (value === undefined || value === null || value <= 0) return errorResponse('优惠券面值必须大于0');
    if (type === 'percent' && value > 100) return errorResponse('百分比折扣不能超过100');

    // 检查 code 唯一性
    const existing = await env.DB.prepare(
      'SELECT id FROM coupons WHERE code = ?'
    ).bind(code.trim()).first<{ id: number }>();

    if (existing) {
      return errorResponse('优惠券代码已存在');
    }

    const minAmount = body.min_amount ?? 0;
    const maxDiscount = body.max_discount ?? null;
    const totalCount = body.total_count ?? -1;
    const perUserLimit = body.per_user_limit ?? 1;
    const applicablePlans = body.applicable_plans ? JSON.stringify(body.applicable_plans) : null;
    const applicableType = body.applicable_type || 'all';
    const excludedDomains = body.excluded_domains ? JSON.stringify(body.excluded_domains) : null;
    const startsAt = body.starts_at || null;
    const expiresAt = body.expires_at || null;

    const result = await env.DB.prepare(
      `INSERT INTO coupons (code, name, type, value, min_amount, max_discount, total_count, per_user_limit, applicable_plans, applicable_type, excluded_domains, starts_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).bind(
      code.trim(), name.trim(), type, value, minAmount, maxDiscount,
      totalCount, perUserLimit, applicablePlans, applicableType,
      excludedDomains, startsAt, expiresAt
    ).run();

    if (!result.success) {
      return errorResponse('创建优惠券失败', 500);
    }

    return successResponse({ id: result.meta.last_row_id }, '优惠券创建成功');
  });

  /**
   * PUT /api/admin/coupons/:id
   * 更新优惠券 (管理员)
   * Body: any of the coupon fields
   */
  router.put('/api/admin/coupons/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (!id || isNaN(id)) return errorResponse('无效的优惠券ID');

    const coupon = await env.DB.prepare(
      'SELECT * FROM coupons WHERE id = ?'
    ).bind(id).first<CouponRow>();

    if (!coupon) {
      return errorResponse('优惠券不存在', 404);
    }

    const body = await request.json() as {
      code?: string;
      name?: string;
      type?: string;
      value?: number;
      status?: number;
      min_amount?: number;
      max_discount?: number | null;
      total_count?: number;
      per_user_limit?: number;
      applicable_plans?: number[] | null;
      applicable_type?: string;
      excluded_domains?: string[] | null;
      starts_at?: string | null;
      expires_at?: string | null;
    };

    // 如果修改 code，检查唯一性
    if (body.code !== undefined && body.code.trim() !== coupon.code) {
      const existing = await env.DB.prepare(
        'SELECT id FROM coupons WHERE code = ? AND id != ?'
      ).bind(body.code.trim(), id).first<{ id: number }>();

      if (existing) {
        return errorResponse('优惠券代码已存在');
      }
    }

    // 如果修改 type，验证合法性
    if (body.type !== undefined && !['percent', 'fixed'].includes(body.type)) {
      return errorResponse('优惠券类型无效');
    }

    const type = body.type !== undefined ? body.type : coupon.type;
    const value = body.value !== undefined ? body.value : coupon.value;
    if (body.value !== undefined && body.value <= 0) {
      return errorResponse('优惠券面值必须大于0');
    }
    if (type === 'percent' && value > 100) {
      return errorResponse('百分比折扣不能超过100');
    }

    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    const addField = (field: string, value: unknown) => {
      fields.push(`${field} = ?`);
      values.push(value as string | number | null);
    };

    if (body.code !== undefined) addField('code', body.code.trim());
    if (body.name !== undefined) addField('name', body.name.trim());
    if (body.type !== undefined) addField('type', type);
    if (body.value !== undefined) addField('value', value);
    if (body.status !== undefined) addField('status', body.status);
    if (body.min_amount !== undefined) addField('min_amount', body.min_amount);
    if (body.max_discount !== undefined) addField('max_discount', body.max_discount);
    if (body.total_count !== undefined) addField('total_count', body.total_count);
    if (body.per_user_limit !== undefined) addField('per_user_limit', body.per_user_limit);
    if (body.applicable_plans !== undefined) addField('applicable_plans', body.applicable_plans !== null ? JSON.stringify(body.applicable_plans) : null);
    if (body.applicable_type !== undefined) addField('applicable_type', body.applicable_type);
    if (body.excluded_domains !== undefined) addField('excluded_domains', body.excluded_domains !== null ? JSON.stringify(body.excluded_domains) : null);
    if (body.starts_at !== undefined) addField('starts_at', body.starts_at);
    if (body.expires_at !== undefined) addField('expires_at', body.expires_at);

    if (fields.length === 0) {
      return errorResponse('没有需要更新的字段');
    }

    values.push(id);

    const result = await env.DB.prepare(
      `UPDATE coupons SET ${fields.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    if (!result.success) {
      return errorResponse('更新优惠券失败', 500);
    }

    return successResponse(null, '优惠券更新成功');
  });

  /**
   * DELETE /api/admin/coupons/:id
   * 删除优惠券 (管理员)
   * 检查是否有使用记录
   */
  router.delete('/api/admin/coupons/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (!id || isNaN(id)) return errorResponse('无效的优惠券ID');

    const coupon = await env.DB.prepare(
      'SELECT * FROM coupons WHERE id = ?'
    ).bind(id).first<CouponRow>();

    if (!coupon) {
      return errorResponse('优惠券不存在', 404);
    }

    // 检查是否有使用记录
    const usageCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM coupon_usages WHERE coupon_id = ?'
    ).bind(id).first<{ count: number }>();

    if (usageCount && usageCount.count > 0) {
      return errorResponse(`该优惠券已有 ${usageCount.count} 条使用记录，无法删除`);
    }

    const result = await env.DB.prepare(
      'DELETE FROM coupons WHERE id = ?'
    ).bind(id).run();

    if (!result.success) {
      return errorResponse('删除优惠券失败', 500);
    }

    return successResponse(null, '优惠券删除成功');
  });

  /**
   * GET /api/admin/coupons/usages
   * 列出所有优惠券使用记录 (管理员)
   * Query: ?page=1&page_size=20&coupon_id=&user_id=
   */
  router.get('/api/admin/coupons/usages', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const couponId = url.searchParams.get('coupon_id');
    const userId = url.searchParams.get('user_id');

    let whereClauses: string[] = [];
    let bindValues: (string | number)[] = [];

    if (couponId) {
      whereClauses.push('cu.coupon_id = ?');
      bindValues.push(parseInt(couponId));
    }

    if (userId) {
      whereClauses.push('cu.user_id = ?');
      bindValues.push(parseInt(userId));
    }

    const whereSQL = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM coupon_usages cu ${whereSQL}`
    ).bind(...bindValues).first<{ count: number }>();

    const total = countResult?.count || 0;
    const offset = (page - 1) * pageSize;

    const usages = await env.DB.prepare(
      `SELECT cu.*, c.code as coupon_code, c.name as coupon_name, u.username, u.email
       FROM coupon_usages cu
       LEFT JOIN coupons c ON cu.coupon_id = c.id
       LEFT JOIN users u ON cu.user_id = u.id
       ${whereSQL}
       ORDER BY cu.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...bindValues, pageSize, offset).all();

    return successResponse({
      usages: usages.results,
      total,
      page,
      page_size: pageSize,
      total_pages: Math.ceil(total / pageSize),
    });
  });
}