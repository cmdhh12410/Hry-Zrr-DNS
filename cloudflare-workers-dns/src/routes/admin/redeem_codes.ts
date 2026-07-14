import { Router } from '../../router';
import { successResponse, errorResponse } from '../../utils/response';
import { authMiddleware } from '../../middleware/auth';
import { generateRandomString } from '../../utils/crypto';
import type { Env } from '../../utils/types';

export function registerAdminRedeemRoutes(router: Router) {
  /**
   * GET /api/admin/redeem-codes
   * 列出兑换码
   */
  router.get('/api/admin/redeem-codes', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const status = url.searchParams.get('status');
    const batchId = url.searchParams.get('batch_id');
    const search = url.searchParams.get('search');

    let where = 'WHERE 1=1';
    const params: unknown[] = [];

    if (status !== null && status !== '') {
      where += ' AND r.status = ?';
      params.push(parseInt(status));
    }
    if (batchId) {
      where += ' AND r.batch_id = ?';
      params.push(batchId);
    }
    if (search) {
      where += ' AND r.code LIKE ?';
      params.push(`%${search}%`);
    }

    const countResult = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM redeem_codes r ${where}`
    ).bind(...params).first<{ count: number }>();

    const offset = (page - 1) * pageSize;
    const results = await env.DB.prepare(
      `SELECT r.*, 
        cu.username as created_by_username,
        uu.username as used_by_username
       FROM redeem_codes r
       LEFT JOIN users cu ON r.created_by = cu.id
       LEFT JOIN users uu ON r.used_by = uu.id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...params, pageSize, offset).all();

    return successResponse({
      total: countResult?.count || 0,
      page,
      page_size: pageSize,
      total_pages: Math.ceil((countResult?.count || 0) / pageSize),
      items: results.results,
    });
  });

  /**
   * GET /api/admin/redeem-codes/export
   * 导出兑换码 (必须在 :id 之前注册)
   */
  router.get('/api/admin/redeem-codes/export', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const batchId = url.searchParams.get('batch_id');

    if (!batchId) {
      return errorResponse('请指定 batch_id');
    }

    const results = await env.DB.prepare(
      'SELECT code FROM redeem_codes WHERE batch_id = ? ORDER BY id'
    ).bind(batchId).all<{ code: string }>();

    const codes = results.results.map(r => r.code).join('\n');

    return new Response(codes, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="redeem-codes-${batchId}.txt"`,
      },
    });
  });

  /**
   * POST /api/admin/redeem-codes
   * 生成兑换码
   */
  router.post('/api/admin/redeem-codes', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const body = await request.json() as {
      amount: number;
      count: number;
      batch_id?: string;
    };

    const { amount, count } = body;
    if (!amount || amount <= 0) return errorResponse('金额必须大于0');
    if (!count || count <= 0 || count > 1000) return errorResponse('数量必须在1-1000之间');

    const batchId = body.batch_id || `BATCH${Date.now().toString(36).toUpperCase()}`;
    const codes: string[] = [];

    const stmts = [];
    for (let i = 0; i < count; i++) {
      const code = generateRandomString(16).toUpperCase();
      codes.push(code);
      stmts.push(
        env.DB.prepare(
          'INSERT INTO redeem_codes (code, amount, batch_id, created_by) VALUES (?, ?, ?, ?)'
        ).bind(code, amount, batchId, auth.user.user_id)
      );
    }

    await env.DB.batch(stmts);

    return successResponse({
      batch_id: batchId,
      count,
      amount,
      codes,
    }, `成功生成 ${count} 个兑换码`);
  });

  /**
   * GET /api/admin/redeem-codes/:id
   */
  router.get('/api/admin/redeem-codes/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (isNaN(id)) return errorResponse('无效的ID');

    const code = await env.DB.prepare(
      `SELECT r.*, cu.username as created_by_username, uu.username as used_by_username
       FROM redeem_codes r
       LEFT JOIN users cu ON r.created_by = cu.id
       LEFT JOIN users uu ON r.used_by = uu.id
       WHERE r.id = ?`
    ).bind(id).first();

    if (!code) return errorResponse('兑换码不存在', 404);

    return successResponse(code);
  });

  /**
   * PUT /api/admin/redeem-codes/:id
   */
  router.put('/api/admin/redeem-codes/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (isNaN(id)) return errorResponse('无效的ID');

    const existing = await env.DB.prepare('SELECT id FROM redeem_codes WHERE id = ?')
      .bind(id).first();
    if (!existing) return errorResponse('兑换码不存在', 404);

    const body = await request.json() as { status?: number };
    if (body.status !== undefined) {
      await env.DB.prepare('UPDATE redeem_codes SET status = ? WHERE id = ?')
        .bind(body.status, id).run();
    }

    return successResponse(null, '更新成功');
  });

  /**
   * DELETE /api/admin/redeem-codes/:id
   */
  router.delete('/api/admin/redeem-codes/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const id = parseInt(params.id);
    if (isNaN(id)) return errorResponse('无效的ID');

    const existing = await env.DB.prepare('SELECT id FROM redeem_codes WHERE id = ?')
      .bind(id).first();
    if (!existing) return errorResponse('兑换码不存在', 404);

    await env.DB.prepare('DELETE FROM redeem_codes WHERE id = ?').bind(id).run();

    return successResponse(null, '删除成功');
  });
}