/**
 * Cloudflare Workers 入口
 * DNS 分发系统 v3.0.0
 */
import { Router } from './router';
import { rateLimiter } from './middleware/rate-limiter';
import { errorResponse, successResponse } from './utils/response';
import type { Env } from './utils/types';

// 导入路由模块
import { registerAuthRoutes } from './routes/auth';
import { registerDomainRoutes } from './routes/domain';
import { registerRecordRoutes } from './routes/record';
import { registerPlanRoutes } from './routes/plan';
import { registerUserRoutes } from './routes/user';
import { registerCouponRoutes } from './routes/coupon';
import { registerAdminRoutes } from './routes/admin/index';
import { registerTicketRoutes } from './routes/ticket';
import { registerPointsRoutes } from './routes/points';
import { registerTransferRoutes } from './routes/transfer';
import { registerWhoisRoutes } from './routes/whois';
import { registerOpenApiRoutes } from './routes/open_api';
import { registerCronRoutes } from './routes/cron';
import { registerHealthRoutes } from './routes/health';

const router = new Router();

// 全局限流中间件 (60请求/分钟)
router.use(async (request: Request, env: Env) => {
  const url = new URL(request.url);
  if (url.pathname === '/health' || url.pathname.startsWith('/api/cron/') || url.pathname.startsWith('/static/')) {
    return null;
  }
  return rateLimiter(request, env, 60, 60);
});

// 注册所有路由
registerHealthRoutes(router);
registerAuthRoutes(router);
registerDomainRoutes(router);
registerRecordRoutes(router);
registerPlanRoutes(router);
registerUserRoutes(router);
registerCouponRoutes(router);
registerAdminRoutes(router);
registerTicketRoutes(router);
registerPointsRoutes(router);
registerTransferRoutes(router);
registerWhoisRoutes(router);
registerOpenApiRoutes(router);
registerCronRoutes(router);

// 注册静态文件服务和页面路由
registerStaticRoutes(router);
registerPageRoutes(router);

// 全局错误处理
async function handleRequest(request: Request, env: Env): Promise<Response> {
  try {
    return await router.handle(request, env);
  } catch (error: unknown) {
    console.error('Unhandled error:', error);
    const message = error instanceof Error ? error.message : '服务器内部错误';
    return errorResponse(message, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },

  /**
   * Cron 触发器处理
   */
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const cronType = event.cron;

    switch (cronType) {
      case 'check_domain_expiry':
        await handleDomainExpiryCheck(env);
        break;
      case 'auto_renew_domains':
        await handleAutoRenew(env);
        break;
      case 'check_idle_domains':
        await handleIdleDomainCheck(env);
        break;
      case 'daily_reset_email_limits':
        await handleDailyReset(env);
        break;
      case 'cleanup_expired_tokens':
        await handleTokenCleanup(env);
        break;
      default:
        console.log(`Unknown cron trigger: ${cronType}`);
    }
  },
};

// ============ Cron 任务处理函数 ============

async function handleDomainExpiryCheck(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const remindDays = 7; // 提前7天提醒

  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + remindDays);
  const expiryDateStr = expiryDate.toISOString().split('T')[0];

  const expiringDomains = await env.DB.prepare(
    `SELECT s.*, u.email as user_email, u.username as user_username, d.name as domain_name
     FROM subdomains s
     JOIN users u ON s.user_id = u.id
     JOIN domains d ON s.domain_id = d.id
     WHERE s.status = 1 AND s.expires_at IS NOT NULL
     AND date(s.expires_at) <= date(?)
     AND s.expires_at > datetime('now')`
  ).bind(expiryDateStr).all();

  if (expiringDomains.results.length > 0) {
    console.log(`Found ${expiringDomains.results.length} domains expiring soon`);
    // 这里可以发送邮件通知
    // 实际发送邮件需要配置邮件服务 (Mailchannels/Resend等)
  }
}

