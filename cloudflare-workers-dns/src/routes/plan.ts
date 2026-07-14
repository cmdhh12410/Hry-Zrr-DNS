import { Router } from '../router';
import { successResponse, errorResponse } from '../utils/response';
import { authMiddleware } from '../middleware/auth';
import type { Env, PlanRow } from '../utils/types';

export function registerPlanRoutes(router: Router) {
  /**
   * GET /api/plans/domain/:domain_id
   * 获取指定域名关联的套餐列表 (公开)
   * 注意：此路由必须在 /api/plans/:id 之前注册，否则 "domain" 会被当作 :id 参数
   */
  router.get('/api/plans/domain/:domain_id', async (request, env, params) => {
    const domainId = parseInt(params.domain_id);
    if (isNaN(domainId)) {
      return errorResponse('无效的域名ID');
    }

    const plans = await env.DB.prepare(
      `SELECT p.*, GROUP_CONCAT(d.name) as domain_names
       FROM plans p
       INNER JOIN plan_domains pd ON p.id = pd.plan_id
       INNER JOIN domains d ON pd.domain_id = d.id
       WHERE pd.domain_id = ? AND p.status = 1
       GROUP BY p.id
       ORDER BY p.sort_order ASC, p.id ASC`
    ).bind(domainId).all();

    const results = plans.results.map((plan: Record<string, unknown>) => ({
      ...plan,
      domain_names: plan.domain_names ? String(plan.domain_names).split(',') : [],
    }));

    return successResponse(results);
  });

  /**
   * GET /api/plans
   * 获取所有活跃套餐列表 (公开)
   * 关联 plan_domains 获取关联的域名名称
   */
  router.get('/api/plans', async (request, env) => {
    const plans = await env.DB.prepare(
      `SELECT p.*, GROUP_CONCAT(d.name) as domain_names
       FROM plans p
       LEFT JOIN plan_domains pd ON p.id = pd.plan_id
       LEFT JOIN domains d ON pd.domain_id = d.id
       WHERE p.status = 1
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
   * GET /api/plans/:id
   * 获取单个套餐详情及其关联的域名
   */
  router.get('/api/plans/:id', async (request, env, params) => {
    const planId = parseInt(params.id);
    if (isNaN(planId)) {
      return errorResponse('无效的套餐ID');
    }

    const plan = await env.DB.prepare(
      `SELECT p.*, GROUP_CONCAT(d.name) as domain_names
       FROM plans p
       LEFT JOIN plan_domains pd ON p.id = pd.plan_id
       LEFT JOIN domains d ON pd.domain_id = d.id
       WHERE p.id = ?
       GROUP BY p.id`
    ).bind(planId).first<Record<string, unknown>>();

    if (!plan) {
      return errorResponse('套餐不存在', 404);
    }

    const result = {
      ...plan,
      domain_names: plan.domain_names ? String(plan.domain_names).split(',') : [],
    };

    return successResponse(result);
  });
}