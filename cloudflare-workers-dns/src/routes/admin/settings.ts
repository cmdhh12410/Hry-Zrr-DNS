import { Router } from '../../router';
import { successResponse, errorResponse } from '../../utils/response';
import { authMiddleware } from '../../middleware/auth';

export function registerAdminSettingsRoutes(router: Router) {
  // ============================================================
  // 系统设置
  // ============================================================

  /**
   * GET /api/admin/settings
   * 获取所有系统设置（键值对）
   */
  router.get('/api/admin/settings', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const rows = await env.DB.prepare(
      'SELECT key, value FROM settings ORDER BY key'
    ).all<{ key: string; value: string | null }>();

    const settings: Record<string, string | null> = {};
    for (const row of rows.results) {
      settings[row.key] = row.value;
    }

    return successResponse(settings);
  });

  /**
   * PUT /api/admin/settings
   * 批量更新设置（UPSERT）
   */
  router.put('/api/admin/settings', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    let body: { settings?: Record<string, unknown> };
    try {
      body = await request.json();
    } catch {
      return errorResponse('请求体格式错误');
    }

    if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) {
      return errorResponse('参数 settings 必须是键值对对象');
    }

    const entries = Object.entries(body.settings);
    if (entries.length === 0) {
      return errorResponse('settings 不能为空');
    }

    const stmt = env.DB.prepare(
      'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))'
    );

    const batch: D1PreparedStatement[] = [];
    for (const [key, value] of entries) {
      batch.push(stmt.bind(key, value === null ? null : String(value)));
    }

    await env.DB.batch(batch);

    return successResponse({ updated: entries.length });
  });

  /**
   * GET /api/admin/settings/email
   * 获取邮件设置（SMTP 配置 + 邮箱账号）
   */
  router.get('/api/admin/settings/email', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const smtpKeys = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_password', 'smtp_ssl', 'smtp_from_name', 'email_provider'];
    const placeholders = smtpKeys.map(() => '?').join(',');

    const smtpRows = await env.DB.prepare(
      `SELECT key, value FROM settings WHERE key IN (${placeholders})`
    ).bind(...smtpKeys).all<{ key: string; value: string | null }>();

    const smtp: Record<string, string | null> = {};
    for (const row of smtpRows.results) {
      smtp[row.key] = row.value;
    }
    for (const k of smtpKeys) {
      if (!(k in smtp)) smtp[k] = null;
    }

    const accounts = await env.DB.prepare(
      'SELECT id, name, type, config, daily_limit, daily_sent, priority, enabled, created_at, updated_at FROM email_accounts ORDER BY priority ASC, id ASC'
    ).all();

    return successResponse({ smtp, accounts: accounts.results });
  });

  // ============================================================
  // 邮箱账户管理
  // ============================================================

  /**
   * GET /api/admin/email-accounts
   * 列出所有邮箱账户
   */
  router.get('/api/admin/email-accounts', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const rows = await env.DB.prepare(
      'SELECT id, name, type, config, daily_limit, daily_sent, priority, enabled, created_at, updated_at FROM email_accounts ORDER BY priority ASC, id ASC'
    ).all();

    return successResponse(rows.results);
  });

  /**
   * POST /api/admin/email-accounts
   * 创建邮箱账户
   */
  router.post('/api/admin/email-accounts', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    let body: { name?: string; type?: string; config?: object; daily_limit?: number; priority?: number };
    try {
      body = await request.json();
    } catch {
      return errorResponse('请求体格式错误');
    }

    if (!body.name || !body.type || !body.config) {
      return errorResponse('缺少必填参数: name, type, config');
    }

    if (!['smtp', 'aliyun'].includes(body.type)) {
      return errorResponse('type 必须是 smtp 或 aliyun');
    }

    const result = await env.DB.prepare(
      `INSERT INTO email_accounts (name, type, config, daily_limit, priority, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`
    ).bind(
      body.name,
      body.type,
      JSON.stringify(body.config),
      body.daily_limit ?? 500,
      body.priority ?? 10
    ).run();

    return successResponse({ id: result.meta.last_row_id }, '邮箱账户创建成功');
  });

  /**
   * PUT /api/admin/email-accounts/:id
   * 更新邮箱账户
   */
  router.put('/api/admin/email-accounts/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (isNaN(id)) return errorResponse('无效的ID');

    let body: { name?: string; type?: string; config?: object; daily_limit?: number; priority?: number; enabled?: number };
    try {
      body = await request.json();
    } catch {
      return errorResponse('请求体格式错误');
    }

    const existing = await env.DB.prepare(
      'SELECT id FROM email_accounts WHERE id = ?'
    ).bind(id).first();

    if (!existing) return errorResponse('邮箱账户不存在', 404);

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name);
    }
    if (body.type !== undefined) {
      if (!['smtp', 'aliyun'].includes(body.type)) {
        return errorResponse('type 必须是 smtp 或 aliyun');
      }
      updates.push('type = ?');
      values.push(body.type);
    }
    if (body.config !== undefined) {
      updates.push('config = ?');
      values.push(JSON.stringify(body.config));
    }
    if (body.daily_limit !== undefined) {
      updates.push('daily_limit = ?');
      values.push(body.daily_limit);
    }
    if (body.priority !== undefined) {
      updates.push('priority = ?');
      values.push(body.priority);
    }
    if (body.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(body.enabled);
    }

    if (updates.length === 0) {
      return errorResponse('没有需要更新的字段');
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    await env.DB.prepare(
      `UPDATE email_accounts SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    return successResponse(null, '邮箱账户更新成功');
  });

  /**
   * DELETE /api/admin/email-accounts/:id
   * 删除邮箱账户
   */
  router.delete('/api/admin/email-accounts/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (isNaN(id)) return errorResponse('无效的ID');

    const existing = await env.DB.prepare(
      'SELECT id FROM email_accounts WHERE id = ?'
    ).bind(id).first();

    if (!existing) return errorResponse('邮箱账户不存在', 404);

    await env.DB.prepare('DELETE FROM email_accounts WHERE id = ?').bind(id).run();

    return successResponse(null, '邮箱账户已删除');
  });

  // ============================================================
  // 邮件模板管理
  // ============================================================

  /**
   * GET /api/admin/email-templates
   * 列出所有邮件模板
   */
  router.get('/api/admin/email-templates', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const rows = await env.DB.prepare(
      'SELECT id, name, subject, content, type, status, created_at, updated_at FROM email_templates ORDER BY id ASC'
    ).all();

    return successResponse(rows.results);
  });

  /**
   * PUT /api/admin/email-templates/:id
   * 更新邮件模板
   */
  router.put('/api/admin/email-templates/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (isNaN(id)) return errorResponse('无效的ID');

    let body: { subject?: string; content?: string };
    try {
      body = await request.json();
    } catch {
      return errorResponse('请求体格式错误');
    }

    const existing = await env.DB.prepare(
      'SELECT id FROM email_templates WHERE id = ?'
    ).bind(id).first();

    if (!existing) return errorResponse('邮件模板不存在', 404);

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.subject !== undefined) {
      updates.push('subject = ?');
      values.push(body.subject);
    }
    if (body.content !== undefined) {
      updates.push('content = ?');
      values.push(body.content);
    }

    if (updates.length === 0) {
      return errorResponse('没有需要更新的字段');
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    await env.DB.prepare(
      `UPDATE email_templates SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    return successResponse(null, '邮件模板更新成功');
  });

  // ============================================================
  // IP 黑名单管理
  // ============================================================

  /**
   * GET /api/admin/ip-blacklist
   * 分页列出 IP 黑名单
   */
  router.get('/api/admin/ip-blacklist', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const offset = (page - 1) * pageSize;

    const [rows, totalRow] = await Promise.all([
      env.DB.prepare(
        'SELECT id, ip_address, reason, blocked_by, expires_at, created_at FROM ip_blacklist ORDER BY id DESC LIMIT ? OFFSET ?'
      ).bind(pageSize, offset).all(),
      env.DB.prepare('SELECT COUNT(*) as count FROM ip_blacklist').first<{ count: number }>(),
    ]);

    return successResponse({
      list: rows.results,
      total: totalRow?.count || 0,
      page,
      page_size: pageSize,
    });
  });

  /**
   * POST /api/admin/ip-blacklist
   * 添加 IP 到黑名单
   */
  router.post('/api/admin/ip-blacklist', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    let body: { ip_address?: string; reason?: string; expires_at?: string };
    try {
      body = await request.json();
    } catch {
      return errorResponse('请求体格式错误');
    }

    if (!body.ip_address) {
      return errorResponse('缺少必填参数: ip_address');
    }

    // 检查是否已存在
    const existing = await env.DB.prepare(
      'SELECT id FROM ip_blacklist WHERE ip_address = ?'
    ).bind(body.ip_address).first();

    if (existing) {
      return errorResponse('该IP已在黑名单中');
    }

    const result = await env.DB.prepare(
      `INSERT INTO ip_blacklist (ip_address, reason, blocked_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).bind(
      body.ip_address,
      body.reason || null,
      auth.user.user_id,
      body.expires_at || null
    ).run();

    return successResponse({ id: result.meta.last_row_id }, 'IP已加入黑名单');
  });

  /**
   * DELETE /api/admin/ip-blacklist/:id
   * 从黑名单中移除
   */
  router.delete('/api/admin/ip-blacklist/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (isNaN(id)) return errorResponse('无效的ID');

    const existing = await env.DB.prepare(
      'SELECT id FROM ip_blacklist WHERE id = ?'
    ).bind(id).first();

    if (!existing) return errorResponse('黑名单记录不存在', 404);

    await env.DB.prepare('DELETE FROM ip_blacklist WHERE id = ?').bind(id).run();

    return successResponse(null, '已从黑名单移除');
  });

  // ============================================================
  // 公告管理
  // ============================================================

  /**
   * GET /api/admin/announcements
   * 分页列出公告
   */
  router.get('/api/admin/announcements', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const offset = (page - 1) * pageSize;

    const [rows, totalRow] = await Promise.all([
      env.DB.prepare(
        'SELECT id, title, content, is_pinned, is_popup, status, created_by, created_at, updated_at FROM announcements ORDER BY is_pinned DESC, id DESC LIMIT ? OFFSET ?'
      ).bind(pageSize, offset).all(),
      env.DB.prepare('SELECT COUNT(*) as count FROM announcements').first<{ count: number }>(),
    ]);

    return successResponse({
      list: rows.results,
      total: totalRow?.count || 0,
      page,
      page_size: pageSize,
    });
  });

  /**
   * POST /api/admin/announcements
   * 创建公告
   */
  router.post('/api/admin/announcements', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    let body: { title?: string; content?: string; is_pinned?: boolean; is_popup?: boolean };
    try {
      body = await request.json();
    } catch {
      return errorResponse('请求体格式错误');
    }

    if (!body.title || !body.content) {
      return errorResponse('缺少必填参数: title, content');
    }

    const result = await env.DB.prepare(
      `INSERT INTO announcements (title, content, is_pinned, is_popup, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))`
    ).bind(
      body.title,
      body.content,
      body.is_pinned ? 1 : 0,
      body.is_popup ? 1 : 0,
      auth.user.user_id
    ).run();

    return successResponse({ id: result.meta.last_row_id }, '公告创建成功');
  });

  /**
   * PUT /api/admin/announcements/:id
   * 更新公告
   */
  router.put('/api/admin/announcements/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (isNaN(id)) return errorResponse('无效的ID');

    let body: { title?: string; content?: string; is_pinned?: boolean; is_popup?: boolean; status?: number };
    try {
      body = await request.json();
    } catch {
      return errorResponse('请求体格式错误');
    }

    const existing = await env.DB.prepare(
      'SELECT id FROM announcements WHERE id = ?'
    ).bind(id).first();

    if (!existing) return errorResponse('公告不存在', 404);

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.title !== undefined) {
      updates.push('title = ?');
      values.push(body.title);
    }
    if (body.content !== undefined) {
      updates.push('content = ?');
      values.push(body.content);
    }
    if (body.is_pinned !== undefined) {
      updates.push('is_pinned = ?');
      values.push(body.is_pinned ? 1 : 0);
    }
    if (body.is_popup !== undefined) {
      updates.push('is_popup = ?');
      values.push(body.is_popup ? 1 : 0);
    }
    if (body.status !== undefined) {
      updates.push('status = ?');
      values.push(body.status);
    }

    if (updates.length === 0) {
      return errorResponse('没有需要更新的字段');
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    await env.DB.prepare(
      `UPDATE announcements SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    return successResponse(null, '公告更新成功');
  });

  /**
   * DELETE /api/admin/announcements/:id
   * 删除公告
   */
  router.delete('/api/admin/announcements/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (isNaN(id)) return errorResponse('无效的ID');

    const existing = await env.DB.prepare(
      'SELECT id FROM announcements WHERE id = ?'
    ).bind(id).first();

    if (!existing) return errorResponse('公告不存在', 404);

    await env.DB.prepare('DELETE FROM announcements WHERE id = ?').bind(id).run();

    return successResponse(null, '公告已删除');
  });

  // ============================================================
  // 操作日志
  // ============================================================

  /**
   * GET /api/admin/logs
   * 分页查询操作日志，支持按 user_id 和 action 过滤
   */
  router.get('/api/admin/logs', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const offset = (page - 1) * pageSize;
    const userId = url.searchParams.get('user_id');
    const action = url.searchParams.get('action');

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (userId) {
      conditions.push('user_id = ?');
      values.push(parseInt(userId));
    }
    if (action) {
      conditions.push('action = ?');
      values.push(action);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows, totalRow] = await Promise.all([
      env.DB.prepare(
        `SELECT id, user_id, action, target_type, target_id, details, ip_address, created_at
         FROM operation_logs ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`
      ).bind(...values, pageSize, offset).all(),
      env.DB.prepare(
        `SELECT COUNT(*) as count FROM operation_logs ${whereClause}`
      ).bind(...values).first<{ count: number }>(),
    ]);

    return successResponse({
      list: rows.results,
      total: totalRow?.count || 0,
      page,
      page_size: pageSize,
    });
  });

  // ============================================================
  // 侧边栏菜单管理
  // ============================================================

  /**
   * GET /api/admin/sidebar-menus
   * 获取侧边栏菜单，支持按 menu_type 过滤
   */
  router.get('/api/admin/sidebar-menus', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const menuType = url.searchParams.get('menu_type');

    let rows;
    if (menuType) {
      if (!['admin', 'user'].includes(menuType)) {
        return errorResponse('menu_type 必须是 admin 或 user');
      }
      rows = await env.DB.prepare(
        'SELECT id, menu_type, menu_key, parent_key, name_zh, name_en, icon, url, sort_order, visible, created_at, updated_at FROM sidebar_menus WHERE menu_type = ? ORDER BY sort_order ASC, id ASC'
      ).bind(menuType).all();
    } else {
      rows = await env.DB.prepare(
        'SELECT id, menu_type, menu_key, parent_key, name_zh, name_en, icon, url, sort_order, visible, created_at, updated_at FROM sidebar_menus ORDER BY menu_type, sort_order ASC, id ASC'
      ).all();
    }

    return successResponse(rows.results);
  });

  /**
   * PUT /api/admin/sidebar-menus/:id
   * 更新侧边栏菜单
   */
  router.put('/api/admin/sidebar-menus/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (isNaN(id)) return errorResponse('无效的ID');

    let body: { name_zh?: string; name_en?: string; icon?: string; url?: string; sort_order?: number; visible?: boolean };
    try {
      body = await request.json();
    } catch {
      return errorResponse('请求体格式错误');
    }

    const existing = await env.DB.prepare(
      'SELECT id FROM sidebar_menus WHERE id = ?'
    ).bind(id).first();

    if (!existing) return errorResponse('菜单不存在', 404);

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.name_zh !== undefined) {
      updates.push('name_zh = ?');
      values.push(body.name_zh);
    }
    if (body.name_en !== undefined) {
      updates.push('name_en = ?');
      values.push(body.name_en);
    }
    if (body.icon !== undefined) {
      updates.push('icon = ?');
      values.push(body.icon);
    }
    if (body.url !== undefined) {
      updates.push('url = ?');
      values.push(body.url);
    }
    if (body.sort_order !== undefined) {
      updates.push('sort_order = ?');
      values.push(body.sort_order);
    }
    if (body.visible !== undefined) {
      updates.push('visible = ?');
      values.push(body.visible ? 1 : 0);
    }

    if (updates.length === 0) {
      return errorResponse('没有需要更新的字段');
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    await env.DB.prepare(
      `UPDATE sidebar_menus SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    return successResponse(null, '菜单更新成功');
  });

  // ============================================================
  // Telegram 设置
  // ============================================================

  /**
   * GET /api/admin/telegram
   * 获取 Telegram Bot 设置占位
   */
  router.get('/api/admin/telegram', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    return successResponse({
      bot_token: env.TELEGRAM_BOT_TOKEN ? '***' : null,
      bot_name: null,
      bot_username: null,
      registered_users: 0,
      enabled: !!env.TELEGRAM_BOT_TOKEN,
    });
  });

  // ============================================================
  // 定时任务日志
  // ============================================================

  /**
   * GET /api/admin/cron
   * 分页查询定时任务执行日志
   */
  router.get('/api/admin/cron', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const offset = (page - 1) * pageSize;

    const [rows, totalRow] = await Promise.all([
      env.DB.prepare(
        `SELECT id, task_id, task_name, triggered_by, status, result, error_message, started_at, finished_at, duration
         FROM cron_logs ORDER BY id DESC LIMIT ? OFFSET ?`
      ).bind(pageSize, offset).all(),
      env.DB.prepare('SELECT COUNT(*) as count FROM cron_logs').first<{ count: number }>(),
    ]);

    return successResponse({
      list: rows.results,
      total: totalRow?.count || 0,
      page,
      page_size: pageSize,
    });
  });

  // ============================================================
  // 用户活动记录
  // ============================================================

  /**
   * GET /api/admin/user-activity
   * 分页查询用户活动记录，支持按 user_id 过滤
   */
  router.get('/api/admin/user-activity', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const offset = (page - 1) * pageSize;
    const userId = url.searchParams.get('user_id');

    let whereClause = '';
    const values: unknown[] = [];

    if (userId) {
      whereClause = 'WHERE user_id = ?';
      values.push(parseInt(userId));
    }

    const [rows, totalRow] = await Promise.all([
      env.DB.prepare(
        `SELECT id, user_id, activity_type, activity_data, ip_address, created_at
         FROM user_activities ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`
      ).bind(...values, pageSize, offset).all(),
      env.DB.prepare(
        `SELECT COUNT(*) as count FROM user_activities ${whereClause}`
      ).bind(...values).first<{ count: number }>(),
    ]);

    return successResponse({
      list: rows.results,
      total: totalRow?.count || 0,
      page,
      page_size: pageSize,
    });
  });

  // ============================================================
  // 邀请记录
  // ============================================================

  /**
   * GET /api/admin/invites
   * 分页查询邀请记录
   */
  router.get('/api/admin/invites', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const offset = (page - 1) * pageSize;

    const [rows, totalRow] = await Promise.all([
      env.DB.prepare(
        `SELECT id, inviter_id, invitee_id, invite_code, register_reward, recharge_reward, invitee_reward, status, created_at
         FROM user_invites ORDER BY id DESC LIMIT ? OFFSET ?`
      ).bind(pageSize, offset).all(),
      env.DB.prepare('SELECT COUNT(*) as count FROM user_invites').first<{ count: number }>(),
    ]);

    return successResponse({
      list: rows.results,
      total: totalRow?.count || 0,
      page,
      page_size: pageSize,
    });
  });

  // ============================================================
  // 积分记录
  // ============================================================

  /**
   * GET /api/admin/points
   * 分页查询积分记录，支持按 user_id 和 type 过滤
   */
  router.get('/api/admin/points', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const offset = (page - 1) * pageSize;
    const userId = url.searchParams.get('user_id');
    const type = url.searchParams.get('type');

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (userId) {
      conditions.push('user_id = ?');
      values.push(parseInt(userId));
    }
    if (type) {
      conditions.push('type = ?');
      values.push(type);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows, totalRow] = await Promise.all([
      env.DB.prepare(
        `SELECT id, user_id, type, points, balance, description, related_id, created_at
         FROM point_records ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`
      ).bind(...values, pageSize, offset).all(),
      env.DB.prepare(
        `SELECT COUNT(*) as count FROM point_records ${whereClause}`
      ).bind(...values).first<{ count: number }>(),
    ]);

    return successResponse({
      list: rows.results,
      total: totalRow?.count || 0,
      page,
      page_size: pageSize,
    });
  });

  // ============================================================
  // APP 版本管理
  // ============================================================

  /**
   * GET /api/admin/app-versions
   * 列出所有 APP 版本
   */
  router.get('/api/admin/app-versions', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const rows = await env.DB.prepare(
      `SELECT id, platform, version, build, download_url, file_size, update_log, force_update, min_version, status, download_count, created_at
       FROM app_versions ORDER BY platform, build DESC`
    ).all();

    return successResponse(rows.results);
  });

  /**
   * POST /api/admin/app-versions
   * 创建 APP 版本
   */
  router.post('/api/admin/app-versions', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    let body: { platform?: string; version?: string; build?: number; download_url?: string; file_size?: string; update_log?: string; force_update?: boolean; min_version?: string };
    try {
      body = await request.json();
    } catch {
      return errorResponse('请求体格式错误');
    }

    if (!body.platform || !body.version || !body.build || !body.download_url) {
      return errorResponse('缺少必填参数: platform, version, build, download_url');
    }

    if (!['android', 'ios'].includes(body.platform)) {
      return errorResponse('platform 必须是 android 或 ios');
    }

    const result = await env.DB.prepare(
      `INSERT INTO app_versions (platform, version, build, download_url, file_size, update_log, force_update, min_version, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`
    ).bind(
      body.platform,
      body.version,
      body.build,
      body.download_url,
      body.file_size || null,
      body.update_log || null,
      body.force_update ? 1 : 0,
      body.min_version || null
    ).run();

    return successResponse({ id: result.meta.last_row_id }, 'APP版本创建成功');
  });

  /**
   * PUT /api/admin/app-versions/:id
   * 更新 APP 版本
   */
  router.put('/api/admin/app-versions/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (isNaN(id)) return errorResponse('无效的ID');

    let body: { platform?: string; version?: string; build?: number; download_url?: string; file_size?: string; update_log?: string; force_update?: boolean; min_version?: string; status?: number };
    try {
      body = await request.json();
    } catch {
      return errorResponse('请求体格式错误');
    }

    const existing = await env.DB.prepare(
      'SELECT id FROM app_versions WHERE id = ?'
    ).bind(id).first();

    if (!existing) return errorResponse('APP版本不存在', 404);

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.platform !== undefined) {
      if (!['android', 'ios'].includes(body.platform)) {
        return errorResponse('platform 必须是 android 或 ios');
      }
      updates.push('platform = ?');
      values.push(body.platform);
    }
    if (body.version !== undefined) {
      updates.push('version = ?');
      values.push(body.version);
    }
    if (body.build !== undefined) {
      updates.push('build = ?');
      values.push(body.build);
    }
    if (body.download_url !== undefined) {
      updates.push('download_url = ?');
      values.push(body.download_url);
    }
    if (body.file_size !== undefined) {
      updates.push('file_size = ?');
      values.push(body.file_size);
    }
    if (body.update_log !== undefined) {
      updates.push('update_log = ?');
      values.push(body.update_log);
    }
    if (body.force_update !== undefined) {
      updates.push('force_update = ?');
      values.push(body.force_update ? 1 : 0);
    }
    if (body.min_version !== undefined) {
      updates.push('min_version = ?');
      values.push(body.min_version);
    }
    if (body.status !== undefined) {
      updates.push('status = ?');
      values.push(body.status);
    }

    if (updates.length === 0) {
      return errorResponse('没有需要更新的字段');
    }

    values.push(id);

    await env.DB.prepare(
      `UPDATE app_versions SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    return successResponse(null, 'APP版本更新成功');
  });

  /**
   * DELETE /api/admin/app-versions/:id
   * 删除 APP 版本
   */
  router.delete('/api/admin/app-versions/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (isNaN(id)) return errorResponse('无效的ID');

    const existing = await env.DB.prepare(
      'SELECT id FROM app_versions WHERE id = ?'
    ).bind(id).first();

    if (!existing) return errorResponse('APP版本不存在', 404);

    await env.DB.prepare('DELETE FROM app_versions WHERE id = ?').bind(id).run();

    return successResponse(null, 'APP版本已删除');
  });
}