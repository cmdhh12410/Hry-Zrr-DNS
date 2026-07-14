-- ============================================================
-- DNS 分发系统 - Cloudflare D1 数据库 Schema
-- 从 MySQL 迁移到 SQLite (D1 兼容)
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- 用户表
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    phone TEXT UNIQUE,
    password_hash TEXT,
    github_id TEXT UNIQUE,
    google_id TEXT UNIQUE,
    nodeloc_id TEXT UNIQUE,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin', 'demo')),
    status INTEGER NOT NULL DEFAULT 1 CHECK(status IN (0, 1, 2)),
    balance REAL NOT NULL DEFAULT 0,
    max_domains INTEGER NOT NULL DEFAULT 5,
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    backup_codes TEXT,
    allowed_ips TEXT,
    last_login_at TEXT,
    last_login_ip TEXT,
    -- API
    api_key TEXT UNIQUE,
    api_secret TEXT,
    api_enabled INTEGER NOT NULL DEFAULT 0,
    api_ip_whitelist TEXT,
    -- 实名认证
    real_name TEXT,
    id_card TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    verified_at TEXT,
    -- 托管商
    host_status TEXT NOT NULL DEFAULT 'none' CHECK(host_status IN ('none','pending','approved','rejected','suspended','revoked')),
    host_balance REAL NOT NULL DEFAULT 0,
    host_commission_rate REAL,
    host_approved_at TEXT,
    host_suspended_at TEXT,
    host_suspended_reason TEXT,
    -- TG通知
    tg_notify_domain_expire INTEGER NOT NULL DEFAULT 1,
    tg_notify_purchase INTEGER NOT NULL DEFAULT 1,
    tg_notify_balance INTEGER NOT NULL DEFAULT 1,
    tg_notify_announcement INTEGER NOT NULL DEFAULT 1,
    tg_notify_order INTEGER NOT NULL DEFAULT 1,
    tg_notify_daily INTEGER NOT NULL DEFAULT 1,
    tg_language TEXT DEFAULT 'zh',
    -- 活跃度
    login_count INTEGER NOT NULL DEFAULT 0,
    last_activity_at TEXT,
    activity_score INTEGER NOT NULL DEFAULT 0,
    -- 积分
    points INTEGER NOT NULL DEFAULT 0,
    total_points INTEGER NOT NULL DEFAULT 0,
    invite_code TEXT UNIQUE,
    -- 时间戳
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_host_status ON users(host_status);
CREATE INDEX idx_users_invite_code ON users(invite_code);

-- ============================================================
-- DNS 渠道表
-- ============================================================
CREATE TABLE IF NOT EXISTS dns_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    provider_type TEXT NOT NULL CHECK(provider_type IN ('cloudflare','aliyun','dnspod','baiducloud','huawei','godaddy','namecom','namesilo','namecheap','powerdns','route53','westcn','liuqu')),
    credentials TEXT NOT NULL,
    status INTEGER NOT NULL DEFAULT 1,
    config TEXT,
    remark TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_dns_channels_owner ON dns_channels(owner_id);
CREATE INDEX idx_dns_channels_status ON dns_channels(status);

-- ============================================================
-- 域名表
-- ============================================================
CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    cf_account_id INTEGER,
    dns_channel_id INTEGER REFERENCES dns_channels(id) ON DELETE SET NULL,
    name TEXT NOT NULL UNIQUE,
    cf_zone_id TEXT,
    zone_id TEXT,
    upstream_domain_id INTEGER,
    status INTEGER NOT NULL DEFAULT 1,
    allow_register INTEGER NOT NULL DEFAULT 1,
    allow_ns_transfer INTEGER NOT NULL DEFAULT 1,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_domains_owner ON domains(owner_id);
CREATE INDEX idx_domains_channel ON domains(dns_channel_id);
CREATE INDEX idx_domains_status ON domains(status);

