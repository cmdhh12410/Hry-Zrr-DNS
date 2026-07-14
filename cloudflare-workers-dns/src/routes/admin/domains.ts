import { Router } from '../../router';
import { successResponse, errorResponse } from '../../utils/response';
import { authMiddleware } from '../../middleware/auth';
import type { Env, DomainRow, SubdomainRow, DnsRecordRow } from '../../utils/types';

export function registerAdminDomainRoutes(router: Router) {
  /**
   * GET /api/admin/domains
   * 列出所有域名（分页+搜索），含 DNS 通道信息
   */
  router.get('/api/admin/domains', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const search = url.searchParams.get('search') || '';

    const offset = (page - 1) * pageSize;

    let whereClause = '1=1';
    const bindings: unknown[] = [];

    if (search) {
      whereClause = 'd.name LIKE ?';
      bindings.push(`%${search}%`);
    }

    const countSql = `SELECT COUNT(*) as count FROM domains d WHERE ${whereClause}`;
    const dataSql = `
      SELECT d.*, dc.name as dns_channel_name, dc.provider_type as dns_channel_provider,
             u.username as owner_username, u.email as owner_email,
             (SELECT COUNT(*) FROM subdomains WHERE domain_id = d.id) as subdomain_count
      FROM domains d
      LEFT JOIN dns_channels dc ON d.dns_channel_id = dc.id
      LEFT JOIN users u ON d.owner_id = u.id
      WHERE ${whereClause}
      ORDER BY d.id DESC
      LIMIT ? OFFSET ?
    `;

    const countResult = await env.DB.prepare(countSql).bind(...bindings).first<{ count: number }>();
    const total = countResult?.count || 0;

    const dataResult = await env.DB.prepare(dataSql)
      .bind(...bindings, pageSize, offset)
      .all<DomainRow & {
        dns_channel_name: string | null;
        dns_channel_provider: string | null;
        owner_username: string | null;
        owner_email: string | null;
        subdomain_count: number;
      }>();

    const domains = dataResult.results.map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      allow_register: d.allow_register,
      dns_channel: d.dns_channel_id ? {
        id: d.dns_channel_id,
        name: d.dns_channel_name,
        provider_type: d.dns_channel_provider,
      } : null,
      subdomain_count: d.subdomain_count,
      owner: d.owner_id ? {
        id: d.owner_id,
        username: d.owner_username,
        email: d.owner_email,
      } : null,
      zone_id: d.zone_id,
      allow_ns_transfer: d.allow_ns_transfer,
      description: d.description,
      created_at: d.created_at,
      updated_at: d.updated_at,
    }));

    return successResponse({
      items: domains,
      total,
      page,
      page_size: pageSize,
      total_pages: Math.ceil(total / pageSize),
    });
  });

  /**
   * POST /api/admin/domains
   * 添加域名
   */
  router.post('/api/admin/domains', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const body = await request.json() as {
      name: string;
      dns_channel_id?: number;
      zone_id?: string;
      allow_register?: number;
      allow_ns_transfer?: number;
      description?: string;
      owner_id?: number;
    };

    const { name, dns_channel_id, zone_id, allow_register, allow_ns_transfer, description, owner_id } = body;

    if (!name) {
      return errorResponse('域名 name 不能为空');
    }

    // 检查域名名唯一性
    const existing = await env.DB.prepare(
      'SELECT id FROM domains WHERE name = ?'
    ).bind(name).first<{ id: number }>();

    if (existing) {
      return errorResponse('该域名已存在');
    }

    // 如果指定了 owner_id，验证用户存在
    if (owner_id) {
      const user = await env.DB.prepare(
        'SELECT id FROM users WHERE id = ?'
      ).bind(owner_id).first<{ id: number }>();
      if (!user) {
        return errorResponse('指定的所有者用户不存在');
      }
    }

    const now = new Date().toISOString();

    const result = await env.DB.prepare(
      `INSERT INTO domains (name, dns_channel_id, zone_id, allow_register, allow_ns_transfer, description, owner_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).bind(
      name,
      dns_channel_id ?? null,
      zone_id ?? null,
      allow_register ?? 1,
      allow_ns_transfer ?? 0,
      description ?? null,
      owner_id ?? null,
      now,
      now,
    ).run();

    const domainId = result.meta.last_row_id;

    const domain = await env.DB.prepare(
      'SELECT * FROM domains WHERE id = ?'
    ).bind(domainId).first<DomainRow>();

    return successResponse(domain, '域名添加成功');
  });

  /**
   * PUT /api/admin/domains/:id
   * 更新域名
   */
  router.put('/api/admin/domains/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const domainId = parseInt(params.id);
    if (isNaN(domainId)) {
      return errorResponse('无效的域名ID');
    }

    const domain = await env.DB.prepare(
      'SELECT * FROM domains WHERE id = ?'
    ).bind(domainId).first<DomainRow>();

    if (!domain) {
      return errorResponse('域名不存在', 404);
    }

    const body = await request.json() as {
      name?: string;
      dns_channel_id?: number | null;
      zone_id?: string | null;
      status?: number;
      allow_register?: number;
      allow_ns_transfer?: number;
      description?: string | null;
    };

    const { name, dns_channel_id, zone_id, status, allow_register, allow_ns_transfer, description } = body;

    // 如果更改域名名，检查唯一性
    if (name !== undefined && name !== domain.name) {
      const existing = await env.DB.prepare(
        'SELECT id FROM domains WHERE name = ? AND id != ?'
      ).bind(name, domainId).first<{ id: number }>();
      if (existing) {
        return errorResponse('该域名已存在');
      }
    }

    const now = new Date().toISOString();

    const newName = name !== undefined ? name : domain.name;
    const newChannelId = dns_channel_id !== undefined ? dns_channel_id : domain.dns_channel_id;
    const newZoneId = zone_id !== undefined ? zone_id : domain.zone_id;
    const newStatus = status !== undefined ? status : domain.status;
    const newAllowRegister = allow_register !== undefined ? allow_register : domain.allow_register;
    const newAllowNsTransfer = allow_ns_transfer !== undefined ? allow_ns_transfer : domain.allow_ns_transfer;
    const newDescription = description !== undefined ? description : domain.description;

    await env.DB.prepare(
      `UPDATE domains SET name = ?, dns_channel_id = ?, zone_id = ?, status = ?, allow_register = ?, allow_ns_transfer = ?, description = ?, updated_at = ?
       WHERE id = ?`
    ).bind(
      newName,
      newChannelId,
      newZoneId,
      newStatus,
      newAllowRegister,
      newAllowNsTransfer,
      newDescription,
      now,
      domainId,
    ).run();

    const updated = await env.DB.prepare(
      'SELECT * FROM domains WHERE id = ?'
    ).bind(domainId).first<DomainRow>();

    return successResponse(updated, '域名更新成功');
  });

  /**
   * DELETE /api/admin/domains/:id
   * 删除域名（先检查是否有子域名）
   */
  router.delete('/api/admin/domains/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const domainId = parseInt(params.id);
    if (isNaN(domainId)) {
      return errorResponse('无效的域名ID');
    }

    const domain = await env.DB.prepare(
      'SELECT * FROM domains WHERE id = ?'
    ).bind(domainId).first<DomainRow>();

    if (!domain) {
      return errorResponse('域名不存在', 404);
    }

    // 检查是否有子域名
    const subdomainCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM subdomains WHERE domain_id = ?'
    ).bind(domainId).first<{ count: number }>();

    if (subdomainCount && subdomainCount.count > 0) {
      return errorResponse(`该域名下还有 ${subdomainCount.count} 个子域名，请先删除子域名`);
    }

    await env.DB.prepare('DELETE FROM domains WHERE id = ?').bind(domainId).run();

    return successResponse({ deleted_id: domainId, name: domain.name }, '域名删除成功');
  });

  /**
   * GET /api/admin/subdomains
   * 列出所有用户子域名（分页+筛选+搜索）
   */
  router.get('/api/admin/subdomains', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const search = url.searchParams.get('search') || '';
    const domainId = url.searchParams.get('domain_id');
    const userId = url.searchParams.get('user_id');
    const status = url.searchParams.get('status');

    const offset = (page - 1) * pageSize;

    const conditions: string[] = ['1=1'];
    const bindings: unknown[] = [];

    if (search) {
      conditions.push('s.full_name LIKE ?');
      bindings.push(`%${search}%`);
    }
    if (domainId) {
      conditions.push('s.domain_id = ?');
      bindings.push(parseInt(domainId));
    }
    if (userId) {
      conditions.push('s.user_id = ?');
      bindings.push(parseInt(userId));
    }
    if (status !== null && status !== '') {
      conditions.push('s.status = ?');
      bindings.push(parseInt(status));
    }

    const whereClause = conditions.join(' AND ');

    const countSql = `SELECT COUNT(*) as count FROM subdomains s WHERE ${whereClause}`;
    const dataSql = `
      SELECT s.*, d.name as domain_name, u.username as user_username, u.email as user_email,
             (SELECT COUNT(*) FROM dns_records WHERE subdomain_id = s.id) as record_count
      FROM subdomains s
      JOIN domains d ON s.domain_id = d.id
      JOIN users u ON s.user_id = u.id
      WHERE ${whereClause}
      ORDER BY s.id DESC
      LIMIT ? OFFSET ?
    `;

    const countResult = await env.DB.prepare(countSql).bind(...bindings).first<{ count: number }>();
    const total = countResult?.count || 0;

    const dataResult = await env.DB.prepare(dataSql)
      .bind(...bindings, pageSize, offset)
      .all<SubdomainRow & {
        domain_name: string;
        user_username: string;
        user_email: string;
        record_count: number;
      }>();

    return successResponse({
      items: dataResult.results,
      total,
      page,
      page_size: pageSize,
      total_pages: Math.ceil(total / pageSize),
    });
  });

  /**
   * GET /api/admin/subdomains/:id
   * 获取子域名详情（含 DNS 记录）
   */
  router.get('/api/admin/subdomains/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const subdomainId = parseInt(params.id);
    if (isNaN(subdomainId)) {
      return errorResponse('无效的子域名ID');
    }

    const subdomain = await env.DB.prepare(
      `SELECT s.*, d.name as domain_name, d.zone_id, d.cf_zone_id, d.dns_channel_id,
              u.username as user_username, u.email as user_email,
              p.name as plan_name, p.price as plan_price
       FROM subdomains s
       JOIN domains d ON s.domain_id = d.id
       JOIN users u ON s.user_id = u.id
       LEFT JOIN plans p ON s.plan_id = p.id
       WHERE s.id = ?`
    ).bind(subdomainId).first<SubdomainRow & {
      domain_name: string;
      zone_id: string | null;
      cf_zone_id: string | null;
      dns_channel_id: number | null;
      user_username: string;
      user_email: string;
      plan_name: string | null;
      plan_price: number | null;
    }>();

    if (!subdomain) {
      return errorResponse('子域名不存在', 404);
    }

    const records = await env.DB.prepare(
      'SELECT * FROM dns_records WHERE subdomain_id = ? ORDER BY id ASC'
    ).bind(subdomainId).all<DnsRecordRow>();

    return successResponse({
      ...subdomain,
      dns_records: records.results,
      record_count: records.results.length,
    });
  });

  /**
   * PUT /api/admin/subdomains/:id
   * 更新子域名
   */
  router.put('/api/admin/subdomains/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const subdomainId = parseInt(params.id);
    if (isNaN(subdomainId)) {
      return errorResponse('无效的子域名ID');
    }

    const subdomain = await env.DB.prepare(
      'SELECT * FROM subdomains WHERE id = ?'
    ).bind(subdomainId).first<SubdomainRow>();

    if (!subdomain) {
      return errorResponse('子域名不存在', 404);
    }

    const body = await request.json() as {
      status?: number;
      expires_at?: string;
      auto_renew?: number;
      ns_mode?: number;
    };

    const { status, expires_at, auto_renew, ns_mode } = body;

    const now = new Date().toISOString();

    const newStatus = status !== undefined ? status : subdomain.status;
    const newExpiresAt = expires_at !== undefined ? expires_at : subdomain.expires_at;
    const newAutoRenew = auto_renew !== undefined ? auto_renew : subdomain.auto_renew;
    const newNsMode = ns_mode !== undefined ? ns_mode : subdomain.ns_mode;

    await env.DB.prepare(
      `UPDATE subdomains SET status = ?, expires_at = ?, auto_renew = ?, ns_mode = ?, updated_at = ?
       WHERE id = ?`
    ).bind(newStatus, newExpiresAt, newAutoRenew, newNsMode, now, subdomainId).run();

    const updated = await env.DB.prepare(
      'SELECT * FROM subdomains WHERE id = ?'
    ).bind(subdomainId).first<SubdomainRow>();

    return successResponse(updated, '子域名更新成功');
  });

  /**
   * DELETE /api/admin/subdomains/:id
   * 删除子域名及其 DNS 记录
   */
  router.delete('/api/admin/subdomains/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const subdomainId = parseInt(params.id);
    if (isNaN(subdomainId)) {
      return errorResponse('无效的子域名ID');
    }

    const subdomain = await env.DB.prepare(
      'SELECT * FROM subdomains WHERE id = ?'
    ).bind(subdomainId).first<SubdomainRow>();

    if (!subdomain) {
      return errorResponse('子域名不存在', 404);
    }

    // 删除 DNS 记录
    await env.DB.prepare('DELETE FROM dns_records WHERE subdomain_id = ?').bind(subdomainId).run();

    // 删除子域名
    await env.DB.prepare('DELETE FROM subdomains WHERE id = ?').bind(subdomainId).run();

    return successResponse({
      deleted_id: subdomainId,
      full_name: subdomain.full_name,
    }, '子域名及其 DNS 记录已删除');
  });

  /**
   * GET /api/admin/dns-records
   * 搜索所有 DNS 记录（分页）
   */
  router.get('/api/admin/dns-records', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const search = url.searchParams.get('search') || '';
    const type = url.searchParams.get('type') || '';

    const offset = (page - 1) * pageSize;

    const conditions: string[] = ['1=1'];
    const bindings: unknown[] = [];

    if (search) {
      conditions.push('(r.name LIKE ? OR r.content LIKE ?)');
      bindings.push(`%${search}%`, `%${search}%`);
    }
    if (type) {
      conditions.push('r.type = ?');
      bindings.push(type);
    }

    const whereClause = conditions.join(' AND ');

    const countSql = `SELECT COUNT(*) as count FROM dns_records r WHERE ${whereClause}`;
    const dataSql = `
      SELECT r.*, s.full_name as subdomain_full_name, s.user_id as subdomain_user_id,
             d.name as domain_name
      FROM dns_records r
      LEFT JOIN subdomains s ON r.subdomain_id = s.id
      LEFT JOIN domains d ON s.domain_id = d.id
      WHERE ${whereClause}
      ORDER BY r.id DESC
      LIMIT ? OFFSET ?
    `;

    const countResult = await env.DB.prepare(countSql).bind(...bindings).first<{ count: number }>();
    const total = countResult?.count || 0;

    const dataResult = await env.DB.prepare(dataSql)
      .bind(...bindings, pageSize, offset)
      .all<DnsRecordRow & {
        subdomain_full_name: string | null;
        subdomain_user_id: number | null;
        domain_name: string | null;
      }>();

    return successResponse({
      items: dataResult.results,
      total,
      page,
      page_size: pageSize,
      total_pages: Math.ceil(total / pageSize),
    });
  });

  /**
   * DELETE /api/admin/dns-records/:id
   * 删除 DNS 记录
   */
  router.delete('/api/admin/dns-records/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const recordId = parseInt(params.id);
    if (isNaN(recordId)) {
      return errorResponse('无效的 DNS 记录 ID');
    }

    const record = await env.DB.prepare(
      'SELECT * FROM dns_records WHERE id = ?'
    ).bind(recordId).first<DnsRecordRow>();

    if (!record) {
      return errorResponse('DNS 记录不存在', 404);
    }

    await env.DB.prepare('DELETE FROM dns_records WHERE id = ?').bind(recordId).run();

    return successResponse({
      deleted_id: recordId,
      type: record.type,
      name: record.name,
      content: record.content,
    }, 'DNS 记录删除成功');
  });

  /**
   * GET /api/admin/idle-domains
   * 获取空闲域名（30 天内无 DNS 记录更新）
   */
  router.get('/api/admin/idle-domains', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const days = parseInt(url.searchParams.get('days') || '30');

    const idleSubdomains = await env.DB.prepare(
      `SELECT s.*, d.name as domain_name, u.username as user_username, u.email as user_email,
              (SELECT COUNT(*) FROM dns_records WHERE subdomain_id = s.id) as record_count,
              COALESCE((SELECT MAX(updated_at) FROM dns_records WHERE subdomain_id = s.id), s.created_at) as last_dns_activity
       FROM subdomains s
       JOIN domains d ON s.domain_id = d.id
       JOIN users u ON s.user_id = u.id
       WHERE s.status = 1
         AND (
           (SELECT COUNT(*) FROM dns_records WHERE subdomain_id = s.id) = 0
           OR
           COALESCE((SELECT MAX(updated_at) FROM dns_records WHERE subdomain_id = s.id), s.created_at) < datetime('now', ?)
         )
       ORDER BY last_dns_activity ASC`
    ).bind(`-${days} days`).all<SubdomainRow & {
      domain_name: string;
      user_username: string;
      user_email: string;
      record_count: number;
      last_dns_activity: string;
    }>();

    return successResponse({
      items: idleSubdomains.results,
      total: idleSubdomains.results.length,
      threshold_days: days,
    });
  });

  /**
   * GET /api/admin/transfers
   * 列出所有域名转移记录（分页）
   */
  router.get('/api/admin/transfers', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const status = url.searchParams.get('status') || '';

    const offset = (page - 1) * pageSize;

    const conditions: string[] = ['1=1'];
    const bindings: unknown[] = [];

    if (status !== null && status !== '') {
      conditions.push('t.status = ?');
      bindings.push(parseInt(status));
    }

    const whereClause = conditions.join(' AND ');

    const countSql = `SELECT COUNT(*) as count FROM domain_transfers t WHERE ${whereClause}`;
    const dataSql = `
      SELECT t.*, s.full_name as subdomain_full_name, d.name as domain_name,
             fu.username as from_username, tu.username as to_username
      FROM domain_transfers t
      LEFT JOIN subdomains s ON t.subdomain_id = s.id
      LEFT JOIN domains d ON s.domain_id = d.id
      LEFT JOIN users fu ON t.from_user_id = fu.id
      LEFT JOIN users tu ON t.to_user_id = tu.id
      WHERE ${whereClause}
      ORDER BY t.id DESC
      LIMIT ? OFFSET ?
    `;

    const countResult = await env.DB.prepare(countSql).bind(...bindings).first<{ count: number }>();
    const total = countResult?.count || 0;

    const dataResult = await env.DB.prepare(dataSql)
      .bind(...bindings, pageSize, offset)
      .all();

    return successResponse({
      items: dataResult.results,
      total,
      page,
      page_size: pageSize,
      total_pages: Math.ceil(total / pageSize),
    });
  });
}