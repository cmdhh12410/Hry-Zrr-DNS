import { Router } from '../router';
import { successResponse, errorResponse } from '../utils/response';
import { authMiddleware } from '../middleware/auth';
import type { Env, DomainRow, SubdomainRow, PlanRow, CouponRow, PurchaseRecordRow } from '../utils/types';

export function registerDomainRoutes(router: Router) {
  /**
   * GET /api/domains
   * 列出可供注册的域名 (公开接口)
   */
  router.get('/api/domains', async (_request, env) => {
    const domains = await env.DB.prepare(
      'SELECT * FROM domains WHERE status = 1 AND allow_register = 1 ORDER BY sort_order ASC, id ASC'
    ).all<DomainRow>();

    return successResponse(domains.results);
  });

  /**
   * POST /api/domains/buy
   * 购买域名 (需要登录)
   * 注意：此路由必须在 /api/domains/:id 之前注册
   */
  router.post('/api/domains/buy', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const body = await request.json() as {
      domain_id: number;
      plan_id: number;
      subdomain_name: string;
      coupon_code?: string;
    };

    const { domain_id, plan_id, subdomain_name, coupon_code } = body;

    if (!domain_id || !plan_id || !subdomain_name) {
      return errorResponse('缺少必要参数：domain_id, plan_id, subdomain_name');
    }

    // 验证套餐存在且有效
    const plan = await env.DB.prepare(
      'SELECT * FROM plans WHERE id = ? AND status = 1'
    ).bind(plan_id).first<PlanRow>();

    if (!plan) {
      return errorResponse('套餐不存在或已下架');
    }

    // 验证域名存在且允许注册
    const domain = await env.DB.prepare(
      'SELECT * FROM domains WHERE id = ? AND status = 1 AND allow_register = 1'
    ).bind(domain_id).first<DomainRow>();

    if (!domain) {
      return errorResponse('域名不存在、已禁用或不允许注册');
    }

    // 验证子域名名称长度
    if (subdomain_name.length < plan.min_length || subdomain_name.length > plan.max_length) {
      return errorResponse(
        `子域名长度需在 ${plan.min_length}-${plan.max_length} 个字符之间`
      );
    }

    // 验证子域名格式 (仅允许字母、数字、连字符)
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(subdomain_name)) {
      return errorResponse('子域名格式不正确，仅允许字母、数字和连字符，且不能以连字符开头或结尾');
    }

    // 检查子域名是否已被占用
    const fullName = `${subdomain_name}.${domain.name}`;
    const existing = await env.DB.prepare(
      'SELECT id FROM subdomains WHERE full_name = ? AND status = 1'
    ).bind(fullName).first<{ id: number }>();

    if (existing) {
      return errorResponse('该子域名已被注册');
    }

    // 检查用户域名数量限制
    const defaultMaxDomains = parseInt(env.DEFAULT_MAX_DOMAINS || '10');
    const user = await env.DB.prepare(
      'SELECT balance, max_domains FROM users WHERE id = ?'
    ).bind(auth.user.user_id).first<{ balance: number; max_domains: number }>();

    if (!user) {
      return errorResponse('用户不存在', 404);
    }

    const maxDomains = user.max_domains || defaultMaxDomains;
    const domainCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM subdomains WHERE user_id = ? AND status = 1'
    ).bind(auth.user.user_id).first<{ count: number }>();

    if (domainCount && domainCount.count >= maxDomains) {
      return errorResponse(`已达到域名数量上限 (${maxDomains}个)`);
    }

    // 检查套餐每人限购次数
    if (plan.max_purchase_count > 0) {
      const purchaseCount = await env.DB.prepare(
        'SELECT COUNT(*) as count FROM purchase_records WHERE user_id = ? AND plan_id = ?'
      ).bind(auth.user.user_id, plan_id).first<{ count: number }>();

      if (purchaseCount && purchaseCount.count >= plan.max_purchase_count) {
        return errorResponse(`该套餐每人限购 ${plan.max_purchase_count} 次`);
      }
    }

    // 处理优惠券
    let coupon: CouponRow | null = null;
    let discountAmount = 0;
    let finalAmount = plan.price;

    if (coupon_code) {
      coupon = await env.DB.prepare(
        `SELECT * FROM coupons
         WHERE code = ? AND status = 1
         AND (starts_at IS NULL OR starts_at <= datetime('now'))
         AND (expires_at IS NULL OR expires_at >= datetime('now'))`
      ).bind(coupon_code).first<CouponRow>();

      if (!coupon) {
        return errorResponse('优惠券不存在或已过期');
      }

      if (coupon.used_count >= coupon.total_count) {
        return errorResponse('优惠券已被抢完');
      }

      // 检查使用次数限制
      const userCouponCount = await env.DB.prepare(
        'SELECT COUNT(*) as count FROM purchase_records WHERE user_id = ? AND coupon_id = ?'
      ).bind(auth.user.user_id, coupon.id).first<{ count: number }>();

      if (userCouponCount && userCouponCount.count >= coupon.per_user_limit) {
        return errorResponse('该优惠券已达到每人使用上限');
      }

      // 检查最低消费金额
      if (plan.price < coupon.min_amount) {
        return errorResponse(`该优惠券最低消费金额为 ¥${coupon.min_amount}`);
      }

      // 检查适用套餐
      if (coupon.applicable_plans) {
        try {
          const applicablePlans = JSON.parse(coupon.applicable_plans) as number[];
          if (applicablePlans.length > 0 && !applicablePlans.includes(plan_id)) {
            return errorResponse('该优惠券不适用于此套餐');
          }
        } catch { /* ignore parse error */ }
      }

      // 检查 excluded_domains
      if (coupon.excluded_domains) {
        try {
          const excludedDomains = JSON.parse(coupon.excluded_domains) as number[];
          if (excludedDomains.length > 0 && excludedDomains.includes(domain_id)) {
            return errorResponse('该优惠券不适用于此域名');
          }
        } catch { /* ignore parse error */ }
      }

      // 计算折扣
      if (coupon.type === 'fixed') {
        discountAmount = Math.min(coupon.value, plan.price);
      } else if (coupon.type === 'percentage') {
        discountAmount = plan.price * (coupon.value / 100);
        if (coupon.max_discount !== null && discountAmount > coupon.max_discount) {
          discountAmount = coupon.max_discount;
        }
      }

      finalAmount = Math.max(0, plan.price - discountAmount);
    }

    // 检查余额
    if (user.balance !== -1 && user.balance < finalAmount) {
      return errorResponse(`余额不足，需要 ¥${finalAmount}，当前余额 ¥${user.balance}`);
    }

    // 计算过期时间
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + plan.duration_days);
    const now = new Date().toISOString();
    const expiresAtStr = expiresAt.toISOString();

    // 创建子域名并扣款
    const createResult = await env.DB.prepare(
      `INSERT INTO subdomains (user_id, domain_id, plan_id, name, full_name, status, expires_at, last_renewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
    ).bind(
      auth.user.user_id, domain_id, plan_id, subdomain_name, fullName,
      expiresAtStr, now, now, now
    ).run();

    const subdomainId = createResult.meta.last_row_id;

    // 批量执行：扣款、更新优惠券使用次数、创建购买记录
    const batchOps: D1PreparedStatement[] = [];

    if (user.balance !== -1 && finalAmount > 0) {
      batchOps.push(
        env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ?')
          .bind(finalAmount, auth.user.user_id)
      );
    }

    if (coupon) {
      batchOps.push(
        env.DB.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?')
          .bind(coupon.id)
      );
    }

    batchOps.push(
      env.DB.prepare(
        `INSERT INTO purchase_records (user_id, subdomain_id, plan_id, domain_id, amount, subdomain_name, coupon_id, discount_amount, final_amount, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        auth.user.user_id, subdomainId, plan_id, domain_id,
        plan.price, fullName, coupon?.id || null, discountAmount, finalAmount, now
      )
    );

    await env.DB.batch(batchOps);

    // 获取创建后的子域名信息
    const subdomain = await env.DB.prepare(
      'SELECT * FROM subdomains WHERE id = ?'
    ).bind(subdomainId).first<SubdomainRow>();

    return successResponse({
      subdomain,
      plan: { id: plan.id, name: plan.name, price: plan.price, duration_days: plan.duration_days },
      domain: { id: domain.id, name: domain.name },
      payment: {
        original_amount: plan.price,
        discount_amount: discountAmount,
        final_amount: finalAmount,
        coupon_code: coupon?.code || null,
      },
    }, '购买成功');
  });

  /**
   * GET /api/domains/:id
   * 获取域名详情
   */
  router.get('/api/domains/:id', async (_request, env, params) => {
    const domainId = parseInt(params.id);
    if (isNaN(domainId)) {
      return errorResponse('无效的域名ID');
    }

    const domain = await env.DB.prepare(
      'SELECT * FROM domains WHERE id = ? AND status = 1 AND allow_register = 1'
    ).bind(domainId).first<DomainRow>();

    if (!domain) {
      return errorResponse('域名不存在', 404);
    }

    // 获取该域名下的可用套餐
    const plans = await env.DB.prepare(
      'SELECT * FROM plans WHERE status = 1 ORDER BY sort_order ASC, id ASC'
    ).all<PlanRow>();

    return successResponse({
      ...domain,
      plans: plans.results,
    });
  });

  /**
   * GET /api/user/domains
   * 获取用户已购买的域名列表 (需要登录)
   */
  router.get('/api/user/domains', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const subdomains = await env.DB.prepare(
      `SELECT s.*, d.name as domain_name, p.name as plan_name, p.price as plan_price,
              p.duration_days as plan_duration_days, p.max_records as plan_max_records
       FROM subdomains s
       JOIN domains d ON s.domain_id = d.id
       LEFT JOIN plans p ON s.plan_id = p.id
       WHERE s.user_id = ?
       ORDER BY s.created_at DESC`
    ).bind(auth.user.user_id).all();

    return successResponse(subdomains.results);
  });

  /**
   * GET /api/user/domains/:id
   * 获取用户单个域名详情 (需要登录)
   */
  router.get('/api/user/domains/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const subdomainId = parseInt(params.id);
    if (isNaN(subdomainId)) {
      return errorResponse('无效的域名ID');
    }

    const subdomain = await env.DB.prepare(
      `SELECT s.*, d.name as domain_name, d.cf_zone_id, d.zone_id,
              p.name as plan_name, p.price as plan_price, p.duration_days as plan_duration_days,
              p.max_records as plan_max_records
       FROM subdomains s
       JOIN domains d ON s.domain_id = d.id
       LEFT JOIN plans p ON s.plan_id = p.id
       WHERE s.id = ? AND s.user_id = ?`
    ).bind(subdomainId, auth.user.user_id).first();

    if (!subdomain) {
      return errorResponse('域名不存在', 404);
    }

    // 获取DNS记录数量
    const recordCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM dns_records WHERE subdomain_id = ?'
    ).bind(subdomainId).first<{ count: number }>();

    return successResponse({
      ...subdomain,
      record_count: recordCount?.count || 0,
    });
  });

  /**
   * POST /api/domains/:id/renew
   * 域名续费 (需要登录)
   */
  router.post('/api/domains/:id/renew', async (request, env, params) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const subdomainId = parseInt(params.id);
    if (isNaN(subdomainId)) {
      return errorResponse('无效的域名ID');
    }

    const body = await request.json() as {
      plan_id?: number;
    };

    // 检查域名所有权
    const subdomain = await env.DB.prepare(
      `SELECT s.*, d.name as domain_name, p.id as current_plan_id, p.price as current_plan_price,
              p.duration_days as current_plan_duration_days, p.max_records as current_plan_max_records
       FROM subdomains s
       JOIN domains d ON s.domain_id = d.id
       LEFT JOIN plans p ON s.plan_id = p.id
       WHERE s.id = ? AND s.user_id = ?`
    ).bind(subdomainId, auth.user.user_id).first<SubdomainRow & {
      domain_name: string;
      current_plan_id: number | null;
      current_plan_price: number | null;
      current_plan_duration_days: number | null;
      current_plan_max_records: number | null;
    }>();

    if (!subdomain) {
      return errorResponse('域名不存在或无权操作', 404);
    }

    if (subdomain.status !== 1) {
      return errorResponse('该域名状态异常，无法续费');
    }

    // 使用指定的套餐或当前套餐
    let plan: PlanRow | null = null;
    let price: number;
    let durationDays: number;

    if (body.plan_id) {
      // 使用新套餐
      plan = await env.DB.prepare(
        'SELECT * FROM plans WHERE id = ? AND status = 1'
      ).bind(body.plan_id).first<PlanRow>();

      if (!plan) {
        return errorResponse('套餐不存在或已下架');
      }
      price = plan.price;
      durationDays = plan.duration_days;
    } else {
      // 使用当前套餐
      if (!subdomain.current_plan_id) {
        return errorResponse('该域名没有关联套餐，请指定续费套餐');
      }

      plan = await env.DB.prepare(
        'SELECT * FROM plans WHERE id = ? AND status = 1'
      ).bind(subdomain.current_plan_id).first<PlanRow>();

      if (!plan) {
        return errorResponse('当前套餐已下架，请指定新的续费套餐');
      }
      price = plan.price;
      durationDays = plan.duration_days;
    }

    // 计算新过期时间
    const now = new Date();
    const currentExpiry = subdomain.expires_at ? new Date(subdomain.expires_at) : now;
    const newExpiry = currentExpiry > now ? currentExpiry : now;
    newExpiry.setDate(newExpiry.getDate() + durationDays);
    const newExpiryStr = newExpiry.toISOString();
    const nowStr = now.toISOString();

    // 检查余额
    const user = await env.DB.prepare(
      'SELECT balance FROM users WHERE id = ?'
    ).bind(auth.user.user_id).first<{ balance: number }>();

    if (!user) {
      return errorResponse('用户不存在', 404);
    }

    if (user.balance !== -1 && user.balance < price) {
      return errorResponse(`余额不足，需要 ¥${price}，当前余额 ¥${user.balance}`);
    }

    // 续费：更新子域名、扣款、创建购买记录
    const batchOps: D1PreparedStatement[] = [];

    batchOps.push(
      env.DB.prepare(
        `UPDATE subdomains SET expires_at = ?, plan_id = ?, last_renewed_at = ?, updated_at = ? WHERE id = ?`
      ).bind(newExpiryStr, plan.id, nowStr, nowStr, subdomainId)
    );

    if (user.balance !== -1 && price > 0) {
      batchOps.push(
        env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ?')
          .bind(price, auth.user.user_id)
      );
    }

    batchOps.push(
      env.DB.prepare(
        `INSERT INTO purchase_records (user_id, subdomain_id, plan_id, amount, final_amount, subdomain_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(auth.user.user_id, subdomainId, plan.id, price, price, subdomain.full_name, nowStr)
    );

    await env.DB.batch(batchOps);

    return successResponse({
      subdomain_id: subdomainId,
      plan: { id: plan.id, name: plan.name, price },
      previous_expiry: subdomain.expires_at,
      new_expiry: newExpiryStr,
      duration_days: durationDays,
    }, '续费成功');
  });

  /**
   * DELETE /api/user/domains/:id
   * 删除域名 (需要登录)
   */
  router.delete('/api/user/domains/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const subdomainId = parseInt(params.id);
    if (isNaN(subdomainId)) {
      return errorResponse('无效的域名ID');
    }

    // 检查域名所有权
    const subdomain = await env.DB.prepare(
      `SELECT s.*, d.name as domain_name, d.cf_zone_id
       FROM subdomains s
       JOIN domains d ON s.domain_id = d.id
       WHERE s.id = ? AND s.user_id = ?`
    ).bind(subdomainId, auth.user.user_id).first<SubdomainRow & {
      domain_name: string;
      cf_zone_id: string | null;
    }>();

    if (!subdomain) {
      return errorResponse('域名不存在或无权操作', 404);
    }

    const now = new Date().toISOString();

    // 软删除：将子域名状态设为0
    await env.DB.prepare(
      'UPDATE subdomains SET status = 0, updated_at = ? WHERE id = ?'
    ).bind(now, subdomainId).run();

    // 同时删除关联的 DNS 记录
    await env.DB.prepare(
      'DELETE FROM dns_records WHERE subdomain_id = ?'
    ).bind(subdomainId).run();

    return successResponse({
      subdomain_id: subdomainId,
      full_name: subdomain.full_name,
      deleted_at: now,
    }, '删除成功');
  });
}