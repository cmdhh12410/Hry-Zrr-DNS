import { Router } from '../router';
import { successResponse, errorResponse } from '../utils/response';
import { authMiddleware } from '../middleware/auth';
import type { Env, SubdomainRow, DnsRecordRow, PlanRow } from '../utils/types';

const ALLOWED_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX'];

function generateCfRecordId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return 'cf_' + hex;
}

export function registerRecordRoutes(router: Router) {
  /**
   * GET /api/records/:subdomain_id
   * 列出子域名下的所有 DNS 记录
   */
  router.get('/api/records/:subdomain_id', async (request, env, params) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const subdomainId = parseInt(params.subdomain_id);
    if (isNaN(subdomainId)) {
      return errorResponse('无效的子域名ID');
    }

    // 验证子域名所有权
    const subdomain = await env.DB.prepare(
      'SELECT * FROM subdomains WHERE id = ? AND user_id = ?'
    ).bind(subdomainId, auth.user.user_id).first<SubdomainRow>();

    if (!subdomain) {
      return errorResponse('子域名不存在或无权访问', 404);
    }

    const records = await env.DB.prepare(
      'SELECT * FROM dns_records WHERE subdomain_id = ? ORDER BY id ASC'
    ).bind(subdomainId).all<DnsRecordRow>();

    return successResponse({
      subdomain: {
        id: subdomain.id,
        name: subdomain.name,
        full_name: subdomain.full_name,
      },
      records: records.results,
    });
  });

  /**
   * POST /api/records/:subdomain_id
   * 添加 DNS 记录
   */
  router.post('/api/records/:subdomain_id', async (request, env, params) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const subdomainId = parseInt(params.subdomain_id);
    if (isNaN(subdomainId)) {
      return errorResponse('无效的子域名ID');
    }

    const body = await request.json() as {
      type: string;
      name: string;
      content: string;
      ttl?: number;
      proxied?: boolean;
      priority?: number;
    };

    const { type, name, content, ttl = 120, proxied = false, priority } = body;

    // 验证必填字段
    if (!type || !name || !content) {
      return errorResponse('type、name、content 不能为空');
    }

    // 验证记录类型
    if (!ALLOWED_RECORD_TYPES.includes(type.toUpperCase())) {
      return errorResponse(`不支持的记录类型: ${type}，支持的类型: ${ALLOWED_RECORD_TYPES.join(', ')}`);
    }

    // 验证子域名所有权
    const subdomain = await env.DB.prepare(
      'SELECT * FROM subdomains WHERE id = ? AND user_id = ?'
    ).bind(subdomainId, auth.user.user_id).first<SubdomainRow>();

    if (!subdomain) {
      return errorResponse('子域名不存在或无权访问', 404);
    }

    // 检查记录数量限制
    if (subdomain.plan_id) {
      const plan = await env.DB.prepare(
        'SELECT max_records FROM plans WHERE id = ?'
      ).bind(subdomain.plan_id).first<PlanRow>();

      if (plan) {
        const countResult = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM dns_records WHERE subdomain_id = ?'
        ).bind(subdomainId).first<{ count: number }>();

        if (countResult && countResult.count >= plan.max_records) {
          return errorResponse(`当前套餐最多支持 ${plan.max_records} 条记录，已达到上限`);
        }
      }
    }

    const cfRecordId = generateCfRecordId();

    const result = await env.DB.prepare(
      `INSERT INTO dns_records (subdomain_id, type, name, content, ttl, proxied, priority, cf_record_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      subdomainId,
      type.toUpperCase(),
      name,
      content,
      ttl,
      proxied ? 1 : 0,
      priority ?? null,
      cfRecordId,
    ).run();

    const record = await env.DB.prepare(
      'SELECT * FROM dns_records WHERE id = ?'
    ).bind(result.meta.last_row_id).first<DnsRecordRow>();

    return successResponse(record, '记录添加成功');
  });

  /**
   * PUT /api/records/:subdomain_id/:record_id
   * 更新 DNS 记录
   */
  router.put('/api/records/:subdomain_id/:record_id', async (request, env, params) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const subdomainId = parseInt(params.subdomain_id);
    const recordId = parseInt(params.record_id);
    if (isNaN(subdomainId) || isNaN(recordId)) {
      return errorResponse('无效的参数');
    }

    // 验证子域名所有权
    const subdomain = await env.DB.prepare(
      'SELECT * FROM subdomains WHERE id = ? AND user_id = ?'
    ).bind(subdomainId, auth.user.user_id).first<SubdomainRow>();

    if (!subdomain) {
      return errorResponse('子域名不存在或无权访问', 404);
    }

    // 验证记录存在且属于该子域名
    const existing = await env.DB.prepare(
      'SELECT * FROM dns_records WHERE id = ? AND subdomain_id = ?'
    ).bind(recordId, subdomainId).first<DnsRecordRow>();

    if (!existing) {
      return errorResponse('记录不存在', 404);
    }

    const body = await request.json() as {
      type?: string;
      name?: string;
      content?: string;
      ttl?: number;
      proxied?: boolean;
      priority?: number;
    };

    const { type, name, content, ttl, proxied, priority } = body;

    // 验证记录类型
    if (type && !ALLOWED_RECORD_TYPES.includes(type.toUpperCase())) {
      return errorResponse(`不支持的记录类型: ${type}，支持的类型: ${ALLOWED_RECORD_TYPES.join(', ')}`);
    }

    // 构建更新字段
    const updates: string[] = [];
    const values: unknown[] = [];

    if (type !== undefined) {
      updates.push('type = ?');
      values.push(type.toUpperCase());
    }
    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (content !== undefined) {
      updates.push('content = ?');
      values.push(content);
    }
    if (ttl !== undefined) {
      updates.push('ttl = ?');
      values.push(ttl);
    }
    if (proxied !== undefined) {
      updates.push('proxied = ?');
      values.push(proxied ? 1 : 0);
    }
    if (priority !== undefined) {
      updates.push('priority = ?');
      values.push(priority);
    }

    if (updates.length === 0) {
      return errorResponse('没有需要更新的字段');
    }

    updates.push("updated_at = datetime('now')");
    values.push(recordId);

    await env.DB.prepare(
      `UPDATE dns_records SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    const updated = await env.DB.prepare(
      'SELECT * FROM dns_records WHERE id = ?'
    ).bind(recordId).first<DnsRecordRow>();

    return successResponse(updated, '记录更新成功');
  });

  /**
   * DELETE /api/records/:subdomain_id/:record_id
   * 删除 DNS 记录
   */
  router.delete('/api/records/:subdomain_id/:record_id', async (request, env, params) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const subdomainId = parseInt(params.subdomain_id);
    const recordId = parseInt(params.record_id);
    if (isNaN(subdomainId) || isNaN(recordId)) {
      return errorResponse('无效的参数');
    }

    // 验证子域名所有权
    const subdomain = await env.DB.prepare(
      'SELECT * FROM subdomains WHERE id = ? AND user_id = ?'
    ).bind(subdomainId, auth.user.user_id).first<SubdomainRow>();

    if (!subdomain) {
      return errorResponse('子域名不存在或无权访问', 404);
    }

    // 验证记录存在且属于该子域名
    const existing = await env.DB.prepare(
      'SELECT * FROM dns_records WHERE id = ? AND subdomain_id = ?'
    ).bind(recordId, subdomainId).first<DnsRecordRow>();

    if (!existing) {
      return errorResponse('记录不存在', 404);
    }

    await env.DB.prepare(
      'DELETE FROM dns_records WHERE id = ? AND subdomain_id = ?'
    ).bind(recordId, subdomainId).run();

    return successResponse(null, '记录删除成功');
  });
}