-- ============================================================
-- 套餐表
-- ============================================================
CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    duration_days INTEGER NOT NULL DEFAULT 30,
    min_length INTEGER NOT NULL DEFAULT 1,
    max_length INTEGER NOT NULL DEFAULT 63,
    max_records INTEGER NOT NULL DEFAULT 10,
    description TEXT,
    status INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    -- 免费套餐
    is_free INTEGER NOT NULL DEFAULT 0,
    max_purchase_count INTEGER NOT NULL DEFAULT 0,
    renew_before_days INTEGER NOT NULL DEFAULT 0,
    points_per_day INTEGER NOT NULL DEFAULT 0,
    -- 上游分销
    dns_channel_id INTEGER REFERENCES dns_channels(id) ON DELETE SET NULL,
    upstream_plan_id INTEGER,
    upstream_price REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_plans_owner ON plans(owner_id);
CREATE INDEX idx_plans_status ON plans(status);

-- ============================================================
-- 套餐-域名关联表
-- ============================================================
CREATE TABLE IF NOT EXISTS plan_domains (
    plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    PRIMARY KEY (plan_id, domain_id)
);

CREATE INDEX idx_plan_domains_domain ON plan_domains(domain_id);

-- ============================================================
-- 子域名（用户购买的域名）表
-- ============================================================
CREATE TABLE IF NOT EXISTS subdomains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    full_name TEXT NOT NULL UNIQUE,
    status INTEGER NOT NULL DEFAULT 1,
    ns_mode INTEGER NOT NULL DEFAULT 0,
    ns_servers TEXT,
    ns_changed_at TEXT,
    auto_renew INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    last_renewed_at TEXT,
    upstream_subdomain_id INTEGER,
    -- 空置检测
    first_record_at TEXT,
    last_record_activity_at TEXT,
    idle_reminder_sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_subdomains_user ON subdomains(user_id);
CREATE INDEX idx_subdomains_domain ON subdomains(domain_id);
CREATE INDEX idx_subdomains_status ON subdomains(status);
CREATE INDEX idx_subdomains_expires ON subdomains(expires_at);

-- ============================================================
-- DNS 记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS dns_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subdomain_id INTEGER NOT NULL REFERENCES subdomains(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('A','AAAA','CNAME','TXT','MX')),
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    ttl INTEGER NOT NULL DEFAULT 300,
    proxied INTEGER NOT NULL DEFAULT 0,
    priority INTEGER,
    cf_record_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_dns_records_subdomain ON dns_records(subdomain_id);

-- ============================================================
-- 购买记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS purchase_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subdomain_id INTEGER REFERENCES subdomains(id) ON DELETE SET NULL,
    plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
    domain_id INTEGER REFERENCES domains(id) ON DELETE SET NULL,
    amount REAL NOT NULL,
    subdomain_name TEXT,
    coupon_id INTEGER,
    discount_amount REAL NOT NULL DEFAULT 0,
    final_amount REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_purchase_records_user ON purchase_records(user_id);

-- ============================================================
-- 兑换码表
-- ============================================================
CREATE TABLE IF NOT EXISTS redeem_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    amount REAL NOT NULL,
    status INTEGER NOT NULL DEFAULT 1,
    used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    used_at TEXT,
    batch_id TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_redeem_codes_code ON redeem_codes(code);
CREATE INDEX idx_redeem_codes_status ON redeem_codes(status);

-- ============================================================
-- 优惠券表
-- ============================================================
CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'percent' CHECK(type IN ('percent','fixed')),
    value REAL NOT NULL,
    min_amount REAL NOT NULL DEFAULT 0,
    max_discount REAL,
    total_count INTEGER NOT NULL DEFAULT -1,
    used_count INTEGER NOT NULL DEFAULT 0,
    per_user_limit INTEGER NOT NULL DEFAULT 1,
    applicable_plans TEXT,
    applicable_type TEXT NOT NULL DEFAULT 'all' CHECK(applicable_type IN ('all','domain')),
    excluded_domains TEXT,
    status INTEGER NOT NULL DEFAULT 1,
    starts_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_coupons_code ON coupons(code);

-- ============================================================
-- 优惠券使用记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS coupon_usages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id INTEGER,
    original_price REAL NOT NULL,
    discount_amount REAL NOT NULL,
    final_price REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_coupon_usages_coupon ON coupon_usages(coupon_id);
CREATE INDEX idx_coupon_usages_user ON coupon_usages(user_id);

-- ============================================================
-- 系统设置表
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 公告表
-- ============================================================
CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    is_popup INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 公告已读记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS announcement_reads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(announcement_id, user_id)
);

