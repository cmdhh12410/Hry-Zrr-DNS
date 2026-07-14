import { Router } from '../router';
import { successResponse, errorResponse } from '../utils/response';
import { apiKeyAuthMiddleware } from '../middleware/auth';
import type { Env, SubdomainRow, DnsRecordRow } from '../utils/types';

/**
 * 开放 API 路由
 * 使用 API Key 认证，供第三方程序调用
 */
export function registerOpenApiRoutes(router: Router) {
  /**
   * GET /api/open/domains
   * 列出用户的所有子域名
   */
  router.get('/api/open/domains', async (request, env) => {
    const auth = await apiKeyAuthMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const subdomains = await env.DB.prepare(
      `SELECT s.*, d.name as domain_name
       FROM subdomains s
       JOIN domains d ON s.domain_id = d.id
       WHERE s.user_id = ? AND s.status = 1
       ORDER BY s.created_at DESC`
    ).bind(auth.user.user_id).all();

    return successResponse({
      total: subdomains.results.length,
      domains: subdomains.results,
    });
  });

  /**
   * GET /api/open/domains/:id/records
   * 列出指定子域名的 DNS 记录
   */
  router.get('/api/open/domains/:id/records', async (request, env, params) => {
    const auth = await apiKeyAuthMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const subdomainId = parseInt(params.id);
    if (isNaN(subdomainId)) {
      return errorResponse('无效的域名ID');
    }

    // 验证域名所有权
    const subdomain = await env.DB.prepare(
      'SELECT * FROM subdomains WHERE id = ? AND user_id = ?'
    ).bind(subdomainId, auth.user.user_id).first<SubdomainRow>();

    if (!subdomain) {
      return errorResponse('域名不存在或无权访问', 404);
    }

    const records = await env.DB.prepare(
      'SELECT * FROM dns_records WHERE subdomain_id = ? ORDER BY id ASC'
    ).bind(subdomainId).all();

    return successResponse({
      subdomain: {
        id: subdomain.id,
        name: subdomain.name,
        full_name: subdomain.full_name,
      },
      total: records.results.length,
      records: records.results,
    });
  });

  /**
   * POST /api/open/domains/:id/records
   * 添加 DNS 记录
   * Body: { type, name, content, ttl?, proxied?, priority? }
   */
  router.post('/api/open/domains/:id/records', async (request, env, params) => {
    const auth = await apiKeyAuthMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const subdomainId = parseInt(params.id);
    if (isNaN(subdomainId)) {
      return errorResponse('无效的域名ID');
    }

    // 验证域名所有权
    const subdomain = await env.DB.prepare(
      'SELECT * FROM subdomains WHERE id = ? AND user_id = ?'
    ).bind(subdomainId, auth.user.user_id).first<SubdomainRow>();

    if (!subdomain) {
      return errorResponse('域名不存在或无权访问', 404);
    }

    // 检查域名状态
    if (subdomain.status !== 1) {
      return errorResponse('域名状态异常，无法添加记录');
    }

    const body = await request.json() as {
      type: string;
      name: string;
      content: string;
      ttl?: number;
      proxied?: boolean;
      priority?: number | null;
    };

    const { type, name, content, ttl, proxied, priority } = body;

    // 验证必填字段
    if (!type || !name || !content) {
      return errorResponse('type、name 和 content 为必填字段');
    }

    const validTypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'PTR', 'SOA'];
    if (!validTypes.includes(type.toUpperCase())) {
      return errorResponse(`不支持的记录类型: ${type}，支持的类型: ${validTypes.join(', ')}`);
    }

    const recordType = type.toUpperCase();
    const recordName = name || '@';
    const recordTtl = ttl && ttl >= 1 ? ttl : 120;
    const recordProxied = proxied ? 1 : 0;
    const recordPriority = recordType === 'MX' ? (priority || 10) : null;

    // 生成 cf_record_id（用于 Cloudflare API 同步）
    const cfRecordId = `openapi_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

    const result = await env.DB.prepare(
      `INSERT INTO dns_records (subdomain_id, type, name, content, ttl, proxied, priority, cf_record_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(subdomainId, recordType, recordName, content, recordTtl, recordProxied, recordPriority, cfRecordId).run();

    const recordId = result.meta.last_row_id;

    // 更新子域名的最后记录活动时间
    await env.DB.prepare(
      `UPDATE subdomains SET last_record_activity_at = datetime('now'),
       first_record_at = COALESCE(first_record_at, datetime('now'))
       WHERE id = ?`
    ).bind(subdomainId).run();

    const record = await env.DB.prepare(
      'SELECT * FROM dns_records WHERE id = ?'
    ).bind(recordId).first<DnsRecordRow>();

    return successResponse(record, 'DNS记录添加成功');
  });

  /**
   * PUT /api/open/domains/:id/records/:record_id
   * 更新 DNS 记录
   * Body: { type?, name?, content?, ttl?, proxied?, priority? }
   */
  router.put('/api/open/domains/:id/records/:record_id', async (request, env, params) => {
    const auth = await apiKeyAuthMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const subdomainId = parseInt(params.id);
    const recordId = parseInt(params.record_id);

    if (isNaN(subdomainId) || isNaN(recordId)) {
      return errorResponse('无效的参数');
    }

    // 验证域名所有权
    const subdomain = await env.DB.prepare(
      'SELECT * FROM subdomains WHERE id = ? AND user_id = ?'
    ).bind(subdomainId, auth.user.user_id).first<SubdomainRow>();

    if (!subdomain) {
      return errorResponse('域名不存在或无权访问', 404);
    }

    // 验证记录存在且属于该子域名
    const existingRecord = await env.DB.prepare(
      'SELECT * FROM dns_records WHERE id = ? AND subdomain_id = ?'
    ).bind(recordId, subdomainId).first<DnsRecordRow>();

    if (!existingRecord) {
      return errorResponse('DNS记录不存在', 404);
    }

    const body = await request.json() as {
      type?: string;
      name?: string;
      content?: string;
      ttl?: number;
      proxied?: boolean;
      priority?: number | null;
    };

    const updates: string[] = [];
    const bindValues: unknown[] = [];

    if (body.type !== undefined) {
      const validTypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'PTR', 'SOA'];
      if (!validTypes.includes(body.type.toUpperCase())) {
        return errorResponse(`不支持的记录类型: ${body.type}`);
      }
      updates.push('type = ?');
      bindValues.push(body.type.toUpperCase());
    }

    if (body.name !== undefined) {
      updates.push('name = ?');
      bindValues.push(body.name);
    }

    if (body.content !== undefined) {
      updates.push('content = ?');
      bindValues.push(body.content);
    }

    if (body.ttl !== undefined) {
      if (body.ttl < 1) {
        return errorResponse('TTL必须大于等于1');
      }
      updates.push('ttl = ?');
      bindValues.push(body.ttl);
    }

    if (body.proxied !== undefined) {
      updates.push('proxied = ?');
      bindValues.push(body.proxied ? 1 : 0);
    }

    if (body.priority !== undefined) {
      updates.push('priority = ?');
      bindValues.push(body.priority);
    }

    if (updates.length === 0) {
      return errorResponse('没有需要更新的字段');
    }

    updates.push("updated_at = datetime('now')");
    bindValues.push(recordId);

    await env.DB.prepare(
      `UPDATE dns_records SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...bindValues).run();

    const updatedRecord = await env.DB.prepare(
      'SELECT * FROM dns_records WHERE id = ?'
    ).bind(recordId).first<DnsRecordRow>();

    return successResponse(updatedRecord, 'DNS记录更新成功');
  });

  /**
   * DELETE /api/open/domains/:id/records/:record_id
   * 删除 DNS 记录
   */
  router.delete('/api/open/domains/:id/records/:record_id', async (request, env, params) => {
    const auth = await apiKeyAuthMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const subdomainId = parseInt(params.id);
    const recordId = parseInt(params.record_id);

    if (isNaN(subdomainId) || isNaN(recordId)) {
      return errorResponse('无效的参数');
    }

    // 验证域名所有权
    const subdomain = await env.DB.prepare(
      'SELECT * FROM subdomains WHERE id = ? AND user_id = ?'
    ).bind(subdomainId, auth.user.user_id).first<SubdomainRow>();

    if (!subdomain) {
      return errorResponse('域名不存在或无权访问', 404);
    }

    // 验证记录存在且属于该子域名
    const existingRecord = await env.DB.prepare(
      'SELECT * FROM dns_records WHERE id = ? AND subdomain_id = ?'
    ).bind(recordId, subdomainId).first<DnsRecordRow>();

    if (!existingRecord) {
      return errorResponse('DNS记录不存在', 404);
    }

    await env.DB.prepare(
      'DELETE FROM dns_records WHERE id = ? AND subdomain_id = ?'
    ).bind(recordId, subdomainId).run();

    return successResponse(null, 'DNS记录删除成功');
  });
}