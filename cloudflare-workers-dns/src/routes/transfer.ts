import { Router } from '../router';
import { successResponse, errorResponse } from '../utils/response';
import { authMiddleware } from '../middleware/auth';
import { generateVerifyCode } from '../utils/crypto';
import type { Env, SubdomainRow } from '../utils/types';

export function registerTransferRoutes(router: Router) {
  /**
   * GET /api/transfers
   * 获取当前用户的所有转让记录（发起的和收到的）
   */
  router.get('/api/transfers', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const transfers = await env.DB.prepare(
      `SELECT * FROM domain_transfers
       WHERE from_user_id = ? OR to_user_id = ?
       ORDER BY created_at DESC`
    ).bind(auth.user.user_id, auth.user.user_id).all();

    return successResponse(transfers.results);
  });

  /**
   * POST /api/transfers
   * 发起域名转让
   * Body: { subdomain_id, to_username, fee_points? }
   */
  router.post('/api/transfers', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const body = await request.json() as {
      subdomain_id: number;
      to_username: string;
      fee_points?: number;
    };

    const { subdomain_id, to_username, fee_points } = body;

    if (!subdomain_id || !to_username) {
      return errorResponse('参数不完整：缺少 subdomain_id 或 to_username');
    }

    // 验证子域名是否存在且属于当前用户
    const subdomain = await env.DB.prepare(
      'SELECT * FROM subdomains WHERE id = ? AND user_id = ?'
    ).bind(subdomain_id, auth.user.user_id).first<SubdomainRow>();

    if (!subdomain) {
      return errorResponse('子域名不存在或不属于您');
    }

    // 验证目标用户是否存在
    const targetUser = await env.DB.prepare(
      'SELECT id, username, status FROM users WHERE username = ?'
    ).bind(to_username).first<{ id: number; username: string; status: number }>();

    if (!targetUser) {
      return errorResponse('目标用户不存在');
    }

    if (targetUser.status !== 1) {
      return errorResponse('目标用户状态异常');
    }

    if (targetUser.id === auth.user.user_id) {
      return errorResponse('不能转让给自己');
    }

    // 检查是否已有进行中的转让
    const existingTransfer = await env.DB.prepare(
      'SELECT id FROM domain_transfers WHERE subdomain_id = ? AND status = 0'
    ).bind(subdomain_id).first();

    if (existingTransfer) {
      return errorResponse('该子域名已有进行中的转让');
    }

    // 获取转让手续费配置
    const transferFeeSetting = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'transfer_fee_points'"
    ).first<{ value: string }>();

    const transferFee = fee_points !== undefined
      ? fee_points
      : parseInt(transferFeeSetting?.value || '0');

    // 扣除发起方积分
    if (transferFee > 0) {
      const user = await env.DB.prepare(
        'SELECT points FROM users WHERE id = ?'
      ).bind(auth.user.user_id).first<{ points: number }>();

      if (!user) {
        return errorResponse('用户不存在');
      }

      if (user.points < transferFee) {
        return errorResponse(`积分不足，需要 ${transferFee} 积分，当前 ${user.points} 积分`);
      }

      await env.DB.prepare(
        'UPDATE users SET points = points - ? WHERE id = ?'
      ).bind(transferFee, auth.user.user_id).run();
    }

    // 生成验证码（10分钟有效期）
    const verifyCode = generateVerifyCode(6);
    const verifyExpires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // 创建转让记录
    const result = await env.DB.prepare(
      `INSERT INTO domain_transfers (subdomain_id, subdomain_name, from_user_id, from_username, to_user_id, to_username, fee_points, verify_code, verify_expires, code_sent_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 0)`
    ).bind(
      subdomain_id,
      subdomain.full_name,
      auth.user.user_id,
      auth.user.username,
      targetUser.id,
      targetUser.username,
      transferFee,
      verifyCode,
      verifyExpires
    ).run();

    // 记录积分变动
    if (transferFee > 0) {
      await env.DB.prepare(
        `INSERT INTO point_records (user_id, type, points, balance, description, related_id)
         VALUES (?, 'transfer_fee', ?, (SELECT points FROM users WHERE id = ?), ?, ?)`
      ).bind(auth.user.user_id, -transferFee, auth.user.user_id, `域名转让手续费: ${subdomain.full_name}`, result.meta.last_row_id).run();
    }

    return successResponse({
      transfer_id: result.meta.last_row_id,
      verify_code: verifyCode,
      fee_points: transferFee,
    }, '转让申请已提交，请将验证码发送给接收方');
  });

  /**
   * POST /api/transfers/:id/verify
   * 验证转让码，完成转让
   * Body: { code }
   */
  router.post('/api/transfers/:id/verify', async (request, env, params) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const transferId = parseInt(params.id);
    const body = await request.json() as { code: string };

    const { code } = body;

    if (!code) {
      return errorResponse('缺少验证码');
    }

    // 查找转让记录
    const transfer = await env.DB.prepare(
      'SELECT * FROM domain_transfers WHERE id = ?'
    ).bind(transferId).first<{
      id: number;
      subdomain_id: number;
      subdomain_name: string;
      from_user_id: number;
      to_user_id: number;
      verify_code: string;
      verify_expires: string;
      status: number;
    }>();

    if (!transfer) {
      return errorResponse('转让记录不存在');
    }

    if (transfer.status !== 0) {
      return errorResponse('该转让已处理');
    }

    // 验证必须是接收方
    if (transfer.to_user_id !== auth.user.user_id) {
      return errorResponse('只有接收方才能验证转让码');
    }

    // 验证验证码
    if (transfer.verify_code !== code) {
      return errorResponse('验证码错误');
    }

    // 检查验证码是否过期
    if (new Date(transfer.verify_expires) < new Date()) {
      return errorResponse('验证码已过期');
    }

    // 更新转让状态和子域名所有权
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE domain_transfers SET status = 1, completed_at = ? WHERE id = ?'
      ).bind(now, transferId),
      env.DB.prepare(
        "UPDATE subdomains SET user_id = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(transfer.to_user_id, transfer.subdomain_id),
    ]);

    return successResponse({
      transfer_id: transferId,
      subdomain_name: transfer.subdomain_name,
    }, '域名转让成功');
  });

  /**
   * POST /api/transfers/:id/cancel
   * 取消转让（仅发起者可操作）
   */
  router.post('/api/transfers/:id/cancel', async (request, env, params) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const transferId = parseInt(params.id);

    const transfer = await env.DB.prepare(
      'SELECT * FROM domain_transfers WHERE id = ?'
    ).bind(transferId).first<{
      id: number;
      subdomain_id: number;
      from_user_id: number;
      fee_points: number;
      status: number;
    }>();

    if (!transfer) {
      return errorResponse('转让记录不存在');
    }

    if (transfer.status !== 0) {
      return errorResponse('该转让已处理，无法取消');
    }

    // 必须是发起者
    if (transfer.from_user_id !== auth.user.user_id) {
      return errorResponse('只有发起者才能取消转让');
    }

    // 退还手续费
    if (transfer.fee_points > 0) {
      await env.DB.prepare(
        'UPDATE users SET points = points + ? WHERE id = ?'
      ).bind(transfer.fee_points, auth.user.user_id).run();
    }

    await env.DB.prepare(
      'UPDATE domain_transfers SET status = 2 WHERE id = ?'
    ).bind(transferId).run();

    return successResponse({
      transfer_id: transferId,
      refunded_points: transfer.fee_points,
    }, '转让已取消');
  });
}