-- ============================================================
-- 邮箱验证表
-- ============================================================
CREATE TABLE IF NOT EXISTS email_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'register' CHECK(type IN ('register','reset_password','change_email','bind_email','verify_email')),
    used INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    invite_code TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_email_verifications_email ON email_verifications(email);

-- ============================================================
-- 短信验证表
-- ============================================================
CREATE TABLE IF NOT EXISTS sms_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    code TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'login',
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    used INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sms_verifications_phone ON sms_verifications(phone);

-- ============================================================
-- 操作日志表
-- ============================================================
CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    details TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_operation_logs_user ON operation_logs(user_id);
CREATE INDEX idx_operation_logs_created ON operation_logs(created_at);

-- ============================================================
-- 工单表
-- ============================================================
CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_no TEXT NOT NULL UNIQUE,
    type INTEGER NOT NULL DEFAULT 2,
    from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    subject TEXT NOT NULL,
    content TEXT NOT NULL,
    status INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tickets_from_user ON tickets(from_user_id);
CREATE INDEX idx_tickets_status ON tickets(status);

-- ============================================================
-- 工单回复表
-- ============================================================
CREATE TABLE IF NOT EXISTS ticket_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ticket_replies_ticket ON ticket_replies(ticket_id);

-- ============================================================
-- 积分记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS point_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    points INTEGER NOT NULL,
    balance INTEGER NOT NULL,
    description TEXT,
    related_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_point_records_user ON point_records(user_id);
CREATE INDEX idx_point_records_type ON point_records(type);

-- ============================================================
-- 签到记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS user_signins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    signin_date TEXT NOT NULL,
    continuous_days INTEGER NOT NULL DEFAULT 1,
    points_earned INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, signin_date)
);

-- ============================================================
-- 邀请记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS user_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inviter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invite_code TEXT NOT NULL,
    register_reward INTEGER NOT NULL DEFAULT 0,
    recharge_reward INTEGER NOT NULL DEFAULT 0,
    invitee_reward INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(invitee_id)
);

-- ============================================================
-- 域名转移记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS domain_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subdomain_id INTEGER NOT NULL REFERENCES subdomains(id) ON DELETE CASCADE,
    subdomain_name TEXT NOT NULL,
    from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_username TEXT NOT NULL,
    to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    to_username TEXT NOT NULL,
    fee_points INTEGER NOT NULL DEFAULT 0,
    verify_code TEXT,
    verify_expires TEXT,
    code_sent_at TEXT,
    status INTEGER NOT NULL DEFAULT 0,
    remark TEXT,
    admin_remark TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
);

CREATE INDEX idx_domain_transfers_subdomain ON domain_transfers(subdomain_id);
CREATE INDEX idx_domain_transfers_from ON domain_transfers(from_user_id);
CREATE INDEX idx_domain_transfers_to ON domain_transfers(to_user_id);

-- ============================================================
-- IP 黑名单表
-- ============================================================
CREATE TABLE IF NOT EXISTS ip_blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_address TEXT NOT NULL UNIQUE,
    reason TEXT,
    blocked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 邮件模板表
-- ============================================================
CREATE TABLE IF NOT EXISTS email_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'system',
    status INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 邮箱账户表
-- ============================================================
CREATE TABLE IF NOT EXISTS email_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('smtp','aliyun')),
    config TEXT NOT NULL,
    daily_limit INTEGER NOT NULL DEFAULT 500,
    daily_sent INTEGER NOT NULL DEFAULT 0,
    last_reset_at TEXT,
    last_sent_at TEXT,
    priority INTEGER NOT NULL DEFAULT 10,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
);

CREATE INDEX idx_email_accounts_enabled ON email_accounts(enabled, priority);

-- ============================================================
-- 邮件群发任务表
-- ============================================================
CREATE TABLE IF NOT EXISTS email_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    content TEXT NOT NULL,
    recipient_filter TEXT,
    recipient_count INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft' CHECK(status IN ('draft','pending','sending','completed','stopped','failed')),
    scheduled_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    task_id TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 邮件发送日志表
