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
    const cronExpr = event.cron;

    switch (cronExpr) {
      case '0 8 * * *':
        await handleDomainExpiryCheck(env);
        break;
      case '0 2 * * *':
        await handleAutoRenew(env);
        break;
      case '0 10 * * *':
        await handleIdleDomainCheck(env);
        break;
      case '0 0 * * *':
        await handleDailyReset(env);
        break;
      case '0 4 * * *':
        await handleTokenCleanup(env);
        break;
      default:
        console.log(`Unknown cron trigger: ${cronExpr}`);
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

const APP_CSS = "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}.nav-active{color:#4f46e5;border-bottom:2px solid #4f46e5}.card{transition:transform .2s,box-shadow .2s}.card:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.1)}.table-row:hover{background-color:#f9fafb}.spinner{border:3px solid #e5e7eb;border-top:3px solid #4f46e5;border-radius:50%;width:24px;height:24px;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}";

const APP_JS = "const API_BASE='';function getToken(){return localStorage.getItem('token')}function setToken(t){localStorage.setItem('token',t)}function removeToken(){localStorage.removeItem('token')}async function apiRequest(u,o){o=o||{};const t=getToken(),h={'Content-Type':'application/json',...o.headers};if(t)h.Authorization='Bearer '+t;const r=await fetch(API_BASE+u,{...o,headers:h}),d=await r.json();if(d.code===401){removeToken();window.location.href='/login';throw new Error('Not logged in')}if(d.code>=400)throw new Error(d.message||'Request failed');return d}function checkAuth(){return{user:null,async init(){const t=getToken();if(!t)return;try{const d=await apiRequest('/api/auth/me');this.user=d.data}catch(e){removeToken()}},async logout(){removeToken();window.location.href='/login'}}}function loginForm(){return{account:'',password:'',error:'',loading:false,async submit(){this.error='';this.loading=true;try{const d=await apiRequest('/api/auth/login',{method:'POST',body:JSON.stringify({account:this.account,password:this.password})});setToken(d.data.token);window.location.href='/user'}catch(e){this.error=e.message}this.loading=false}}}function registerForm(){return{username:'',email:'',password:'',confirmPassword:'',error:'',loading:false,async submit(){this.error='';if(this.password!==this.confirmPassword){this.error='Passwords do not match';return}this.loading=true;try{const d=await apiRequest('/api/auth/register',{method:'POST',body:JSON.stringify({username:this.username,email:this.email,password:this.password})});setToken(d.data.token);window.location.href='/user'}catch(e){this.error=e.message}this.loading=false}}}function loadSubdomains(){return{subdomains:[],async init(){try{const d=await apiRequest('/api/user/domains');this.subdomains=d.data||[]}catch(e){console.error(e)}}}}function loadPlans(){return{plans:[],async init(){try{const d=await apiRequest('/api/plans');this.plans=d.data||[]}catch(e){console.error(e)}}}}function queryWhois(){return{domain:'',result:null,loading:false,async submit(){this.loading=true;try{const d=await apiRequest('/api/whois',{method:'POST',body:JSON.stringify({domain:this.domain})});this.result=d.data}catch(e){console.error(e)}this.loading=false}}}function loadStats(){return{stats:{users:0,domains:0,todayReg:0,balance:0},async init(){try{const d=await apiRequest('/api/admin/stats');if(d.data){this.stats=d.data}}catch(e){console.error(e)}}}}";

const STATIC_FILES: Record<string, { content: string; contentType: string }> = {
  'css/style.css': {
    contentType: 'text/css',
    content: APP_CSS,
  },
  'js/app.js': {
    contentType: 'application/javascript',
    content: APP_JS,
  },
};

function registerStaticRoutes(router: Router) {
  router.get('/static/*', async (request, env, params) => {
    const filePath = params['path'] || '';

    const file = STATIC_FILES[filePath];
    if (file) {
      return new Response(file.content, {
        status: 200,
        headers: {
          'Content-Type': file.contentType,
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    return new Response('File not found', { status: 404 });
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

const PAGES: Record<string, string> = {
  'index.html': `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>六趣DNS - 域名分发系统</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="/static/css/style.css">
    <script defer src="https://unpkg.com/alpinejs@3"></script>
    <script defer src="/static/js/app.js"></script>
</head>
<body class="bg-gray-50 min-h-screen">
    <nav class="bg-white shadow-sm border-b" x-data="checkAuth()">
        <div class="max-w-7xl mx-auto px-4">
            <div class="flex justify-between h-16">
                <div class="flex items-center">
                    <a href="/" class="text-xl font-bold text-indigo-600">六趣DNS</a>
                    <div class="hidden md:flex ml-10 space-x-4">
                        <a href="/" class="px-3 py-2 text-gray-700 hover:text-indigo-600">首页</a>
                        <a href="/pricing" class="px-3 py-2 text-gray-700 hover:text-indigo-600">套餐</a>
                        <a href="/whois" class="px-3 py-2 text-gray-700 hover:text-indigo-600">WHOIS</a>
                    </div>
                </div>
                <div class="hidden md:flex items-center space-x-4">
                    <template x-if="!user">
                        <div class="space-x-2">
                            <a href="/login" class="px-4 py-2 text-gray-700 hover:text-indigo-600">登录</a>
                            <a href="/register" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">注册</a>
                        </div>
                    </template>
                    <template x-if="user">
                        <div class="flex items-center space-x-4">
                            <a href="/user" class="text-gray-700 hover:text-indigo-600" x-text="user.username"></a>
                            <span class="text-sm text-gray-500" x-text="'余额: ¥' + user.balance"></span>
                            <button @click="logout()" class="text-red-500 hover:text-red-700 text-sm">退出</button>
                        </div>
                    </template>
                </div>
            </div>
        </div>
    </nav>
    <main class="max-w-7xl mx-auto px-4 py-8">
        <div class="text-center py-16">
            <h1 class="text-4xl font-bold text-gray-900 mb-4">免费二级域名分发系统</h1>
            <p class="text-xl text-gray-600 mb-8">基于 Cloudflare 的稳定DNS解析服务，支持多种记录类型</p>
            <div class="flex justify-center space-x-4">
                <a href="/login" class="px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium">登录管理</a>
                <a href="/pricing" class="px-6 py-3 border-2 border-indigo-600 text-indigo-600 rounded-lg hover:bg-indigo-50 font-medium">查看套餐</a>
            </div>
        </div>
        <div class="grid md:grid-cols-3 gap-8 py-12">
            <div class="text-center p-6 bg-white rounded-xl shadow-sm">
                <div class="text-4xl mb-4">⚡</div>
                <h3 class="text-lg font-semibold text-gray-900 mb-2">快速部署</h3>
                <p class="text-gray-600">一键创建子域名，即刻生效</p>
            </div>
            <div class="text-center p-6 bg-white rounded-xl shadow-sm">
                <div class="text-4xl mb-4">🔒</div>
                <h3 class="text-lg font-semibold text-gray-900 mb-2">安全可靠</h3>
                <p class="text-gray-600">Cloudflare 全球节点，DDoS防护</p>
            </div>
            <div class="text-center p-6 bg-white rounded-xl shadow-sm">
                <div class="text-4xl mb-4">📊</div>
                <h3 class="text-lg font-semibold text-gray-900 mb-2">实时管理</h3>
                <p class="text-gray-600">完整的域名管理后台</p>
            </div>
        </div>
    </main>
</body>
</html>`,
  'login.html': `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录 - 六趣DNS</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="/static/css/style.css">
    <script defer src="https://unpkg.com/alpinejs@3"></script>
    <script defer src="/static/js/app.js"></script>
</head>
<body class="bg-gray-50 min-h-screen flex items-center justify-center">
    <div class="w-full max-w-md">
        <div class="bg-white rounded-xl shadow-lg p-8">
            <div class="text-center mb-8">
                <h1 class="text-2xl font-bold text-indigo-600">六趣DNS</h1>
                <p class="text-gray-500 mt-2">登录您的账户</p>
            </div>
            <form x-data="loginForm()" @submit.prevent="submit()">
                <div class="mb-4">
                    <label class="block text-sm font-medium text-gray-700 mb-1">邮箱/用户名</label>
                    <input type="text" x-model="account" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" placeholder="请输入邮箱或用户名">
                </div>
                <div class="mb-6">
                    <label class="block text-sm font-medium text-gray-700 mb-1">密码</label>
                    <input type="password" x-model="password" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" placeholder="请输入密码">
                </div>
                <div x-if="error" class="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm">
                    {{ error }}
                </div>
                <button type="submit" class="w-full px-4 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium">登录</button>
            </form>
            <div class="mt-6 text-center">
                <a href="/register" class="text-indigo-600 hover:text-indigo-700">还没有账户？注册</a>
            </div>
        </div>
    </div>
</body>
</html>`,
  'register.html': `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>注册 - 六趣DNS</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="/static/css/style.css">
    <script defer src="https://unpkg.com/alpinejs@3"></script>
    <script defer src="/static/js/app.js"></script>
</head>
<body class="bg-gray-50 min-h-screen flex items-center justify-center">
    <div class="w-full max-w-md">
        <div class="bg-white rounded-xl shadow-lg p-8">
            <div class="text-center mb-8">
                <h1 class="text-2xl font-bold text-indigo-600">六趣DNS</h1>
                <p class="text-gray-500 mt-2">创建新账户</p>
            </div>
            <form x-data="registerForm()" @submit.prevent="submit()">
                <div class="mb-4">
                    <label class="block text-sm font-medium text-gray-700 mb-1">用户名</label>
                    <input type="text" x-model="username" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" placeholder="请输入用户名">
                </div>
                <div class="mb-4">
                    <label class="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
                    <input type="email" x-model="email" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" placeholder="请输入邮箱">
                </div>
                <div class="mb-4">
                    <label class="block text-sm font-medium text-gray-700 mb-1">密码</label>
                    <input type="password" x-model="password" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" placeholder="请输入密码">
                </div>
                <div class="mb-6">
                    <label class="block text-sm font-medium text-gray-700 mb-1">确认密码</label>
                    <input type="password" x-model="confirmPassword" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" placeholder="请再次输入密码">
                </div>
                <div x-if="error" class="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm">
                    {{ error }}
                </div>
                <button type="submit" class="w-full px-4 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium">注册</button>
            </form>
            <div class="mt-6 text-center">
                <a href="/login" class="text-indigo-600 hover:text-indigo-700">已有账户？登录</a>
            </div>
        </div>
    </div>
</body>
</html>`,
  'user/index.html': `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>用户中心 - 六趣DNS</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="/static/css/style.css">
    <script defer src="https://unpkg.com/alpinejs@3"></script>
    <script defer src="/static/js/app.js"></script>
</head>
<body class="bg-gray-50 min-h-screen">
    <nav class="bg-white shadow-sm border-b" x-data="checkAuth()">
        <div class="max-w-7xl mx-auto px-4">
            <div class="flex justify-between h-16">
                <div class="flex items-center">
                    <a href="/" class="text-xl font-bold text-indigo-600">六趣DNS</a>
                </div>
                <div class="flex items-center space-x-4">
                    <span x-text="user?.username" class="text-gray-700"></span>
                    <button @click="logout()" class="text-red-500 hover:text-red-700 text-sm">退出</button>
                </div>
            </div>
        </div>
    </nav>
    <main class="max-w-7xl mx-auto px-4 py-8">
        <div class="grid md:grid-cols-4 gap-8">
            <div class="md:col-span-1">
                <div class="bg-white rounded-xl shadow-sm p-6">
                    <h2 class="text-lg font-semibold text-gray-900 mb-4">菜单</h2>
                    <div class="space-y-2">
                        <a href="/user" class="block px-4 py-2 bg-indigo-50 text-indigo-600 rounded-lg">我的域名</a>
                        <a href="/user/domains" class="block px-4 py-2 text-gray-700 hover:bg-gray-50 rounded-lg">域名管理</a>
                        <a href="/user/profile" class="block px-4 py-2 text-gray-700 hover:bg-gray-50 rounded-lg">个人资料</a>
                        <a href="/user/password" class="block px-4 py-2 text-gray-700 hover:bg-gray-50 rounded-lg">修改密码</a>
                    </div>
                </div>
            </div>
            <div class="md:col-span-3">
                <div class="bg-white rounded-xl shadow-sm p-6">
                    <h2 class="text-xl font-semibold text-gray-900 mb-6">我的域名</h2>
                    <div x-data="loadSubdomains()" x-init="init()" class="space-y-4">
                        <template x-if="subdomains.length === 0">
                            <div class="text-center py-12 text-gray-500">
                                <div class="text-4xl mb-4">📭</div>
                                <p>暂无域名，去购买一个吧！</p>
                                <a href="/pricing" class="inline-block mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">购买域名</a>
                            </div>
                        </template>
                        <template x-for="sub in subdomains" :key="sub.id">
                            <div class="border border-gray-200 rounded-lg p-4">
                                <div class="flex justify-between items-start">
                                    <div>
                                        <h3 class="font-medium text-gray-900" x-text="sub.full_name"></h3>
                                        <p class="text-sm text-gray-500" x-text="'状态: ' + (sub.status === 1 ? '正常' : '已停用')"></p>
                                    </div>
                                    <div class="flex space-x-2">
                                        <button @click="manageDomain(sub)" class="px-3 py-1 text-sm bg-indigo-100 text-indigo-600 rounded-lg hover:bg-indigo-200">管理</button>
                                    </div>
                                </div>
                            </div>
                        </template>
                    </div>
                </div>
            </div>
        </div>
    </main>
</body>
</html>`,
  'admin/index.html': `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>管理后台 - 六趣DNS</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="/static/css/style.css">
    <script defer src="https://unpkg.com/alpinejs@3"></script>
    <script defer src="/static/js/app.js"></script>
</head>
<body class="bg-gray-50 min-h-screen">
    <nav class="bg-white shadow-sm border-b" x-data="checkAuth()">
        <div class="max-w-7xl mx-auto px-4">
            <div class="flex justify-between h-16">
                <div class="flex items-center">
                    <a href="/admin" class="text-xl font-bold text-indigo-600">六趣DNS管理后台</a>
                </div>
                <div class="flex items-center space-x-4">
                    <span x-text="user?.username" class="text-gray-700"></span>
                    <button @click="logout()" class="text-red-500 hover:text-red-700 text-sm">退出</button>
                </div>
            </div>
        </div>
    </nav>
    <main class="max-w-7xl mx-auto px-4 py-8">
        <div class="grid md:grid-cols-4 gap-8">
            <div class="md:col-span-1">
                <div class="bg-white rounded-xl shadow-sm p-6">
                    <h2 class="text-lg font-semibold text-gray-900 mb-4">管理菜单</h2>
                    <div class="space-y-2">
                        <a href="/admin" class="block px-4 py-2 bg-indigo-50 text-indigo-600 rounded-lg">仪表盘</a>
                        <a href="/admin/users" class="block px-4 py-2 text-gray-700 hover:bg-gray-50 rounded-lg">用户管理</a>
                        <a href="/admin/domains" class="block px-4 py-2 text-gray-700 hover:bg-gray-50 rounded-lg">域名管理</a>
                        <a href="/admin/channels" class="block px-4 py-2 text-gray-700 hover:bg-gray-50 rounded-lg">DNS渠道</a>
                        <a href="/admin/plans" class="block px-4 py-2 text-gray-700 hover:bg-gray-50 rounded-lg">套餐管理</a>
                        <a href="/admin/orders" class="block px-4 py-2 text-gray-700 hover:bg-gray-50 rounded-lg">订单管理</a>
                        <a href="/admin/settings" class="block px-4 py-2 text-gray-700 hover:bg-gray-50 rounded-lg">系统设置</a>
                    </div>
                </div>
            </div>
            <div class="md:col-span-3">
                <div class="bg-white rounded-xl shadow-sm p-6">
                    <h2 class="text-xl font-semibold text-gray-900 mb-6">仪表盘</h2>
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-4" x-data="loadStats()" x-init="init()">
                        <div class="bg-indigo-50 rounded-lg p-4 text-center">
                            <div class="text-2xl font-bold text-indigo-600" x-text="stats.users">0</div>
                            <div class="text-sm text-gray-600">用户总数</div>
                        </div>
                        <div class="bg-green-50 rounded-lg p-4 text-center">
                            <div class="text-2xl font-bold text-green-600" x-text="stats.domains">0</div>
                            <div class="text-sm text-gray-600">域名总数</div>
                        </div>
                        <div class="bg-orange-50 rounded-lg p-4 text-center">
                            <div class="text-2xl font-bold text-orange-600" x-text="stats.todayReg">0</div>
                            <div class="text-sm text-gray-600">今日注册</div>
                        </div>
                        <div class="bg-blue-50 rounded-lg p-4 text-center">
                            <div class="text-2xl font-bold text-blue-600" x-text="stats.balance">0</div>
                            <div class="text-sm text-gray-600">系统余额</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </main>
</body>
</html>`,
  'pricing.html': `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>套餐 - 六趣DNS</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="/static/css/style.css">
    <script defer src="https://unpkg.com/alpinejs@3"></script>
    <script defer src="/static/js/app.js"></script>
</head>
<body class="bg-gray-50 min-h-screen">
    <nav class="bg-white shadow-sm border-b" x-data="checkAuth()">
        <div class="max-w-7xl mx-auto px-4">
            <div class="flex justify-between h-16">
                <div class="flex items-center">
                    <a href="/" class="text-xl font-bold text-indigo-600">六趣DNS</a>
                    <div class="hidden md:flex ml-10 space-x-4">
                        <a href="/" class="px-3 py-2 text-gray-700 hover:text-indigo-600">首页</a>
                        <a href="/pricing" class="px-3 py-2 text-indigo-600">套餐</a>
                        <a href="/whois" class="px-3 py-2 text-gray-700 hover:text-indigo-600">WHOIS</a>
                    </div>
                </div>
                <div class="hidden md:flex items-center space-x-4">
                    <template x-if="!user">
                        <div class="space-x-2">
                            <a href="/login" class="px-4 py-2 text-gray-700 hover:text-indigo-600">登录</a>
                            <a href="/register" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">注册</a>
                        </div>
                    </template>
                    <template x-if="user">
                        <a href="/user" class="text-gray-700 hover:text-indigo-600" x-text="user.username"></a>
                    </template>
                </div>
            </div>
        </div>
    </nav>
    <main class="max-w-7xl mx-auto px-4 py-12">
        <div class="text-center mb-12">
            <h1 class="text-3xl font-bold text-gray-900 mb-4">选择套餐</h1>
            <p class="text-gray-600">选择适合您的域名套餐</p>
        </div>
        <div class="grid md:grid-cols-3 gap-8">
            <div x-data="loadPlans()" x-init="init()" class="space-y-4">
                <template x-for="plan in plans" :key="plan.id">
                    <div class="bg-white rounded-xl shadow-sm p-6 border-2" :class="plan.is_free ? 'border-gray-200' : 'border-indigo-500'">
                        <div class="text-center mb-6">
                            <h3 class="text-lg font-semibold text-gray-900" x-text="plan.name"></h3>
                            <div class="mt-2">
                                <span class="text-3xl font-bold" x-text="plan.is_free ? '免费' : ('¥' + plan.price)"></span>
                                <span class="text-gray-500 text-sm" x-text="plan.is_free ? '' : ('/' + plan.duration_days + '天')"></span>
                            </div>
                        </div>
                        <ul class="space-y-2 mb-6">
                            <li class="flex items-center text-gray-600">
                                <span class="text-green-500 mr-2">✓</span>
                                <span x-text="'最多 ' + plan.max_records + ' 条DNS记录'"></span>
                            </li>
                            <li class="flex items-center text-gray-600">
                                <span class="text-green-500 mr-2">✓</span>
                                <span x-text="'支持长度 ' + plan.min_length + '-' + plan.max_length + ' 位'"></span>
                            </li>
                        </ul>
                        <button @click="buyPlan(plan)" class="w-full px-4 py-2 rounded-lg font-medium" :class="plan.is_free ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : 'bg-indigo-600 text-white hover:bg-indigo-700'">
                            <template x-if="plan.is_free">申请免费套餐</template>
                            <template x-else>立即购买</template>
                        </button>
                    </div>
                </template>
            </div>
        </div>
    </main>
</body>
</html>`,
  'whois.html': `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WHOIS查询 - 六趣DNS</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="/static/css/style.css">
    <script defer src="https://unpkg.com/alpinejs@3"></script>
    <script defer src="/static/js/app.js"></script>
</head>
<body class="bg-gray-50 min-h-screen">
    <nav class="bg-white shadow-sm border-b" x-data="checkAuth()">
        <div class="max-w-7xl mx-auto px-4">
            <div class="flex justify-between h-16">
                <div class="flex items-center">
                    <a href="/" class="text-xl font-bold text-indigo-600">六趣DNS</a>
                    <div class="hidden md:flex ml-10 space-x-4">
                        <a href="/" class="px-3 py-2 text-gray-700 hover:text-indigo-600">首页</a>
                        <a href="/pricing" class="px-3 py-2 text-gray-700 hover:text-indigo-600">套餐</a>
                        <a href="/whois" class="px-3 py-2 text-indigo-600">WHOIS</a>
                    </div>
                </div>
                <div class="hidden md:flex items-center space-x-4">
                    <template x-if="!user">
                        <div class="space-x-2">
                            <a href="/login" class="px-4 py-2 text-gray-700 hover:text-indigo-600">登录</a>
                            <a href="/register" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">注册</a>
                        </div>
                    </template>
                    <template x-if="user">
                        <a href="/user" class="text-gray-700 hover:text-indigo-600" x-text="user.username"></a>
                    </template>
                </div>
            </div>
        </div>
    </nav>
    <main class="max-w-3xl mx-auto px-4 py-12">
        <div class="bg-white rounded-xl shadow-sm p-8">
            <div class="text-center mb-8">
                <h1 class="text-2xl font-bold text-gray-900 mb-2">WHOIS查询</h1>
                <p class="text-gray-500">查询域名的注册信息</p>
            </div>
            <form x-data="queryWhois()" @submit.prevent="submit()">
                <div class="flex space-x-4">
                    <input type="text" x-model="domain" class="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" placeholder="请输入域名，如 example.com">
                    <button type="submit" :disabled="loading" class="px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium disabled:opacity-50">查询</button>
                </div>
            </form>
            <div x-if="result" class="mt-8 p-6 bg-gray-50 rounded-lg">
                <pre class="whitespace-pre-wrap text-sm text-gray-700 font-mono" x-text="result.raw"></pre>
            </div>
        </div>
    </main>
</body>
</html>`
};

/**
 * 提供 HTML 页面
 */
async function serveHtmlPage(pageName: string): Promise<Response> {
  let htmlContent = PAGES[pageName] || PAGES['index.html'];

  // 删除外部 CSS 引用（可能有不同的格式）
  htmlContent = htmlContent.replace(/<link[^>]*href="\/static\/css\/style\.css"[^>]*>/gi, '');
  // 删除外部 JS 引用
  htmlContent = htmlContent.replace(/<script[^>]*src="\/static\/js\/app\.js"[^>]*><\/script>/gi, '');

  // 在 </head> 之前插入内联 CSS 和 JS
  const inlineBlock = '<style>' + APP_CSS + '</style>\n<script>' + APP_JS + '</script>';
  htmlContent = htmlContent.replace('</head>', inlineBlock + '\n</head>');

  return new Response(htmlContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}