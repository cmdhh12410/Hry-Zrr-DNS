# DNS 分发系统 - Cloudflare Workers 版本

基于 Cloudflare Workers + D1 + KV 的无需服务器 DNS 分发系统。

## 技术栈

| 类型 | 技术 |
|------|------|
| 运行时 | Cloudflare Workers (TypeScript) |
| 数据库 | Cloudflare D1 (SQLite) |
| 存储/缓存 | Cloudflare Workers KV |
| 定时任务 | Workers Cron Triggers |
| 前端 | TailwindCSS + Alpine.js (SPA) |
| 认证 | JWT (jose) |
| 密码加密 | bcryptjs |

## 快速开始

### 1. 安装依赖

```bash
cd cloudflare-workers-dns
npm install
```

### 2. 创建 Cloudflare 资源

```bash
# 创建 D1 数据库
npx wrangler d1 create dns-db

# 创建 KV 命名空间
npx wrangler kv:namespace create KV
```

### 3. 更新 wrangler.toml

将上面命令输出的 `database_id`、`kv_namespace id` 和 `preview_id` 填入 `wrangler.toml` 中替换 `PLACEHOLDER` 值。

### 4. 初始化数据库

```bash
# 创建表结构
npx wrangler d1 execute dns-db --file=./migrations/0001_initial.sql

# 导入种子数据（默认管理员等）
npx wrangler d1 execute dns-db --file=./migrations/0002_seed.sql
```

### 5. 本地开发

```bash
npx wrangler dev
```

访问 http://localhost:8787

### 6. 部署到生产环境

```bash
npx wrangler deploy
```

## 默认管理员

- 邮箱：`admin@qq.com`
- 密码：`admin123`

> ⚠️ 首次登录后请立即修改密码！

## 项目结构

```
cloudflare-workers-dns/
├── wrangler.toml              # Cloudflare Workers 配置
├── package.json               # 项目依赖
├── tsconfig.json              # TypeScript 配置
├── src/
│   ├── index.ts               # Worker 入口（含 Cron 触发器）
│   ├── router.ts              # 路由系统
│   ├── middleware/
│   │   ├── auth.ts            # JWT 认证中间件
│   │   └── rate-limiter.ts    # 限流中间件
│   ├── routes/
│   │   ├── auth.ts            # 认证 API（登录/注册/密码重置）
│   │   ├── domain.ts          # 域名 API
│   │   ├── record.ts          # DNS 记录 API
│   │   ├── plan.ts            # 套餐 API
│   │   ├── user.ts            # 用户 API
│   │   ├── coupon.ts          # 优惠券 API
│   │   ├── ticket.ts          # 工单 API
│   │   ├── points.ts          # 积分 API
│   │   ├── transfer.ts        # 域名转让 API
│   │   ├── whois.ts           # WHOIS 查询 API
│   │   ├── open_api.ts        # 开放 API（API Key 认证）
│   │   ├── cron.ts            # 定时任务 API
│   │   ├── health.ts          # 健康检查
│   │   └── admin/             # 管理后台 API
│   │       ├── index.ts       # 管理后台路由聚合 + 仪表盘统计
│   │       ├── users.ts       # 用户管理
│   │       ├── domains.ts     # 域名管理
│   │       ├── plans.ts       # 套餐管理
│   │       ├── channels.ts    # DNS 渠道管理
│   │       ├── coupons.ts     # 优惠券管理
│   │       ├── tickets.ts     # 工单管理
│   │       ├── settings.ts    # 系统设置
│   │       ├── orders.ts      # 订单管理
│   │       ├── redeem_codes.ts # 兑换码管理
│   │       ├── announcements.ts # 公告管理
│   │       └── host.ts        # 托管商管理
│   └── utils/
│       ├── response.ts        # 响应工具
│       ├── jwt.ts             # JWT 工具
│       ├── crypto.ts          # 密码/sign 工具
│       ├── types.ts           # 类型定义
│       └── kv.ts              # KV 存储工具
├── migrations/
│   ├── 0001_initial.sql       # 数据库初始化
│   └── 0002_seed.sql          # 种子数据
├── static/
│   ├── css/
│   │   ├── tailwind.min.css
│   │   └── style.css
│   ├── js/
│   │   ├── alpine.min.js
│   │   ├── app.js
│   │   ├── echarts.min.js
│   │   └── i18n.js
│   └── locales/
│       ├── zh.json
│       └── en.json
└── templates/
    └── index.html
```

## 功能特性

### 用户端
- 域名购买 — 选择套餐购买二级域名
- DNS 解析管理 — 支持 A、AAAA、CNAME、TXT、MX 记录
- 余额系统 — 兑换码充值 / 余额支付
- 积分系统 — 签到获取积分，积分兑换余额
- 个人中心 — 账户信息、修改密码、修改邮箱
- 工单系统 — 提交工单
- 域名转让 — 用户间域名转让
- WHOIS 查询
- API 管理 — 开放 API 接口

### 管理端
- 多 DNS 渠道 — 支持 Cloudflare、阿里云等 12+ 服务商
- 域名管理 — 添加/管理主域名
- 套餐管理 — 含免费套餐
- 用户管理 — 用户列表、余额调整
- 兑换码/优惠券 — 批量生成
- 公告系统 — 支持置顶和弹窗
- 工单管理 — 处理用户工单
- 托管商系统 — 支持分销
- IP 黑名单
- 系统设置
- 定时任务 — 域名到期检查、自动续费、闲置清理

## 环境变量配置

通过 `wrangler.toml` 的 `[vars]` 或 Cloudflare Dashboard 设置：

```bash
# 可选：使用 wrangler secret 设置敏感信息
npx wrangler secret put JWT_SECRET
npx wrangler secret put CF_API_TOKEN
```

## 与原始 Flask 版本的区别

1. **无需服务器** — 完全运行在 Cloudflare 边缘网络
2. **数据库** — MySQL → D1 (SQLite)
3. **后端语言** — Python/Flask → TypeScript/Workers
4. **模板引擎** — Jinja2 → 静态 HTML + Alpine.js SPA
5. **定时任务** — APScheduler → Workers Cron Triggers
6. **会话管理** — Flask Session → KV 存储
7. **邮件服务** — 需要配置 Mailchannels 或 Resend 等外部服务
8. **Telegram Bot** — 需要单独部署或使用其他方式

## 注意事项

1. **静态文件**：生产环境建议将前端页面部署到 Cloudflare Pages，Workers 只处理 API 请求
2. **邮件发送**：需要配置外部邮件服务（Mailchannels/Resend/SendGrid）
3. **短信发送**：需要配置阿里云短信服务
4. **DNS 操作**：需要通过 Cloudflare API 或其他 DNS 服务商 API 进行实际 DNS 记录操作
5. **D1 限制**：D1 是 SQLite 兼容的，不支持 MySQL 的某些特性（如 ENUM、JSON 类型等）