-- ============================================================
CREATE TABLE IF NOT EXISTS email_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER REFERENCES email_campaigns(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    content TEXT,
    status TEXT DEFAULT 'pending',
    error_message TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 用户活动记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS user_activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity_type TEXT NOT NULL,
    activity_data TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_user_activities_user ON user_activities(user_id);
CREATE INDEX idx_user_activities_type ON user_activities(activity_type);

-- ============================================================
-- 免费套餐申请表
-- ============================================================
CREATE TABLE IF NOT EXISTS free_plan_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    domain_id INTEGER REFERENCES domains(id) ON DELETE SET NULL,
    subdomain_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled','used')),
    apply_reason TEXT NOT NULL,
    admin_note TEXT,
    rejection_reason TEXT,
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TEXT,
    ip_address TEXT,
    user_info_snapshot TEXT,
    -- 自动开通
    provision_attempted INTEGER NOT NULL DEFAULT 0,
    provision_error TEXT,
    subdomain_id INTEGER REFERENCES subdomains(id) ON DELETE SET NULL,
    -- 托管商审核
    host_review_status TEXT,
    host_reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    host_reviewed_at TEXT,
    host_rejection_reason TEXT,
    host_admin_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_free_plan_app_user ON free_plan_applications(user_id);
CREATE INDEX idx_free_plan_app_status ON free_plan_applications(status);

-- ============================================================
-- 托管商申请表
-- ============================================================
CREATE TABLE IF NOT EXISTS host_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    admin_remark TEXT,
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_host_applications_user ON host_applications(user_id);

-- ============================================================
-- 托管商交易表
-- ============================================================
CREATE TABLE IF NOT EXISTS host_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purchase_record_id INTEGER NOT NULL REFERENCES purchase_records(id) ON DELETE CASCADE,
    domain_id INTEGER REFERENCES domains(id) ON DELETE SET NULL,
    total_amount REAL NOT NULL,
    platform_fee REAL NOT NULL,
    host_earnings REAL NOT NULL,
    commission_rate REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_host_transactions_host ON host_transactions(host_id);

-- ============================================================
-- 托管商提现表
-- ============================================================
CREATE TABLE IF NOT EXISTS host_withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','completed')),
    payment_method TEXT,
    payment_account TEXT,
    payment_name TEXT,
    admin_remark TEXT,
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_host_withdrawals_host ON host_withdrawals(host_id);

-- ============================================================
-- 侧边栏菜单表
-- ============================================================
CREATE TABLE IF NOT EXISTS sidebar_menus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_type TEXT NOT NULL CHECK(menu_type IN ('admin','user')),
    menu_key TEXT NOT NULL,
    parent_key TEXT,
    name_zh TEXT NOT NULL,
    name_en TEXT NOT NULL,
    icon TEXT,
    url TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    visible INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,
    UNIQUE(menu_type, menu_key)
);

-- ============================================================
-- 邮箱链接登录令牌表
-- ============================================================
CREATE TABLE IF NOT EXISTS magic_link_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_ip TEXT,
    used_ip TEXT
);

CREATE INDEX idx_magic_link_token ON magic_link_tokens(token);
CREATE INDEX idx_magic_link_expires ON magic_link_tokens(expires_at);

-- ============================================================
-- APP 版本表
-- ============================================================
CREATE TABLE IF NOT EXISTS app_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL CHECK(platform IN ('android','ios')),
    version TEXT NOT NULL,
    build INTEGER NOT NULL,
    download_url TEXT NOT NULL,
    file_size TEXT,
    update_log TEXT,
    force_update INTEGER NOT NULL DEFAULT 0,
    min_version TEXT,
    status INTEGER NOT NULL DEFAULT 1,
    download_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(platform, version)
);

-- ============================================================
-- Telegram 绑定码表
-- ============================================================
CREATE TABLE IF NOT EXISTS telegram_bind_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- 定时任务执行日志表
-- ============================================================
CREATE TABLE IF NOT EXISTS cron_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    task_name TEXT NOT NULL,
    triggered_by TEXT NOT NULL DEFAULT 'scheduler',
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','success','failed')),
    result TEXT,
    error_message TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    duration INTEGER
);

CREATE INDEX idx_cron_logs_task ON cron_logs(task_id);
CREATE INDEX idx_cron_logs_status ON cron_logs(status);