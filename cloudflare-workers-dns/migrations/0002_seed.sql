-- ============================================================
-- 种子数据: 默认管理员、系统设置、侧边栏菜单
-- ============================================================

-- 默认管理员 (admin@qq.com / admin123)
-- bcrypt hash for 'admin123' with 10 rounds
INSERT OR IGNORE INTO users (username, email, role, status, balance, max_domains, password_hash, created_at, updated_at)
VALUES ('admin', 'admin@qq.com', 'admin', 1, 0, 999, '$2a$10$K3y/u3IYucIufmM.7olrdO8XDOi63qaTnwvLHszAn2hD2f1e8gjpm', datetime('now'), datetime('now'));

-- 默认系统设置
INSERT OR IGNORE INTO settings (key, value) VALUES ('site_name', '六趣DNS');
INSERT OR IGNORE INTO settings (key, value) VALUES ('site_description', '基于Cloudflare的二级域名分发系统');
INSERT OR IGNORE INTO settings (key, value) VALUES ('register_enabled', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('require_email_verification', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('require_phone_binding', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('default_max_domains', '5');
INSERT OR IGNORE INTO settings (key, value) VALUES ('signin_points', '10');
INSERT OR IGNORE INTO settings (key, value) VALUES ('signin_continuous_bonus', '5');
INSERT OR IGNORE INTO settings (key, value) VALUES ('invite_reward_points', '100');
INSERT OR IGNORE INTO settings (key, value) VALUES ('invitee_reward_points', '50');
INSERT OR IGNORE INTO settings (key, value) VALUES ('invite_recharge_reward', '200');
INSERT OR IGNORE INTO settings (key, value) VALUES ('points_to_balance_ratio', '100');
INSERT OR IGNORE INTO settings (key, value) VALUES ('transfer_fee_points', '10');
INSERT OR IGNORE INTO settings (key, value) VALUES ('host_commission_rate', '10');
INSERT OR IGNORE INTO settings (key, value) VALUES ('idle_domain_days', '30');
INSERT OR IGNORE INTO settings (key, value) VALUES ('domain_expiry_remind_days', '7');
INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_renew_enabled', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('smtp_host', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('smtp_port', '465');
INSERT OR IGNORE INTO settings (key, value) VALUES ('smtp_user', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('smtp_password', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('smtp_ssl', '1');
INSERT OR IGNORE INTO settings (key, value) VALUES ('smtp_from_name', '六趣DNS');
INSERT OR IGNORE INTO settings (key, value) VALUES ('email_provider', 'smtp');
INSERT OR IGNORE INTO settings (key, value) VALUES ('privacy_policy', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('abuse_contact', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('version', '3.0.0');

-- 默认邮件模板
INSERT OR IGNORE INTO email_templates (name, subject, content, type) VALUES (
    'verification',
    '邮箱验证 - {site_name}',
    '<h2>欢迎注册 {site_name}！</h2><p>您的验证码是：<strong>{code}</strong></p><p>验证码 {expire} 分钟内有效，请勿泄露给他人。</p>',
    'system'
);
INSERT OR IGNORE INTO email_templates (name, subject, content, type) VALUES (
    'reset_password',
    '密码重置 - {site_name}',
    '<h2>密码重置</h2><p>您的验证码是：<strong>{code}</strong></p><p>验证码 {expire} 分钟内有效，如非本人操作请忽略。</p>',
    'system'
);
INSERT OR IGNORE INTO email_templates (name, subject, content, type) VALUES (
    'domain_expiry',
    '域名到期提醒 - {site_name}',
    '<h2>域名到期提醒</h2><p>您的域名 <strong>{domain}</strong> 将于 {expire_date} 到期。</p><p>请及时续费以避免服务中断。</p>',
    'system'
);
INSERT OR IGNORE INTO email_templates (name, subject, content, type) VALUES (
    'dns_cleanup',
    '域名闲置提醒 - {site_name}',
    '<h2>域名闲置提醒</h2><p>您的域名 <strong>{domain}</strong> 已超过 {days} 天未添加DNS记录。</p><p>如继续闲置，该域名可能被回收。</p>',
    'system'
);

-- 侧边栏菜单 - 管理后台
INSERT OR IGNORE INTO sidebar_menus (menu_type, menu_key, parent_key, name_zh, name_en, url, sort_order, visible) VALUES
('admin', 'home', NULL, '首页', 'Home', '/admin', 1, 1),
('admin', 'domain_manage', NULL, '域名管理', 'Domain', NULL, 10, 1),
('admin', 'user_manage', NULL, '用户管理', 'Users', NULL, 20, 1),
('admin', 'finance', NULL, '财务管理', 'Finance', NULL, 30, 1),
('admin', 'host', NULL, '托管管理', 'Hosting', NULL, 40, 1),
('admin', 'content', NULL, '内容管理', 'Content', NULL, 50, 1),
('admin', 'system', NULL, '系统设置', 'System', NULL, 60, 1),
-- 域名管理子菜单
('admin', 'channels', 'domain_manage', '渠道管理', 'Channels', '/admin/channels', 1, 1),
('admin', 'domains', 'domain_manage', '域名列表', 'Domains', '/admin/domains', 2, 1),
('admin', 'plans', 'domain_manage', '套餐管理', 'Plans', '/admin/plans', 3, 1),
('admin', 'free_plan_applications', 'domain_manage', '申请管理', 'Applications', '/admin/free-plan-applications', 4, 1),
('admin', 'subdomains', 'domain_manage', '用户域名', 'User Domains', '/admin/subdomains', 5, 1),
('admin', 'dns_records', 'domain_manage', 'DNS查询', 'DNS Query', '/admin/dns-records', 6, 1),
('admin', 'idle_domains', 'domain_manage', '闲置域名', 'Idle Domains', '/admin/idle-domains', 7, 1),
('admin', 'transfers', 'domain_manage', '转移管理', 'Transfers', '/admin/transfers', 8, 1),
-- 用户管理子菜单
('admin', 'users', 'user_manage', '用户列表', 'User List', '/admin/users', 1, 1),
('admin', 'user_activity', 'user_manage', '用户活跃', 'Activity', '/admin/user-activity', 2, 1),
('admin', 'invites', 'user_manage', '邀请记录', 'Invites', '/admin/invites', 3, 1),
('admin', 'points', 'user_manage', '积分记录', 'Points', '/admin/points', 4, 1),
('admin', 'ip_blacklist', 'user_manage', 'IP黑名单', 'IP Blacklist', '/admin/ip-blacklist', 5, 1),
-- 财务管理子菜单
('admin', 'orders', 'finance', '订单记录', 'Orders', '/admin/orders', 1, 1),
('admin', 'redeem_codes', 'finance', '兑换码', 'Redeem Codes', '/admin/redeem-codes', 2, 1),
('admin', 'coupons', 'finance', '优惠券', 'Coupons', '/admin/coupons', 3, 1),
-- 托管管理子菜单
('admin', 'host_applications', 'host', '托管申请', 'Applications', '/admin/host/applications', 1, 1),
('admin', 'host_hosts', 'host', '托管商列表', 'Hosts', '/admin/host/hosts', 2, 1),
('admin', 'host_withdrawals', 'host', '提现管理', 'Withdrawals', '/admin/host/withdrawals', 3, 1),
('admin', 'host_settings', 'host', '托管设置', 'Settings', '/admin/host/settings', 4, 1),
-- 内容管理子菜单
('admin', 'announcements', 'content', '公告管理', 'Announcements', '/admin/announcements', 1, 1),
('admin', 'tickets', 'content', '工单管理', 'Tickets', '/admin/tickets', 2, 1),
('admin', 'email_campaigns', 'content', '群发邮件', 'Email Campaigns', '/admin/email-campaigns', 3, 1),
('admin', 'app_versions', 'content', 'APP版本', 'App Versions', '/admin/app-versions', 4, 1),
('admin', 'email_templates', 'content', '邮件模板', 'Templates', '/admin/email-templates', 5, 1),
-- 系统设置子菜单
('admin', 'settings', 'system', '站点设置', 'Settings', '/admin/settings', 1, 1),
('admin', 'security_settings', 'system', '安全设置', 'Security', '/admin/security-settings', 2, 1),
('admin', 'oauth_settings', 'system', 'OAuth登录', 'OAuth', '/admin/oauth-settings', 3, 1),
('admin', 'telegram', 'system', 'Telegram', 'Telegram', '/admin/telegram', 4, 1),
('admin', 'cron', 'system', '定时任务', 'Cron', '/admin/cron', 5, 1),
('admin', 'backup', 'system', '数据备份', 'Backup', '/admin/backup', 6, 1),
('admin', 'logs', 'system', '操作日志', 'Logs', '/admin/logs', 7, 1),
('admin', 'sidebar_menus', 'system', '菜单管理', 'Menus', '/admin/sidebar', 8, 1);

-- 侧边栏菜单 - 用户前台
INSERT OR IGNORE INTO sidebar_menus (menu_type, menu_key, parent_key, name_zh, name_en, url, sort_order, visible) VALUES
('user', 'dashboard', NULL, '控制台', 'Dashboard', '/user', 1, 1),
('user', 'domain_manage', NULL, '域名管理', 'Domain', NULL, 10, 1),
('user', 'order_center', NULL, '订单中心', 'Orders', NULL, 20, 1),
('user', 'account_settings', NULL, '账户设置', 'Account', NULL, 30, 1),
('user', 'whois', NULL, 'WHOIS查询', 'WHOIS', '/whois', 40, 1),
('user', 'tickets', NULL, '工单中心', 'Tickets', '/tickets', 50, 1),
('user', 'host', NULL, '托管商入口', 'Hosting', '/host', 60, 1),
-- 域名管理子菜单
('user', 'my_domains', 'domain_manage', '我的域名', 'My Domains', '/user/domains', 1, 1),
('user', 'buy_domain', 'domain_manage', '购买域名', 'Buy', '/user/domains/new', 2, 1),
('user', 'my_applications', 'domain_manage', '我的申请', 'Applications', '/my-applications', 3, 1),
('user', 'transfers', 'domain_manage', '转移记录', 'Transfers', '/user/transfers', 4, 1),
-- 订单中心子菜单
('user', 'order_history', 'order_center', '订单记录', 'Orders', '/user/orders', 1, 1),
('user', 'redeem_code', 'order_center', '兑换码', 'Redeem', '/user/redeem', 2, 1),
('user', 'points_center', 'order_center', '积分中心', 'Points', '/points', 3, 1),
-- 账户设置子菜单
('user', 'profile', 'account_settings', '个人资料', 'Profile', '/user/profile', 1, 1),
('user', 'security', 'account_settings', '安全设置', 'Security', '/user/security', 2, 1),
('user', 'api_manage', 'account_settings', 'API管理', 'API', '/user/api', 3, 1),
('user', 'announcements', 'account_settings', '系统公告', 'Announcements', '/user/announcements', 4, 1),
('user', 'invite', 'account_settings', '邀请好友', 'Invite', '/invite', 5, 1);