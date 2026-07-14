import { Router } from '../router';
import { successResponse, errorResponse } from '../utils/response';
import { authMiddleware } from '../middleware/auth';
import type { Env, TicketRow } from '../utils/types';

/**
 * 生成工单编号: TK + 时间戳 + 随机字符串
 */
function generateTicketNo(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `TK${timestamp}${random}`;
}

export function registerTicketRoutes(router: Router) {
  /**
   * GET /api/tickets
   * 获取用户的工单列表（含最新回复数）
   */
  router.get('/api/tickets', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const tickets = await env.DB.prepare(
      `SELECT t.*,
        (SELECT COUNT(*) FROM ticket_replies r WHERE r.ticket_id = t.id) AS reply_count
       FROM tickets t
       WHERE t.from_user_id = ?
       ORDER BY t.updated_at DESC`
    ).bind(auth.user.user_id).all<Record<string, unknown>>();

    return successResponse(tickets.results);
  });

  /**
   * POST /api/tickets
   * 创建工单
   */
  router.post('/api/tickets', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const body = await request.json() as {
      subject: string;
      content: string;
      type?: number;
    };

    const { subject, content, type = 2 } = body;

    if (!subject || !subject.trim()) {
      return errorResponse('工单主题不能为空');
    }

    if (!content || !content.trim()) {
      return errorResponse('工单内容不能为空');
    }

    const ticketNo = generateTicketNo();
    const now = new Date().toISOString();

    const result = await env.DB.prepare(
      `INSERT INTO tickets (ticket_no, type, from_user_id, subject, content, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    ).bind(ticketNo, type, auth.user.user_id, subject.trim(), content.trim(), now, now).run();

    const ticketId = result.meta.last_row_id;

    return successResponse({
      id: ticketId,
      ticket_no: ticketNo,
      subject: subject.trim(),
      content: content.trim(),
      type,
      status: 0,
      created_at: now,
      updated_at: now,
    }, '工单创建成功');
  });

  /**
   * GET /api/tickets/:id
   * 获取工单详情（含所有回复），仅工单所有者或管理员可查看
   */
  router.get('/api/tickets/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env);
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

    if (ticket.from_user_id !== auth.user.user_id && !auth.isAdmin) {
      return errorResponse('无权查看该工单', 403);
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
   * POST /api/tickets/:id/reply
   * 回复工单
   */
  router.post('/api/tickets/:id/reply', async (request, env, params) => {
    const auth = await authMiddleware(request, env);
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

    if (ticket.from_user_id !== auth.user.user_id && !auth.isAdmin) {
      return errorResponse('无权回复该工单', 403);
    }

    if (ticket.status === 2) {
      return errorResponse('工单已关闭，无法回复');
    }

    const body = await request.json() as {
      content: string;
    };

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
        `UPDATE tickets SET updated_at = ?, status = CASE WHEN ? = 'admin' THEN 1 ELSE status END WHERE id = ?`
      ).bind(now, auth.user.role, ticketId),
    ]);

    return successResponse(null, '回复成功');
  });
}