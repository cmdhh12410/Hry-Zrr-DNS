import { Router } from '../router';
import { successResponse, errorResponse } from '../utils/response';
import { authMiddleware } from '../middleware/auth';
import type { Env } from '../utils/types';

export function registerPointsRoutes(router: Router) {
  /**
   * GET /api/points/records
   * 获取用户积分记录（分页）
   */
  router.get('/api/points/records', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('page_size') || '20')));
    const offset = (page - 1) * pageSize;

    const totalResult = await env.DB.prepare(
      'SELECT COUNT(*) as total FROM point_records WHERE user_id = ?'
    ).bind(auth.user.user_id).first<{ total: number }>();
    const total = totalResult?.total || 0;

    const records = await env.DB.prepare(
      'SELECT * FROM point_records WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).bind(auth.user.user_id, pageSize, offset).all();

    return successResponse({
      records: records.results,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize),
      },
    });
  });

  /**
   * POST /api/points/signin
   * 每日签到
   */
  router.post('/api/points/signin', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const today = new Date().toISOString().split('T')[0];

    // 检查今天是否已签到
    const existingSignin = await env.DB.prepare(
      "SELECT id FROM user_signins WHERE user_id = ? AND signin_date = ?"
    ).bind(auth.user.user_id, today).first();

    if (existingSignin) {
      return errorResponse('今日已签到');
    }

    // 计算连续签到天数
    let continuousDays = 0;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const lastSignin = await env.DB.prepare(
      'SELECT signin_date FROM user_signins WHERE user_id = ? ORDER BY signin_date DESC LIMIT 1'
    ).bind(auth.user.user_id).first<{ signin_date: string }>();

    if (lastSignin && lastSignin.signin_date === yesterdayStr) {
      // 计算连续天数：从昨天向前累加连续签到天数
      const allRecent = await env.DB.prepare(
        'SELECT signin_date FROM user_signins WHERE user_id = ? ORDER BY signin_date DESC LIMIT 60'
      ).bind(auth.user.user_id).all();

      continuousDays = 1;
      let checkDate = new Date(yesterday);
      for (let i = 0; i < allRecent.results.length; i++) {
        const row = allRecent.results[i] as { signin_date: string };
        if (row.signin_date === checkDate.toISOString().split('T')[0]) {
          continuousDays++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          break;
        }
      }
    }

    // 获取积分设置
    const signinPointsSetting = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'signin_points'"
    ).first<{ value: string }>();
    const continuousBonusSetting = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'signin_continuous_bonus'"
    ).first<{ value: string }>();

    const basePoints = parseInt(signinPointsSetting?.value || '10');
    const continuousBonus = parseInt(continuousBonusSetting?.value || '5');
    const totalPoints = basePoints + continuousBonus * (continuousDays > 0 ? continuousDays - 1 : 0);

    const now = new Date().toISOString();

    // 创建签到记录、积分记录、更新用户积分
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO user_signins (user_id, signin_date, points, continuous_days, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(auth.user.user_id, today, totalPoints, continuousDays > 0 ? continuousDays + 1 : 1, now),
      env.DB.prepare(
        'INSERT INTO point_records (user_id, type, points, description, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(auth.user.user_id, 'signin', totalPoints, `每日签到${continuousDays > 0 ? `（连续${continuousDays + 1}天）` : ''}`, now),
      env.DB.prepare(
        'UPDATE users SET points = points + ?, total_points = total_points + ? WHERE id = ?'
      ).bind(totalPoints, totalPoints, auth.user.user_id),
    ]);

    return successResponse({
      points: totalPoints,
      base_points: basePoints,
      bonus_points: continuousBonus * (continuousDays > 0 ? continuousDays - 1 : 0),
      continuous_days: continuousDays > 0 ? continuousDays + 1 : 1,
    }, '签到成功');
  });

  /**
   * GET /api/points/signin-status
   * 获取今日签到状态
   */
  router.get('/api/points/signin-status', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const today = new Date().toISOString().split('T')[0];

    // 检查今天是否已签到
    const todaySignin = await env.DB.prepare(
      'SELECT * FROM user_signins WHERE user_id = ? AND signin_date = ?'
    ).bind(auth.user.user_id, today).first<{ continuous_days: number; points: number }>();

    // 计算连续签到天数
    let continuousDays = 0;
    if (todaySignin) {
      continuousDays = todaySignin.continuous_days || 1;
    } else {
      const allRecent = await env.DB.prepare(
        'SELECT signin_date FROM user_signins WHERE user_id = ? ORDER BY signin_date DESC LIMIT 60'
      ).bind(auth.user.user_id).all();

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      let checkDate = new Date(yesterday);
      for (let i = 0; i < allRecent.results.length; i++) {
        const row = allRecent.results[i] as { signin_date: string };
        if (row.signin_date === checkDate.toISOString().split('T')[0]) {
          continuousDays++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          break;
        }
      }
    }

    return successResponse({
      signed_in_today: !!todaySignin,
      continuous_days: continuousDays,
      today_points: todaySignin?.points || 0,
    });
  });

  /**
   * POST /api/points/exchange
   * 积分兑换余额
   */
  router.post('/api/points/exchange', async (request, env) => {
    const auth = await authMiddleware(request, env);
    if (auth instanceof Response) return auth;

    const body = await request.json() as { points: number };
    const { points } = body;

    if (!points || points <= 0 || !Number.isInteger(points)) {
      return errorResponse('请输入有效的兑换积分数量');
    }

    // 获取兑换比例
    const ratioSetting = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'points_to_balance_ratio'"
    ).first<{ value: string }>();

    const ratio = parseFloat(ratioSetting?.value || '100');
    if (ratio <= 0) {
      return errorResponse('兑换比例配置错误');
    }

    // 检查用户积分是否足够
    const user = await env.DB.prepare(
      'SELECT points FROM users WHERE id = ?'
    ).bind(auth.user.user_id).first<{ points: number }>();

    if (!user) {
      return errorResponse('用户不存在', 404);
    }

    if (user.points < points) {
      return errorResponse('积分不足');
    }

    const balanceAmount = Math.floor((points / ratio) * 100) / 100; // 保留两位小数
    const now = new Date().toISOString();

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO point_records (user_id, type, points, balance_change, description, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(auth.user.user_id, 'exchange', -points, balanceAmount, `积分兑换余额：${points}积分 → ¥${balanceAmount.toFixed(2)}`, now),
      env.DB.prepare(
        'UPDATE users SET points = points - ?, balance = balance + ? WHERE id = ?'
      ).bind(points, balanceAmount, auth.user.user_id),
    ]);

    return successResponse({
      exchanged_points: points,
      balance_amount: balanceAmount,
      ratio,
    }, '兑换成功');
  });
}