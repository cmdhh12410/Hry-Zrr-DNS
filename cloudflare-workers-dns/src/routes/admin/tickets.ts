import { Router } from '../../router';
import { successResponse, errorResponse } from '../../utils/response';
import { authMiddleware } from '../../middleware/auth';
import type { TicketRow } from '../../utils/types';

export function registerAdminTicketRoutes(router: Router) {
  /**
   * GET /api/admin/tickets
   * 列出所有工单（管理员）
   * Query: ?page=1&page_size=20&status=0&search=keyword
   */
  router.get('/api/admin/tickets', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const status = url.searchParams.get('status');
    const search = url.searchParams.get('search')?.trim();

    const offset = (page - 1) * pageSize;

    let whereClause = '';
    const bindValues: unknown[] = [];

    if (status !== null && status !== '') {
      whereClause += ' WHERE t.status = ?';
      bindValues.push(parseInt(status));
    }

    if (search) {
      const searchPattern = `%${search}%`;
      const prefix = whereClause ? ' AND' : ' WHERE';
      whereClause += `${prefix} (t.subject LIKE ? OR t.content LIKE ? OR t.ticket_no LIKE ?)`;
      bindValues.push(searchPattern, searchPattern, searchPattern);
    }

    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM tickets t${whereClause}`
    ).bind(...bindValues).first<{ count: number }>();

    const total = countResult?.count || 0;

    const tickets = await env.DB.prepare(
      `SELECT t.*,
        u.username AS from_username,
        u.email AS from_email,
        (SELECT COUNT(*) FROM ticket_replies r WHERE r.ticket_id = t.id) AS reply_count
       FROM tickets t
       LEFT JOIN users u ON t.from_user_id = u.id
       ${whereClause}
       ORDER BY t.updated_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...bindValues, pageSize, offset).all<Record<string, unknown>>();

    return successResponse({
      list: tickets.results,
      total,
      page,
      page_size: pageSize,
      total_pages: Math.ceil(total / pageSize),
    });
  });

  /**
   * GET /api/admin/tickets/:id
   * 获取工单详情（管理员），含所有回复及用户信息
   */
  router.get('/api/admin/tickets/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const ticketId = parseInt(params.id);
    if (isNaN(ticketId)) {
      return errorResponse('无效的工单ID');
    }

    const ticket = await env.DB.prepare(
      `SELECT t.*, u.username AS from_username, u.email AS from_email
       FROM tickets t
       LEFT JOIN users u ON t.from_user_id = u.id
       WHERE t.id = ?`
    ).bind(ticketId).first<Record<string, unknown>>();

    if (!ticket) {
      return errorResponse('工单不存在', 404);
    }

    const replies = await env.DB.prepare(
      `SELECT r.*, u.username, u.role
       FROM ticket_replies r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.ticket_id = ?
       ORDER BY r.created_at ASC`
    ).bind(ticketId).all();

    return successResponse({
      ticket,
      replies: replies.results,
    });
  });

  /**
   * POST /api/admin/tickets/:id/reply
   * 管理员回复工单，并将状态更新为 1（处理中）
   */
  router.post('/api/admin/tickets/:id/reply', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const ticketId = parseInt(params.id);
    if (isNaN(ticketId)) {
      return errorResponse('无效的工单ID');
    }

    const ticket = await env.DB.prepare(
      'SELECT * FROM tickets WHERE id = ?'
    ).bind(ticketId).first<TicketRow>();

    if (!ticket) {
      return errorResponse('工单不存在', 404);
    }

    if (ticket.status === 2) {
      return errorResponse('工单已关闭，无法回复');
    }

    const body = await request.json() as { content: string };
    const { content } = body;

    if (!content || !content.trim()) {
      return errorResponse('回复内容不能为空');
    }

    const now = new Date().toISOString();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO ticket_replies (ticket_id, user_id, content, created_at)
         VALUES (?, ?, ?, ?)`
      ).bind(ticketId, auth.user.user_id, content.trim(), now),
      env.DB.prepare(
        `UPDATE tickets SET status = 1, updated_at = ? WHERE id = ?`
      ).bind(now, ticketId),
    ]);

    return successResponse(null, '回复成功');
  });

  /**
   * PUT /api/admin/tickets/:id/status
   * 更新工单状态
   * Body: { status: 0|1|2 }
   * 0=待处理, 1=处理中, 2=已关闭
   */
  router.put('/api/admin/tickets/:id/status', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const ticketId = parseInt(params.id);
    if (isNaN(ticketId)) {
      return errorResponse('无效的工单ID');
    }

    const ticket = await env.DB.prepare(
      'SELECT * FROM tickets WHERE id = ?'
    ).bind(ticketId).first<TicketRow>();

    if (!ticket) {
      return errorResponse('工单不存在', 404);
    }

    const body = await request.json() as { status: number };
    const { status } = body;

    if (status !== 0 && status !== 1 && status !== 2) {
      return errorResponse('无效的状态值，状态必须为 0、1 或 2');
    }

    const now = new Date().toISOString();

    await env.DB.prepare(
      `UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?`
    ).bind(status, now, ticketId).run();

    const statusText = { 0: '待处理', 1: '处理中', 2: '已关闭' }[status];

    return successResponse(null, `工单状态已更新为"${statusText}"`);
  });
}