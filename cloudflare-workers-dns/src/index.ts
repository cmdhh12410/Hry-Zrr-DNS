/**
 * Cloudflare Workers 入口
 * DNS 分发系统 v3.0.0
 */
import { Router } from './router';
import { rateLimiter } from './middleware/rate-limiter';
import { errorResponse, successResponse } from './utils/response';
import { setEnv } from './utils/jwt';
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
    setEnv(env);
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

const APP_JS = "const API_BASE='';function getToken(){return localStorage.getItem('token')}function setToken(t){localStorage.setItem('token',t)}function removeToken(){localStorage.removeItem('token')}async function apiRequest(u,o){o=o||{};const t=getToken(),h={'Content-Type':'application/json',...o.headers};if(t)h.Authorization='Bearer '+t;try{const r=await fetch(API_BASE+u,{...o,headers:h});const d=await r.json();if(d.code===401){removeToken();window.location.href='/login';throw new Error('未登录')}if(d.code>=400)throw new Error(d.message||'请求失败');return d}catch(e){if(e.message==='未登录')throw e;throw new Error(e.message||'网络错误')}}function checkAuth(){return{user:null,async init(){const t=getToken();if(!t)return;try{const d=await apiRequest('/api/auth/me');this.user=d.data}catch(e){removeToken()}},async logout(){removeToken();window.location.href='/login'}}}function loginForm(){return{account:'',password:'',error:'',loading:false,async submit(){this.error='';this.loading=true;try{const d=await apiRequest('/api/auth/login',{method:'POST',body:JSON.stringify({account:this.account,password:this.password})});setToken(d.data.token);const isAdmin=d.data.user.role==='admin';window.location.href=isAdmin?'/admin':'/user'}catch(e){this.error=e.message}this.loading=false}}}function registerForm(){return{username:'',email:'',password:'',confirmPassword:'',error:'',loading:false,async submit(){this.error='';if(this.password!==this.confirmPassword){this.error='两次密码不一致';return}this.loading=true;try{const d=await apiRequest('/api/auth/register',{method:'POST',body:JSON.stringify({username:this.username,email:this.email,password:this.password})});setToken(d.data.token);window.location.href='/user'}catch(e){this.error=e.message}this.loading=false}}}function loadPlans(){return{plans:[],loading:false,error:'',async init(){this.loading=true;this.error='';try{const d=await apiRequest('/api/plans');this.plans=d.data||[]}catch(e){this.error=e.message}this.loading=false}}}function queryWhois(){return{domain:'',result:null,loading:false,async submit(){this.loading=true;try{const d=await apiRequest('/api/whois',{method:'POST',body:JSON.stringify({domain:this.domain})});this.result=d.data}catch(e){console.error(e)}this.loading=false}}}function adminDashboard(){return{stats:{users:0,domains:0,todayReg:0,balance:0},loading:false,error:'',async init(){this.loading=true;this.error='';try{const d=await apiRequest('/api/admin/stats');if(d.data){this.stats.users=d.data.total_users||0;this.stats.domains=d.data.total_domains||0;this.stats.todayReg=d.data.today_new_users||0;this.stats.balance=d.data.total_revenue||0}}catch(e){this.error=e.message}this.loading=false}}}function adminUsers(){return{users:[],loading:false,error:'',showModal:false,editing:{id:0,username:'',email:'',role:'user',status:1,balance:0,max_domains:5,points:0},async init(){this.loading=true;this.error='';try{const d=await apiRequest('/api/admin/users');this.users=d.data.users||[]}catch(e){this.error=e.message}this.loading=false},openEdit(user){this.editing=JSON.parse(JSON.stringify(user));this.showModal=true},closeModal(){this.showModal=false},async save(){try{await apiRequest('/api/admin/users/'+this.editing.id,{method:'PUT',body:JSON.stringify({username:this.editing.username,email:this.editing.email,status:this.editing.status,role:this.editing.role,balance:this.editing.balance,max_domains:this.editing.max_domains,points:this.editing.points})});await this.init();this.showModal=false}catch(e){this.error=e.message}},async del(id){if(!confirm('确定要删除这个用户吗？'))return;try{await apiRequest('/api/admin/users/'+id,{method:'DELETE'});await this.init()}catch(e){this.error=e.message}},async toggle(user){user.status=user.status===1?0:1;try{await apiRequest('/api/admin/users/'+user.id,{method:'PUT',body:JSON.stringify({status:user.status})})}catch(e){this.error=e.message;user.status=user.status===1?0:1}}}}function adminDomains(){return{domains:[],loading:false,error:'',async init(){this.loading=true;this.error='';try{const d=await apiRequest('/api/admin/domains');this.domains=d.data.items||[]}catch(e){this.error=e.message}this.loading=false},async toggle(domain){domain.status=domain.status===1?0:1;try{await apiRequest('/api/admin/domains/'+domain.id,{method:'PUT',body:JSON.stringify({status:domain.status})})}catch(e){this.error=e.message;domain.status=domain.status===1?0:1}}}}function adminChannels(){return{channels:[],loading:false,error:'',showAddModal:false,showEditModal:false,adding:{name:'',provider_type:'cloudflare',credentials:''},editing:{id:0,name:'',provider_type:'',status:1,remark:''},async init(){this.loading=true;this.error='';try{const d=await apiRequest('/api/admin/channels');this.channels=d.data||[]}catch(e){this.error=e.message}this.loading=false},openAdd(){this.adding={name:'',provider_type:'cloudflare',credentials:'{}'};this.showAddModal=true},closeAdd(){this.showAddModal=false},async addChannel(){if(!this.adding.name){this.error='请输入渠道名称';return}try{let creds={};try{creds=JSON.parse(this.adding.credentials||'{}')}catch(e){creds={token:this.adding.credentials}}await apiRequest('/api/admin/channels',{method:'POST',body:JSON.stringify({name:this.adding.name,provider_type:this.adding.provider_type,credentials:creds})});await this.init();this.showAddModal=false}catch(e){this.error=e.message}},openEdit(channel){this.editing=JSON.parse(JSON.stringify(channel));this.showEditModal=true},closeEdit(){this.showEditModal=false},async saveChannel(){try{await apiRequest('/api/admin/channels/'+this.editing.id,{method:'PUT',body:JSON.stringify({name:this.editing.name,status:this.editing.status,remark:this.editing.remark})});await this.init();this.showEditModal=false}catch(e){this.error=e.message}},async toggle(channel){channel.status=channel.status===1?0:1;try{await apiRequest('/api/admin/channels/'+channel.id,{method:'PUT',body:JSON.stringify({status:channel.status})})}catch(e){this.error=e.message;channel.status=channel.status===1?0:1}}}}function adminPlans(){return{plans:[],loading:false,error:'',async init(){this.loading=true;this.error='';try{const d=await apiRequest('/api/admin/plans');this.plans=d.data||[]}catch(e){this.error=e.message}this.loading=false}}}function adminOrders(){return{orders:[],loading:false,error:'',async init(){this.loading=true;this.error='';try{const d=await apiRequest('/api/admin/orders');this.orders=d.data.orders||[]}catch(e){this.error=e.message}this.loading=false}}}function adminSettings(){return{settings:{},loading:false,error:'',showModal:false,editingKey:'',editingValue:'',async init(){this.loading=true;this.error='';try{const d=await apiRequest('/api/admin/settings');this.settings=d.data||{}}catch(e){this.error=e.message}this.loading=false},openEdit(key,val){this.editingKey=key;this.editingValue=val===null?'':String(val);this.showModal=true},closeModal(){this.showModal=false},async save(){try{await apiRequest('/api/admin/settings',{method:'PUT',body:JSON.stringify({key:this.editingKey,value:this.editingValue})});this.settings[this.editingKey]=this.editingValue;this.showModal=false}catch(e){this.error=e.message}}}}function adminRouter(){return{currentRoute:'dashboard',init(){const path=window.location.pathname;if(path.startsWith('/admin/users'))this.currentRoute='users';else if(path.startsWith('/admin/domains'))this.currentRoute='domains';else if(path.startsWith('/admin/channels'))this.currentRoute='channels';else if(path.startsWith('/admin/plans'))this.currentRoute='plans';else if(path.startsWith('/admin/orders'))this.currentRoute='orders';else if(path.startsWith('/admin/settings'))this.currentRoute='settings';else this.currentRoute='dashboard';const self=this;window.addEventListener('popstate',function(){self.init()})},navigate(route){this.currentRoute=route;window.history.pushState({},'','/admin/'+(route==='dashboard'?'':route))}}}function userRouter(){return{currentRoute:'dashboard',init(){const path=window.location.pathname;if(path.startsWith('/user/domains'))this.currentRoute='domains';else if(path.startsWith('/user/profile'))this.currentRoute='profile';else if(path.startsWith('/user/security'))this.currentRoute='security';else if(path.startsWith('/user/orders'))this.currentRoute='orders';else if(path.startsWith('/user/api'))this.currentRoute='api';else this.currentRoute='dashboard';const self=this;window.addEventListener('popstate',function(){self.init()})},navigate(route){this.currentRoute=route;window.history.pushState({},'','/user/'+(route==='dashboard'?'':route))}}}function userProfile(){return{user:{id:0,username:'',email:'',phone:'',balance:0,points:0,max_domains:5,created_at:''},loading:false,error:'',editMode:false,async init(){this.loading=true;this.error='';try{const d=await apiRequest('/api/auth/me');this.user=d.data}catch(e){this.error=e.message}this.loading=false},toggleEdit(){this.editMode=!this.editMode},async save(){try{await apiRequest('/api/user/profile',{method:'PUT',body:JSON.stringify({username:this.user.username,email:this.user.email,phone:this.user.phone})});const d=await apiRequest('/api/auth/me');this.user=d.data;this.editMode=false;alert('保存成功')}catch(e){this.error=e.message}}}}function userPassword(){return{oldPassword:'',newPassword:'',confirmPassword:'',error:'',loading:false,async submit(){this.error='';if(this.newPassword!==this.confirmPassword){this.error='两次输入的密码不一致';return}if(this.newPassword.length<6){this.error='密码长度不能少于6位';return}this.loading=true;try{await apiRequest('/api/auth/change-password',{method:'PUT',body:JSON.stringify({old_password:this.oldPassword,new_password:this.newPassword})});alert('密码修改成功');this.oldPassword='';this.newPassword='';this.confirmPassword=''}catch(e){this.error=e.message}this.loading=false}}}function userDomains(){return{domains:[],loading:false,error:'',async init(){this.loading=true;this.error='';try{const d=await apiRequest('/api/user/domains');this.domains=d.data||[]}catch(e){this.error=e.message}this.loading=false}}}function userApi(){return{apiKey:'',apiSecret:'',loading:false,async init(){this.loading=true;try{const d=await apiRequest('/api/auth/me');this.apiKey=d.data.api_key||'';this.apiSecret=d.data.api_secret||''}catch(e){console.error(e)}this.loading=false},async generate(){if(!confirm('确定要生成新的API密钥吗？旧密钥将失效'))return;try{await apiRequest('/api/user/api/generate',{method:'POST'});await this.init()}catch(e){alert(e.message)}}}}";

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

  // 用户页面 (SPA - all routes serve the same page)
  router.get('/user', async () => {
    return serveHtmlPage('user/index.html');
  });

  router.get('/user/*', async () => {
    return serveHtmlPage('user/index.html');
  });

  // 工单
  router.get('/tickets', async () => {
    return serveHtmlPage('index.html');
  });

  router.get('/tickets/*', async () => {
    return serveHtmlPage('index.html');
  });

  // 积分
  router.get('/points', async () => {
    return serveHtmlPage('index.html');
  });

  // 邀请
  router.get('/invite', async () => {
    return serveHtmlPage('index.html');
  });

  // 免费套餐申请
  router.get('/my-applications', async () => {
    return serveHtmlPage('index.html');
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
                <div x-if="error" class="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm" x-text="error"></div>
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
                <div x-if="error" class="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm" x-text="error"></div>
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
    <script defer src="https://unpkg.com/alpinejs@3"></script>
    <style>
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;margin:0}
        .spinner{border:3px solid #e5e7eb;border-top:3px solid #4f46e5;border-radius:50%;width:24px;height:24px;animation:spin .8s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
    </style>
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

    <div class="max-w-7xl mx-auto px-4 py-8">
        <div class="grid md:grid-cols-4 gap-8" x-data="userRouter()" x-init="init()">
            <!-- Sidebar -->
            <div class="md:col-span-1">
                <div class="bg-white rounded-xl shadow-sm p-6">
                    <h2 class="text-lg font-semibold text-gray-900 mb-4">菜单</h2>
                    <div class="space-y-2">
                        <button @click="navigate('dashboard')" class="w-full text-left px-4 py-2 rounded-lg transition-colors" :class="currentRoute === 'dashboard' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'">我的域名</button>
                        <button @click="navigate('domains')" class="w-full text-left px-4 py-2 rounded-lg transition-colors" :class="currentRoute === 'domains' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'">域名管理</button>
                        <button @click="navigate('profile')" class="w-full text-left px-4 py-2 rounded-lg transition-colors" :class="currentRoute === 'profile' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'">个人资料</button>
                        <button @click="navigate('security')" class="w-full text-left px-4 py-2 rounded-lg transition-colors" :class="currentRoute === 'security' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'">修改密码</button>
                        <button @click="navigate('orders')" class="w-full text-left px-4 py-2 rounded-lg transition-colors" :class="currentRoute === 'orders' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'">订单记录</button>
                        <button @click="navigate('api')" class="w-full text-left px-4 py-2 rounded-lg transition-colors" :class="currentRoute === 'api' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'">API管理</button>
                    </div>
                </div>
            </div>

            <!-- Main Content -->
            <div class="md:col-span-3">

                <!-- Dashboard (My Domains) -->
                <div x-show="currentRoute === 'dashboard'">
                    <div class="bg-white rounded-xl shadow-sm p-6">
                        <h2 class="text-xl font-semibold text-gray-900 mb-6">我的域名</h2>
                        <div x-data="userDomains()" x-init="init()">
                            <div x-if="error" class="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm" x-text="error"></div>
                            <div x-if="loading" class="flex justify-center py-8"><div class="spinner"></div></div>
                            <div x-show="!loading">
                                <div x-if="domains.length === 0" class="text-center py-12 text-gray-500">
                                    <div class="text-4xl mb-4">📭</div>
                                    <p>暂无域名，去购买一个吧！</p>
                                    <a href="/pricing" class="inline-block mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">购买域名</a>
                                </div>
                                <div x-else class="space-y-4">
                                    <template x-for="domain in domains" :key="domain.id">
                                        <div class="border rounded-lg p-4">
                                            <div class="flex justify-between items-center">
                                                <div>
                                                    <h3 class="font-semibold" x-text="domain.subdomain_name + '.' + domain.domain_name"></h3>
                                                    <p class="text-sm text-gray-500">套餐: <span x-text="domain.plan_name || '免费'"></span></p>
                                                </div>
                                                <div class="space-x-2">
                                                    <button class="px-3 py-1 text-sm bg-indigo-100 text-indigo-600 rounded-lg hover:bg-indigo-200">管理DNS</button>
                                                </div>
                                            </div>
                                        </div>
                                    </template>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Domain Management -->
                <div x-show="currentRoute === 'domains'">
                    <div class="bg-white rounded-xl shadow-sm p-6">
                        <h2 class="text-xl font-semibold text-gray-900 mb-6">域名管理</h2>
                        <div x-data="userDomains()" x-init="init()">
                            <div x-if="error" class="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm" x-text="error"></div>
                            <div x-if="loading" class="flex justify-center py-8"><div class="spinner"></div></div>
                            <div x-show="!loading">
                                <div x-if="domains.length === 0" class="text-center py-12 text-gray-500">
                                    <div class="text-4xl mb-4">📭</div>
                                    <p>暂无域名，去购买一个吧！</p>
                                    <a href="/pricing" class="inline-block mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">购买域名</a>
                                </div>
                                <div x-else class="space-y-4">
                                    <template x-for="domain in domains" :key="domain.id">
                                        <div class="border rounded-lg p-4">
                                            <div class="flex justify-between items-center">
                                                <div>
                                                    <h3 class="font-semibold" x-text="domain.subdomain_name + '.' + domain.domain_name"></h3>
                                                    <p class="text-sm text-gray-500">状态: <span :class="domain.status === 1 ? 'text-green-600' : 'text-gray-600'" x-text="domain.status === 1 ? '正常' : '已禁用'"></span></p>
                                                    <p class="text-sm text-gray-500">套餐: <span x-text="domain.plan_name || '免费'"></span></p>
                                                    <p class="text-sm text-gray-500">到期时间: <span x-text="domain.expired_at || '永久'"></span></p>
                                                </div>
                                                <div class="space-x-2">
                                                    <button class="px-3 py-1 text-sm bg-indigo-100 text-indigo-600 rounded-lg hover:bg-indigo-200">管理DNS</button>
                                                    <button class="px-3 py-1 text-sm bg-green-100 text-green-600 rounded-lg hover:bg-green-200">添加记录</button>
                                                </div>
                                            </div>
                                        </div>
                                    </template>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Profile -->
                <div x-show="currentRoute === 'profile'">
                    <div class="bg-white rounded-xl shadow-sm p-6">
                        <div x-data="userProfile()" x-init="init()">
                        <div class="flex justify-between items-center mb-6">
                            <h2 class="text-xl font-semibold text-gray-900">个人资料</h2>
                            <button @click="toggleEdit()" class="px-4 py-2 text-indigo-600 hover:bg-indigo-50 rounded-lg" x-text="editMode ? '取消' : '编辑'">编辑</button>
                        </div>
                            <div x-if="error" class="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm" x-text="error"></div>
                            <div x-if="loading" class="flex justify-center py-8"><div class="spinner"></div></div>
                            <div x-show="!loading" class="space-y-4">
                                <div class="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                                    <span class="text-gray-700">用户名</span>
                                    <input x-show="editMode" type="text" x-model="user.username" class="px-3 py-1 border border-gray-300 rounded text-right">
                                    <span x-show="!editMode" x-text="user.username || '-'"></span>
                                </div>
                                <div class="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                                    <span class="text-gray-700">邮箱</span>
                                    <input x-show="editMode" type="email" x-model="user.email" class="px-3 py-1 border border-gray-300 rounded text-right">
                                    <span x-show="!editMode" x-text="user.email || '-'"></span>
                                </div>
                                <div class="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                                    <span class="text-gray-700">手机号</span>
                                    <input x-show="editMode" type="text" x-model="user.phone" class="px-3 py-1 border border-gray-300 rounded text-right">
                                    <span x-show="!editMode" x-text="user.phone || '未设置'"></span>
                                </div>
                                <div class="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                                    <span class="text-gray-700">余额</span>
                                    <span class="font-medium" x-text="user.balance === -1 ? '无限' : ('¥' + user.balance)"></span>
                                </div>
                                <div class="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                                    <span class="text-gray-700">积分</span>
                                    <span x-text="user.points || 0"></span>
                                </div>
                                <div class="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                                    <span class="text-gray-700">最大域名数</span>
                                    <span x-text="user.max_domains || 5"></span>
                                </div>
                                <div class="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                                    <span class="text-gray-700">注册时间</span>
                                    <span x-text="user.created_at || '-'"></span>
                                </div>
                                <div x-show="editMode" class="pt-4">
                                    <button @click="save()" class="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">保存修改</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Security / Change Password -->
                <div x-show="currentRoute === 'security'">
                    <div class="bg-white rounded-xl shadow-sm p-6">
                        <h2 class="text-xl font-semibold text-gray-900 mb-6">修改密码</h2>
                        <div x-data="userPassword()">
                            <div x-if="error" class="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm" x-text="error"></div>
                            <div class="space-y-4 max-w-md">
                                <div>
                                    <label class="block text-sm font-medium mb-1">原密码</label>
                                    <input type="password" x-model="oldPassword" class="w-full px-3 py-2 border border-gray-300 rounded-lg" placeholder="请输入原密码">
                                </div>
                                <div>
                                    <label class="block text-sm font-medium mb-1">新密码</label>
                                    <input type="password" x-model="newPassword" class="w-full px-3 py-2 border border-gray-300 rounded-lg" placeholder="请输入新密码">
                                </div>
                                <div>
                                    <label class="block text-sm font-medium mb-1">确认新密码</label>
                                    <input type="password" x-model="confirmPassword" class="w-full px-3 py-2 border border-gray-300 rounded-lg" placeholder="请再次输入新密码">
                                </div>
                                <button @click="submit()" :disabled="loading" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50" x-text="loading ? '修改中...' : '修改密码'">修改密码</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Orders -->
                <div x-show="currentRoute === 'orders'">
                    <div class="bg-white rounded-xl shadow-sm p-6">
                        <h2 class="text-xl font-semibold text-gray-900 mb-6">订单记录</h2>
                        <div class="text-center py-12 text-gray-500">
                            <div class="text-4xl mb-4">📋</div>
                            <p>暂无订单记录</p>
                        </div>
                    </div>
                </div>

                <!-- API Management -->
                <div x-show="currentRoute === 'api'">
                    <div class="bg-white rounded-xl shadow-sm p-6">
                        <div x-data="userApi()" x-init="init()">
                        <div class="flex justify-between items-center mb-6">
                            <h2 class="text-xl font-semibold text-gray-900">API管理</h2>
                            <button @click="generate()" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">生成新密钥</button>
                        </div>
                            <div x-if="loading" class="flex justify-center py-8"><div class="spinner"></div></div>
                            <div x-show="!loading" class="space-y-4 max-w-lg">
                                <div>
                                    <label class="block text-sm font-medium mb-1">API Key</label>
                                    <input type="text" x-model="apiKey" readonly class="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-100 font-mono">
                                </div>
                                <div>
                                    <label class="block text-sm font-medium mb-1">API Secret</label>
                                    <input type="text" x-model="apiSecret" readonly class="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-100 font-mono">
                                </div>
                                <div class="p-4 bg-blue-50 rounded-lg">
                                    <p class="text-sm text-blue-700">请保存好您的API密钥，刷新页面后将无法再次查看API Secret。</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

            </div>
        </div>
    </div>
</body>
</html>`,
  'admin/index.html': `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>管理后台 - 六趣DNS</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script defer src="https://unpkg.com/alpinejs@3"></script>
    <style>
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;margin:0}
        .spinner{border:3px solid #e5e7eb;border-top:3px solid #4f46e5;border-radius:50%;width:24px;height:24px;animation:spin .8s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
        .modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:50}
        .modal-content{background:white;border-radius:12px;padding:24px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto}
    </style>
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

    <div class="max-w-7xl mx-auto px-4 py-8">
        <div class="grid md:grid-cols-4 gap-8" x-data="adminRouter()" x-init="init()">
            <!-- Sidebar -->
            <div class="md:col-span-1">
                <div class="bg-white rounded-xl shadow-sm p-6">
                    <h2 class="text-lg font-semibold text-gray-900 mb-4">管理菜单</h2>
                    <div class="space-y-2">
                        <button @click="navigate('dashboard')" class="w-full text-left px-4 py-2 rounded-lg transition-colors" :class="currentRoute === 'dashboard' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'">仪表盘</button>
                        <button @click="navigate('users')" class="w-full text-left px-4 py-2 rounded-lg transition-colors" :class="currentRoute === 'users' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'">用户管理</button>
                        <button @click="navigate('domains')" class="w-full text-left px-4 py-2 rounded-lg transition-colors" :class="currentRoute === 'domains' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'">域名管理</button>
                        <button @click="navigate('channels')" class="w-full text-left px-4 py-2 rounded-lg transition-colors" :class="currentRoute === 'channels' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'">DNS渠道</button>
                        <button @click="navigate('plans')" class="w-full text-left px-4 py-2 rounded-lg transition-colors" :class="currentRoute === 'plans' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'">套餐管理</button>
                        <button @click="navigate('orders')" class="w-full text-left px-4 py-2 rounded-lg transition-colors" :class="currentRoute === 'orders' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'">订单管理</button>
                        <button @click="navigate('settings')" class="w-full text-left px-4 py-2 rounded-lg transition-colors" :class="currentRoute === 'settings' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'">系统设置</button>
                    </div>
                </div>
            </div>

            <!-- Main Content -->
            <div class="md:col-span-3">

                <!-- Dashboard -->
                <div x-show="currentRoute === 'dashboard'">
                    <div class="bg-white rounded-xl shadow-sm p-6">
                        <h2 class="text-xl font-semibold text-gray-900 mb-6">仪表盘</h2>
                        <div x-data="adminDashboard()" x-init="init()">
                            <div x-if="loading" class="flex justify-center py-8"><div class="spinner"></div></div>
                            <div x-show="!loading" class="grid grid-cols-2 md:grid-cols-4 gap-4">
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
                            <div x-if="error" class="mt-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm" x-text="error"></div>
                        </div>
                    </div>
                </div>

                <!-- Users -->
                <div x-show="currentRoute === 'users'">
                    <div class="bg-white rounded-xl shadow-sm p-6">
                        <h2 class="text-xl font-semibold text-gray-900 mb-6">用户管理</h2>
                        <div x-data="adminUsers()" x-init="init()">
                            <div x-if="error" class="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm" x-text="error"></div>
                            <div x-if="loading" class="flex justify-center py-8"><div class="spinner"></div></div>
                            <div x-show="!loading">
                                <table class="w-full">
                                    <thead>
                                        <tr class="border-b">
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">ID</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">用户名</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">邮箱</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">角色</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">状态</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">操作</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <template x-for="user in users" :key="user.id">
                                            <tr class="border-b hover:bg-gray-50">
                                                <td class="py-3 px-4" x-text="user.id"></td>
                                                <td class="py-3 px-4" x-text="user.username"></td>
                                                <td class="py-3 px-4" x-text="user.email"></td>
                                                <td class="py-3 px-4">
                                                    <span class="px-2 py-1 rounded text-xs" :class="user.role === 'admin' ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-600'" x-text="user.role === 'admin' ? '管理员' : '用户'"></span>
                                                </td>
                                                <td class="py-3 px-4">
                                                    <button @click="toggle(user)" class="px-2 py-1 rounded text-xs" :class="user.status === 1 ? 'bg-green-100 text-green-600 hover:bg-green-200' : 'bg-red-100 text-red-600 hover:bg-red-200'" x-text="user.status === 1 ? '正常' : '封禁'"></button>
                                                </td>
                                                <td class="py-3 px-4">
                                                    <button @click="openEdit(user)" class="text-blue-600 hover:text-blue-700 mr-2">编辑</button>
                                                    <button @click="del(user.id)" class="text-red-600 hover:text-red-700">删除</button>
                                                </td>
                                            </tr>
                                        </template>
                                        <tr x-if="users.length === 0">
                                            <td colspan="6" class="py-8 text-center text-gray-500">暂无数据</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>

                            <!-- Edit Modal -->
                            <div x-if="showModal" class="modal-backdrop" @click.self="closeModal()">
                                <div class="modal-content">
                                    <h3 class="text-lg font-semibold mb-4">编辑用户</h3>
                                    <div class="space-y-4">
                                        <div>
                                            <label class="block text-sm font-medium mb-1">用户名</label>
                                            <input type="text" x-model="editing.username" class="w-full px-3 py-2 border border-gray-300 rounded-lg">
                                        </div>
                                        <div>
                                            <label class="block text-sm font-medium mb-1">邮箱</label>
                                            <input type="email" x-model="editing.email" class="w-full px-3 py-2 border border-gray-300 rounded-lg">
                                        </div>
                                        <div>
                                            <label class="block text-sm font-medium mb-1">角色</label>
                                            <select x-model="editing.role" class="w-full px-3 py-2 border border-gray-300 rounded-lg">
                                                <option value="user">用户</option>
                                                <option value="admin">管理员</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label class="block text-sm font-medium mb-1">状态</label>
                                            <select x-model="editing.status" class="w-full px-3 py-2 border border-gray-300 rounded-lg">
                                                <option :value="1">正常</option>
                                                <option :value="0">封禁</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label class="block text-sm font-medium mb-1">余额</label>
                                            <input type="number" x-model.number="editing.balance" class="w-full px-3 py-2 border border-gray-300 rounded-lg">
                                        </div>
                                        <div>
                                            <label class="block text-sm font-medium mb-1">最大域名数</label>
                                            <input type="number" x-model.number="editing.max_domains" class="w-full px-3 py-2 border border-gray-300 rounded-lg">
                                        </div>
                                        <div>
                                            <label class="block text-sm font-medium mb-1">积分</label>
                                            <input type="number" x-model.number="editing.points" class="w-full px-3 py-2 border border-gray-300 rounded-lg">
                                        </div>
                                    </div>
                                    <div class="flex justify-end space-x-4 mt-6">
                                        <button @click="closeModal()" class="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg">取消</button>
                                        <button @click="save()" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">保存</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Domains -->
                <div x-show="currentRoute === 'domains'">
                    <div class="bg-white rounded-xl shadow-sm p-6">
                        <h2 class="text-xl font-semibold text-gray-900 mb-6">域名管理</h2>
                        <div x-data="adminDomains()" x-init="init()">
                            <div x-if="error" class="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm" x-text="error"></div>
                            <div x-if="loading" class="flex justify-center py-8"><div class="spinner"></div></div>
                            <div x-show="!loading">
                                <table class="w-full">
                                    <thead>
                                        <tr class="border-b">
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">ID</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">域名</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">渠道</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">状态</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">创建时间</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <template x-for="domain in domains" :key="domain.id">
                                            <tr class="border-b hover:bg-gray-50">
                                                <td class="py-3 px-4" x-text="domain.id"></td>
                                                <td class="py-3 px-4 font-medium" x-text="domain.name"></td>
                                                <td class="py-3 px-4" x-text="domain.dns_channel?.name || '-'"></td>
                                                <td class="py-3 px-4">
                                                    <button @click="toggle(domain)" class="px-2 py-1 rounded text-xs" :class="domain.status === 1 ? 'bg-green-100 text-green-600 hover:bg-green-200' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'" x-text="domain.status === 1 ? '启用' : '禁用'"></button>
                                                </td>
                                                <td class="py-3 px-4 text-sm text-gray-500" x-text="domain.created_at"></td>
                                            </tr>
                                        </template>
                                        <tr x-if="domains.length === 0">
                                            <td colspan="5" class="py-8 text-center text-gray-500">暂无数据</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Channels -->
                <div x-show="currentRoute === 'channels'">
                    <div class="bg-white rounded-xl shadow-sm p-6">
                        <div x-data="adminChannels()" x-init="init()">
                        <div class="flex justify-between items-center mb-6">
                            <h2 class="text-xl font-semibold text-gray-900">DNS渠道管理</h2>
                            <button @click="openAdd()" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">添加渠道</button>
                        </div>
                            <div x-if="error" class="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm" x-text="error"></div>
                            <div x-if="loading" class="flex justify-center py-8"><div class="spinner"></div></div>
                            <div x-show="!loading">
                                <table class="w-full">
                                    <thead>
                                        <tr class="border-b">
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">ID</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">名称</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">类型</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">状态</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">操作</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <template x-for="channel in channels" :key="channel.id">
                                            <tr class="border-b hover:bg-gray-50">
                                                <td class="py-3 px-4" x-text="channel.id"></td>
                                                <td class="py-3 px-4 font-medium" x-text="channel.name"></td>
                                                <td class="py-3 px-4" x-text="channel.provider_type || channel.provider_name || '-'"></td>
                                                <td class="py-3 px-4">
                                                    <button @click="toggle(channel)" class="px-2 py-1 rounded text-xs" :class="channel.status === 1 ? 'bg-green-100 text-green-600 hover:bg-green-200' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'" x-text="channel.status === 1 ? '启用' : '禁用'"></button>
                                                </td>
                                                <td class="py-3 px-4">
                                                    <button @click="openEdit(channel)" class="text-blue-600 hover:text-blue-700">编辑</button>
                                                </td>
                                            </tr>
                                        </template>
                                        <tr x-if="channels.length === 0">
                                            <td colspan="5" class="py-8 text-center text-gray-500">暂无数据</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>

                            <!-- Add Modal -->
                            <div x-if="showAddModal" class="modal-backdrop" @click.self="closeAdd()">
                                <div class="modal-content">
                                    <h3 class="text-lg font-semibold mb-4">添加DNS渠道</h3>
                                    <div class="space-y-4">
                                        <div>
                                            <label class="block text-sm font-medium mb-1">渠道名称</label>
                                            <input type="text" x-model="adding.name" class="w-full px-3 py-2 border border-gray-300 rounded-lg" placeholder="输入渠道名称">
                                        </div>
                                        <div>
                                            <label class="block text-sm font-medium mb-1">服务商类型</label>
                                            <select x-model="adding.provider_type" class="w-full px-3 py-2 border border-gray-300 rounded-lg">
                                                <option value="cloudflare">Cloudflare</option>
                                                <option value="aliyun">阿里云</option>
                                                <option value="dnspod">DNSPod</option>
                                                <option value="godaddy">GoDaddy</option>
                                                <option value="namecom">Name.com</option>
                                                <option value="namesilo">NameSilo</option>
                                                <option value="namecheap">NameCheap</option>
                                                <option value="huawei">华为云</option>
                                                <option value="baiducloud">百度云</option>
                                                <option value="powerdns">PowerDNS</option>
                                                <option value="route53">Route53</option>
                                                <option value="westcn">西部数码</option>
                                            </select>
                                        </div>
                                        <div>
                                            <label class="block text-sm font-medium mb-1">凭据配置 (JSON)</label>
                                            <textarea x-model="adding.credentials" class="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm" rows="4" placeholder='{"email":"your@email.com","token":"your-api-token"}'></textarea>
                                            <p class="text-xs text-gray-500 mt-1">不同服务商需要不同参数，如 Cloudflare 需要 email 和 token</p>
                                        </div>
                                    </div>
                                    <div class="flex justify-end space-x-4 mt-6">
                                        <button @click="closeAdd()" class="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg">取消</button>
                                        <button @click="addChannel()" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">添加</button>
                                    </div>
                                </div>
                            </div>

                            <!-- Edit Modal -->
                            <div x-if="showEditModal" class="modal-backdrop" @click.self="closeEdit()">
                                <div class="modal-content">
                                    <h3 class="text-lg font-semibold mb-4">编辑渠道</h3>
                                    <div class="space-y-4">
                                        <div>
                                            <label class="block text-sm font-medium mb-1">渠道名称</label>
                                            <input type="text" x-model="editing.name" class="w-full px-3 py-2 border border-gray-300 rounded-lg">
                                        </div>
                                        <div>
                                            <label class="block text-sm font-medium mb-1">备注</label>
                                            <input type="text" x-model="editing.remark" class="w-full px-3 py-2 border border-gray-300 rounded-lg">
                                        </div>
                                        <div>
                                            <label class="block text-sm font-medium mb-1">状态</label>
                                            <select x-model="editing.status" class="w-full px-3 py-2 border border-gray-300 rounded-lg">
                                                <option :value="1">启用</option>
                                                <option :value="0">禁用</option>
                                            </select>
                                        </div>
                                    </div>
                                    <div class="flex justify-end space-x-4 mt-6">
                                        <button @click="closeEdit()" class="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg">取消</button>
                                        <button @click="saveChannel()" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">保存</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Plans -->
                <div x-show="currentRoute === 'plans'">
                    <div class="bg-white rounded-xl shadow-sm p-6">
                        <h2 class="text-xl font-semibold text-gray-900 mb-6">套餐管理</h2>
                        <div x-data="adminPlans()" x-init="init()">
                            <div x-if="error" class="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm" x-text="error"></div>
                            <div x-if="loading" class="flex justify-center py-8"><div class="spinner"></div></div>
                            <div x-show="!loading" class="grid md:grid-cols-3 gap-4">
                                <template x-for="plan in plans" :key="plan.id">
                                    <div class="border rounded-lg p-4">
                                        <h3 class="font-semibold text-gray-900" x-text="plan.name"></h3>
                                        <div class="mt-2">
                                            <span class="text-2xl font-bold" x-text="plan.is_free ? '免费' : ('¥' + plan.price)"></span>
                                            <span class="text-gray-500 text-sm" x-text="plan.is_free ? '' : ('/' + plan.duration_days + '天')"></span>
                                        </div>
                                        <div class="mt-2 text-sm text-gray-600">最大记录数: <span x-text="plan.max_records"></span></div>
                                        <div class="mt-1 text-sm text-gray-600">长度限制: <span x-text="plan.min_length + '-' + plan.max_length"></span></div>
                                    </div>
                                </template>
                                <div x-if="plans.length === 0" class="col-span-3 text-center py-8 text-gray-500">暂无数据</div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Orders -->
                <div x-show="currentRoute === 'orders'">
                    <div class="bg-white rounded-xl shadow-sm p-6">
                        <h2 class="text-xl font-semibold text-gray-900 mb-6">订单管理</h2>
                        <div x-data="adminOrders()" x-init="init()">
                            <div x-if="error" class="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm" x-text="error"></div>
                            <div x-if="loading" class="flex justify-center py-8"><div class="spinner"></div></div>
                            <div x-show="!loading">
                                <table class="w-full">
                                    <thead>
                                        <tr class="border-b">
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">ID</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">用户ID</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">域名</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">金额</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">状态</th>
                                            <th class="text-left py-3 px-4 font-medium text-gray-600">创建时间</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <template x-for="order in orders" :key="order.id">
                                            <tr class="border-b hover:bg-gray-50">
                                                <td class="py-3 px-4" x-text="order.id"></td>
                                                <td class="py-3 px-4" x-text="order.user_id || '-'"></td>
                                                <td class="py-3 px-4" x-text="order.subdomain_name || '-'"></td>
                                                <td class="py-3 px-4 font-medium" x-text="'¥' + order.amount"></td>
                                                <td class="py-3 px-4">
                                                    <span class="px-2 py-1 rounded text-xs" :class="order.status === 1 ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-600'" x-text="order.status === 1 ? '已支付' : '未支付'"></span>
                                                </td>
                                                <td class="py-3 px-4 text-sm text-gray-500" x-text="order.created_at"></td>
                                            </tr>
                                        </template>
                                        <tr x-if="orders.length === 0">
                                            <td colspan="6" class="py-8 text-center text-gray-500">暂无数据</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Settings -->
                <div x-show="currentRoute === 'settings'">
                    <div class="bg-white rounded-xl shadow-sm p-6">
                        <h2 class="text-xl font-semibold text-gray-900 mb-6">系统设置</h2>
                        <div x-data="adminSettings()" x-init="init()">
                            <div x-if="error" class="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm" x-text="error"></div>
                            <div x-if="loading" class="flex justify-center py-8"><div class="spinner"></div></div>
                            <div x-show="!loading" class="space-y-4">
                                <div class="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                                    <div>
                                        <div class="text-gray-700 font-medium">站点名称</div>
                                        <div class="text-sm text-gray-500" x-text="settings.site_name || '-'"></div>
                                    </div>
                                    <button @click="openEdit('site_name', settings.site_name)" class="text-blue-600 hover:text-blue-700 text-sm">编辑</button>
                                </div>
                                <div class="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                                    <div>
                                        <div class="text-gray-700 font-medium">站点描述</div>
                                        <div class="text-sm text-gray-500" x-text="settings.site_description || '-'"></div>
                                    </div>
                                    <button @click="openEdit('site_description', settings.site_description)" class="text-blue-600 hover:text-blue-700 text-sm">编辑</button>
                                </div>
                                <div class="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                                    <div>
                                        <div class="text-gray-700 font-medium">注册开关</div>
                                        <div class="text-sm" :class="settings.register_enabled === '1' ? 'text-green-600' : 'text-red-600'" x-text="settings.register_enabled === '1' ? '开启' : '关闭'"></div>
                                    </div>
                                    <button @click="openEdit('register_enabled', settings.register_enabled)" class="text-blue-600 hover:text-blue-700 text-sm">编辑</button>
                                </div>
                                <div class="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                                    <div>
                                        <div class="text-gray-700 font-medium">默认最大域名数</div>
                                        <div class="text-sm text-gray-500" x-text="settings.default_max_domains || '5'"></div>
                                    </div>
                                    <button @click="openEdit('default_max_domains', settings.default_max_domains)" class="text-blue-600 hover:text-blue-700 text-sm">编辑</button>
                                </div>
                                <div class="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                                    <div>
                                        <div class="text-gray-700 font-medium">版本号</div>
                                        <div class="text-sm text-gray-500" x-text="settings.version || '-'"></div>
                                    </div>
                                </div>
                            </div>

                            <!-- Edit Modal -->
                            <div x-if="showModal" class="modal-backdrop" @click.self="closeModal()">
                                <div class="modal-content">
                                    <h3 class="text-lg font-semibold mb-4">编辑设置</h3>
                                    <div>
                                        <label class="block text-sm font-medium mb-1" x-text="editingKey"></label>
                                        <input type="text" x-model="editingValue" class="w-full px-3 py-2 border border-gray-300 rounded-lg">
                                    </div>
                                    <div class="flex justify-end space-x-4 mt-6">
                                        <button @click="closeModal()" class="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg">取消</button>
                                        <button @click="save()" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">保存</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

            </div>
        </div>
    </div>
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