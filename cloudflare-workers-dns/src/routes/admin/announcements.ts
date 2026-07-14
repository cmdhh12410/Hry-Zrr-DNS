import { Router } from '../../router';
import { successResponse, errorResponse } from '../../utils/response';
import { authMiddleware } from '../../middleware/auth';
import type { Env } from '../../utils/types';

export function registerAdminAnnouncementRoutes(router: Router) {
  /**
   * GET /api/admin/announcements
   * 列出所有公告
   */
  router.get('/api/admin/announcements', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));

    const countResult = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM announcements'
    ).first<{ count: number }>();

    const offset = (page - 1) * pageSize;
    const results = await env.DB.prepare(
      `SELECT a.*, u.username as created_by_username
       FROM announcements a
       LEFT JOIN users u ON a.created_by = u.id
       ORDER BY a.is_pinned DESC, a.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(pageSize, offset).all();

    return successResponse({
      total: countResult?.count || 0,
      page,
      page_size: pageSize,
      total_pages: Math.ceil((countResult?.count || 0) / pageSize),
      items: results.results,
    });
  });

  /**
   * GET /api/admin/announcements/:id
   */
  router.get('/api/admin/announcements/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (isNaN(id)) return errorResponse('无效的ID');

    const announcement = await env.DB.prepare(
      `SELECT a.*, u.username as created_by_username
       FROM announcements a
       LEFT JOIN users u ON a.created_by = u.id
       WHERE a.id = ?`
    ).bind(id).first();

    if (!announcement) return errorResponse('公告不存在', 404);

    return successResponse(announcement);
  });

  /**
   * POST /api/admin/announcements
   * 创建公告
   */
  router.post('/api/admin/announcements', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const body = await request.json() as {
      title: string;
      content: string;
      is_pinned?: number;
      is_popup?: number;
    };

    const { title, content } = body;
    if (!title || !content) {
      return errorResponse('标题和内容不能为空');
    }

    const result = await env.DB.prepare(
      `INSERT INTO announcements (title, content, is_pinned, is_popup, created_by)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      title,
      content,
      body.is_pinned || 0,
      body.is_popup || 0,
      auth.user.user_id
    ).run();

    return successResponse({
      id: result.meta.last_row_id,
      title,
      content,
    }, '公告创建成功');
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

    const existing = await env.DB.prepare('SELECT id FROM announcements WHERE id = ?')
      .bind(id).first();
    if (!existing) return errorResponse('公告不存在', 404);

    const body = await request.json() as {
      title?: string;
      content?: string;
      is_pinned?: number;
      is_popup?: number;
      status?: number;
    };

    const updates: string[] = [];
    const params_arr: unknown[] = [];

    if (body.title !== undefined) { updates.push('title = ?'); params_arr.push(body.title); }
    if (body.content !== undefined) { updates.push('content = ?'); params_arr.push(body.content); }
    if (body.is_pinned !== undefined) { updates.push('is_pinned = ?'); params_arr.push(body.is_pinned); }
    if (body.is_popup !== undefined) { updates.push('is_popup = ?'); params_arr.push(body.is_popup); }
    if (body.status !== undefined) { updates.push('status = ?'); params_arr.push(body.status); }

    if (updates.length === 0) return errorResponse('没有要更新的字段');

    updates.push("updated_at = datetime('now')");
    params_arr.push(id);

    await env.DB.prepare(
      `UPDATE announcements SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...params_arr).run();

    return successResponse(null, '更新成功');
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

    const existing = await env.DB.prepare('SELECT id FROM announcements WHERE id = ?')
      .bind(id).first();
    if (!existing) return errorResponse('公告不存在', 404);

    await env.DB.prepare('DELETE FROM announcements WHERE id = ?').bind(id).run();

    return successResponse(null, '删除成功');
  });
}