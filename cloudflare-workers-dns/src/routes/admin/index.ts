import { Router } from '../../router';
import { successResponse, errorResponse } from '../../utils/response';
import { authMiddleware } from '../../middleware/auth';

// 子路由模块
import { registerAdminUserRoutes } from './users';
import { registerAdminDomainRoutes } from './domains';
import { registerAdminPlanRoutes } from './plans';
import { registerAdminChannelRoutes } from './channels';
import { registerAdminCouponRoutes } from './coupons';
import { registerAdminTicketRoutes } from './tickets';
import { registerAdminSettingsRoutes } from './settings';
import { registerAdminOrderRoutes } from './orders';
import { registerAdminRedeemRoutes } from './redeem_codes';
import { registerAdminAnnouncementRoutes } from './announcements';
import { registerAdminHostRoutes } from './host';

export function registerAdminRoutes(router: Router) {
  // 注册所有管理子路由
  registerAdminUserRoutes(router);
  registerAdminDomainRoutes(router);
  registerAdminPlanRoutes(router);
  registerAdminChannelRoutes(router);
  registerAdminCouponRoutes(router);
  registerAdminTicketRoutes(router);
  registerAdminSettingsRoutes(router);
  registerAdminOrderRoutes(router);
  registerAdminRedeemRoutes(router);
  registerAdminAnnouncementRoutes(router);
  registerAdminHostRoutes(router);

  /**
   * GET /api/admin/stats
   * 仪表盘统计数据 (需要管理员权限)
   */
  router.get('/api/admin/stats', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const today = new Date().toISOString().split('T')[0];

    const [
      totalUsers,
      totalDomains,
      totalSubdomains,
      totalRecords,
      todayNewUsers,
      todayOrders,
      totalRevenue,
      pendingTickets,
      pendingHostApps,
    ] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as count FROM users').first<{ count: number }>(),
      env.DB.prepare('SELECT COUNT(*) as count FROM domains').first<{ count: number }>(),
      env.DB.prepare('SELECT COUNT(*) as count FROM subdomains').first<{ count: number }>(),
      env.DB.prepare('SELECT COUNT(*) as count FROM dns_records').first<{ count: number }>(),
      env.DB.prepare(
        `SELECT COUNT(*) as count FROM users WHERE date(created_at) = date(?)`
      ).bind(today).first<{ count: number }>(),
      env.DB.prepare(
        `SELECT COUNT(*) as count FROM purchase_records WHERE date(created_at) = date(?)`
      ).bind(today).first<{ count: number }>(),
      env.DB.prepare('SELECT COALESCE(SUM(final_amount), 0) as total FROM purchase_records').first<{ total: number }>(),
      env.DB.prepare('SELECT COUNT(*) as count FROM tickets WHERE status = 0').first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE host_status = 'pending'").first<{ count: number }>(),
    ]);

    return successResponse({
      total_users: totalUsers?.count || 0,
      total_domains: totalDomains?.count || 0,
      total_subdomains: totalSubdomains?.count || 0,
      total_records: totalRecords?.count || 0,
      today_new_users: todayNewUsers?.count || 0,
      today_orders: todayOrders?.count || 0,
      total_revenue: totalRevenue?.total || 0,
      pending_tickets: pendingTickets?.count || 0,
      pending_host_applications: pendingHostApps?.count || 0,
    });
  });
}