async function handleAutoRenew(env: Env): Promise<void> {
  const now = new Date().toISOString();

  const result = await env.DB.prepare(
    `SELECT s.*, u.balance as user_balance, p.price as plan_price, p.duration_days
     FROM subdomains s
     JOIN users u ON s.user_id = u.id
     LEFT JOIN plans p ON s.plan_id = p.id
     WHERE s.auto_renew = 1 AND s.status = 1
     AND s.expires_at IS NOT NULL
     AND s.expires_at <= datetime('now', '+1 day')
     AND s.expires_at > datetime('now')`
  ).all();

  for (const sub of result.results) {
    const subdomain = sub as Record<string, unknown>;
    const price = (subdomain.plan_price as number) || 0;
    const balance = (subdomain.user_balance as number) || 0;
    const durationDays = (subdomain.duration_days as number) || 30;

    if (balance >= price) {
      // 自动续费
      const newExpiry = new Date();
      newExpiry.setDate(newExpiry.getDate() + durationDays);

      await env.DB.batch([
        env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ?')
          .bind(price, subdomain.user_id),
        env.DB.prepare('UPDATE subdomains SET expires_at = ?, last_renewed_at = ? WHERE id = ?')
          .bind(newExpiry.toISOString(), now, subdomain.id),
        env.DB.prepare(
          `INSERT INTO purchase_records (user_id, subdomain_id, plan_id, amount, final_amount, subdomain_name)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(subdomain.user_id, subdomain.id, subdomain.plan_id, price, price, subdomain.full_name),
      ]);

      console.log(`Auto-renewed domain ${subdomain.full_name} for user ${subdomain.user_id}`);
    }
  }
}

async function handleIdleDomainCheck(env: Env): Promise<void> {
  const idleDays = 30;
  const idleDate = new Date();
  idleDate.setDate(idleDate.getDate() - idleDays);
  const idleDateStr = idleDate.toISOString();

  const idleDomains = await env.DB.prepare(
    `SELECT s.*, u.email as user_email
     FROM subdomains s
     JOIN users u ON s.user_id = u.id
     WHERE s.status = 1
     AND s.first_record_at IS NULL
     AND s.created_at <= ?
     AND s.idle_reminder_sent_at IS NULL`
  ).bind(idleDateStr).all();

  for (const domain of idleDomains.results) {
    const d = domain as Record<string, unknown>;
    // 发送闲置提醒
    await env.DB.prepare(
      'UPDATE subdomains SET idle_reminder_sent_at = ? WHERE id = ?'
    ).bind(new Date().toISOString(), d.id).run();

    console.log(`Idle reminder sent for domain ${d.full_name}`);
  }
}

async function handleDailyReset(env: Env): Promise<void> {
  const today = new Date().toISOString().split('T')[0];

  // 重置每日邮件发送计数
  await env.DB.prepare(
    `UPDATE email_accounts SET daily_sent = 0, last_reset_at = ?
     WHERE date(last_reset_at) < date(?) OR last_reset_at IS NULL`
  ).bind(today, today).run();

  console.log('Daily email limits reset');
}

async function handleTokenCleanup(env: Env): Promise<void> {
  const now = new Date().toISOString();

  // 清理过期的验证码
  await env.DB.prepare('DELETE FROM email_verifications WHERE expires_at < ?').bind(now).run();
  await env.DB.prepare('DELETE FROM sms_verifications WHERE expires_at < ?').bind(now).run();
  await env.DB.prepare('DELETE FROM magic_link_tokens WHERE expires_at < ?').bind(now).run();

  console.log('Expired tokens cleaned up');
}

// ============ 静态文件服务 ============

// 静态文件 MIME 类型映射
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

// HTML 页面列表 (需要注入的页面)
const HTML_PAGES: Record<string, string> = `
/index.html
/login.html
/register.html
/user/index.html
/user/domains.html
/user/domains/new.html
/user/profile.html
/user/security.html
/user/orders.html
/user/transfers.html
/user/api.html
/whois.html
/pricing.html
/tickets.html
/points.html
/invite.html
/admin/index.html
/admin/users.html
/admin/domains.html
/admin/plans.html
/admin/channels.html
/admin/coupons.html
/admin/tickets.html
/admin/settings.html
/admin/orders.html
/admin/announcements.html
/admin/host/applications.html
/admin/host/hosts.html
/admin/host/withdrawals.html
/host/index.html
/host/apply.html
`.trim().split('\n').filter(Boolean);

function registerStaticRoutes(router: Router) {
  // 静态资源文件
  router.get('/static/*', async (request) => {
    const url = new URL(request.url);
    const filePath = url.pathname.replace('/static/', '');

    try {
      // 尝试从 KV 缓存获取
      // 实际部署时，静态文件应部署到 Workers Sites 或使用 ASSETS binding
      const ext = '.' + (filePath.split('.').pop() || '');
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      // 返回简单的静态文件响应
      // 在生产环境中，应使用 Cloudflare Pages 或 Workers Assets 来提供静态文件
      return new Response(`/* Static file: ${filePath} */`, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400',
        },
      });
    } catch {
      return new Response('File not found', { status: 404 });
    }
  });
}

function registerPageRoutes(router: Router) {
  // 首页
  router.get('/', async () => {
    return serveHtmlPage('index.html');
  });

  // 登录页
  router.get('/login', async () => {
    return serveHtmlPage('login.html');
  });

  // 注册页
  router.get('/register', async () => {
    return serveHtmlPage('register.html');
  });

  // 套餐页
  router.get('/pricing', async () => {
    return serveHtmlPage('pricing.html');
  });

  // WHOIS 页
  router.get('/whois', async () => {
    return serveHtmlPage('whois.html');
  });

  // 用户页面
  router.get('/user', async () => {
    return serveHtmlPage('user/index.html');
  });

  router.get('/user/domains', async () => {
    return serveHtmlPage('user/domains.html');
  });

  router.get('/user/domains/new', async () => {
    return serveHtmlPage('user/domains/new.html');
  });

  router.get('/user/domains/:id', async () => {
    return serveHtmlPage('user/domain_detail.html');
  });

  router.get('/user/profile', async () => {
    return serveHtmlPage('user/profile.html');
  });

  router.get('/user/security', async () => {
    return serveHtmlPage('user/security.html');
  });

  router.get('/user/orders', async () => {
    return serveHtmlPage('user/orders.html');
  });

  router.get('/user/transfers', async () => {
    return serveHtmlPage('user/transfers.html');
  });

  router.get('/user/api', async () => {
    return serveHtmlPage('user/api.html');
  });

  router.get('/user/announcements', async () => {
    return serveHtmlPage('user/announcements.html');
  });

  router.get('/user/redeem', async () => {
    return serveHtmlPage('user/redeem.html');
  });

  router.get('/user/signin', async () => {
    return serveHtmlPage('user/signin.html');
  });

  // 工单
  router.get('/tickets', async () => {
    return serveHtmlPage('tickets.html');
  });

  router.get('/tickets/new', async () => {
    return serveHtmlPage('ticket_new.html');
  });

  router.get('/tickets/:id', async () => {
    return serveHtmlPage('ticket_detail.html');
  });

  // 积分
  router.get('/points', async () => {
    return serveHtmlPage('points.html');
  });

  // 邀请
  router.get('/invite', async () => {
    return serveHtmlPage('invite.html');
  });

  // 免费套餐申请
  router.get('/my-applications', async () => {
    return serveHtmlPage('my_applications.html');
  });

  // 管理后台
  router.get('/admin', async () => {
    return serveHtmlPage('admin/index.html');
  });

  router.get('/admin/*', async () => {
    return serveHtmlPage('admin/index.html');
  });

  // 托管商
  router.get('/host', async () => {
    return serveHtmlPage('host/index.html');
  });

  router.get('/host/*', async () => {
    return serveHtmlPage('host/index.html');
  });
}

/**
 * 提供 HTML 页面
 * 在实际部署时，这些页面可以部署到 Cloudflare Pages 或使用 Workers Sites
 */
async function serveHtmlPage(pageName: string): Promise<Response> {
  // 在开发环境中，HTML 页面通过 import 方式内联
  // 在生产环境中，使用 Workers Assets 或 Pages 来提供静态文件
  const htmlContent = getPageContent(pageName);

  return new Response(htmlContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}

/**
 * 获取页面内容
 * 在生产环境中，这里应该从 Workers Sites 或 KV 中读取
 */
function getPageContent(pageName: string): string {
  // 基础 HTML 模板
  const baseHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>六趣DNS - 域名分发系统</title>
    <link rel="stylesheet" href="/static/css/tailwind.min.css">
    <link rel="stylesheet" href="/static/css/style.css">
    <script defer src="/static/js/alpine.min.js"></script>
    <script defer src="/static/js/app.js"></script>
</head>
<body class="bg-gray-50 min-h-screen">
    <div id="app" class="max-w-7xl mx-auto px-4 py-8">
        <div class="text-center py-16">
            <div class="spinner mx-auto mb-4"></div>
            <p class="text-gray-500">正在加载页面 ${pageName}...</p>
            <p class="text-sm text-gray-400 mt-2">请确保已配置 Cloudflare Workers + D1 + KV</p>
        </div>
    </div>
</body>
</html>`;

  return baseHTML;
}