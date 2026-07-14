import { Router } from '../router';
import { successResponse, errorResponse } from '../utils/response';
import { authMiddleware } from '../middleware/auth';
import type { CouponRow } from '../utils/types';

export function registerCouponRoutes(router: Router) {
  /**
   * POST /api/coupons/validate
   * 验证优惠券 (需要登录)
   * Body: { code, plan_id, amount }
   */
  router.post('/api/coupons/validate', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const body = await request.json() as {
      code: string;
      plan_id?: number;
      amount: number;
    };

    const { code, plan_id, amount } = body;

    if (!code) {
      return errorResponse('优惠券代码不能为空');
    }

    if (amount === undefined || amount === null || amount < 0) {
      return errorResponse('金额无效');
    }

    // 查询优惠券
    const coupon = await env.DB.prepare(
      'SELECT * FROM coupons WHERE code = ?'
    ).bind(code).first<CouponRow>();

    if (!coupon) {
      return errorResponse('优惠券不存在');
    }

    // 检查状态
    if (coupon.status !== 1) {
      return errorResponse('优惠券已失效');
    }

    // 检查是否在有效期内
    const now = new Date().toISOString();
    if (coupon.starts_at && coupon.starts_at > now) {
      return errorResponse('优惠券尚未生效');
    }
    if (coupon.expires_at && coupon.expires_at < now) {
      return errorResponse('优惠券已过期');
    }

    // 检查总使用次数
    if (coupon.total_count !== -1 && coupon.used_count >= coupon.total_count) {
      return errorResponse('优惠券已被领完');
    }

    // 检查用户使用次数限制
    const usageCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM coupon_usages WHERE coupon_id = ? AND user_id = ?'
    ).bind(coupon.id, auth.user.user_id).first<{ count: number }>();

    if (usageCount && usageCount.count >= coupon.per_user_limit) {
      return errorResponse('您已超出该优惠券的使用次数限制');
    }

    // 检查最低消费金额
    if (amount < coupon.min_amount) {
      return errorResponse(`最低消费金额为 ¥${coupon.min_amount}`);
    }

    // 检查适用套餐
    if (coupon.applicable_plans && plan_id) {
      try {
        const applicablePlans = JSON.parse(coupon.applicable_plans) as number[];
        if (applicablePlans.length > 0 && !applicablePlans.includes(plan_id)) {
          return errorResponse('该优惠券不适用于此套餐');
        }
      } catch {
        // JSON 解析失败，跳过套餐检查
      }
    }

    // 计算折扣金额
    let discountAmount = 0;
    if (coupon.type === 'fixed') {
      discountAmount = coupon.value;
    } else if (coupon.type === 'percent') {
      discountAmount = Math.round((amount * coupon.value / 100) * 100) / 100;
      if (coupon.max_discount && discountAmount > coupon.max_discount) {
        discountAmount = coupon.max_discount;
      }
    }

    // 折扣不能超过实际金额
    if (discountAmount > amount) {
      discountAmount = amount;
    }

    const finalAmount = Math.round((amount - discountAmount) * 100) / 100;

    return successResponse({
      coupon: {
        id: coupon.id,
        code: coupon.code,
        name: coupon.name,
        type: coupon.type,
        value: coupon.value,
        discount_amount: discountAmount,
        original_amount: amount,
        final_amount: finalAmount,
      },
    }, '优惠券验证成功');
  });

  /**
   * GET /api/coupons/available
   * 获取当前可用的优惠券列表
   */
  router.get('/api/coupons/available', async (request, env) => {
    const now = new Date().toISOString();

    const coupons = await env.DB.prepare(
      `SELECT * FROM coupons
       WHERE status = 1
       AND (starts_at IS NULL OR starts_at <= ?)
       AND (expires_at IS NULL OR expires_at > ?)
       AND (total_count = -1 OR used_count < total_count)
       ORDER BY created_at DESC`
    ).bind(now, now).all<CouponRow>();

    const results = coupons.results.map((coupon) => ({
      id: coupon.id,
      code: coupon.code,
      name: coupon.name,
      type: coupon.type,
      value: coupon.value,
      min_amount: coupon.min_amount,
      max_discount: coupon.max_discount,
      total_count: coupon.total_count,
      used_count: coupon.used_count,
      per_user_limit: coupon.per_user_limit,
      applicable_plans: coupon.applicable_plans ? (() => {
        try { return JSON.parse(coupon.applicable_plans); } catch { return null; }
      })() : null,
      applicable_type: coupon.applicable_type,
      expires_at: coupon.expires_at,
      starts_at: coupon.starts_at,
    }));

    return successResponse({ coupons: results }, '获取成功');
  });
}