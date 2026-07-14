/**
 * D1 数据库类型定义
 */
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  APP_NAME?: string;
  APP_VERSION?: string;
  DEFAULT_MAX_DOMAINS?: string;
  JWT_ACCESS_TOKEN_EXPIRES?: string;
  JWT_SECRET?: string;
  CF_API_TOKEN?: string;
  CF_API_KEY?: string;
  CF_EMAIL?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM_NAME?: string;
  ALIYUN_SMS_ACCESS_KEY_ID?: string;
  ALIYUN_SMS_ACCESS_KEY_SECRET?: string;
  ALIYUN_SMS_SIGN_NAME?: string;
  TELEGRAM_BOT_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SITE_URL?: string;
}

// 数据库行类型
export interface UserRow {
  id: number;
  username: string;
  email: string;
  phone: string | null;
  password_hash: string | null;
  github_id: string | null;
  google_id: string | null;
  nodeloc_id: string | null;
  role: 'user' | 'admin' | 'demo';
  status: number;
  balance: number;
  max_domains: number;
  totp_secret: string | null;
  totp_enabled: number;
  backup_codes: string | null;
  allowed_ips: string | null;
  last_login_at: string | null;
  last_login_ip: string | null;
  api_key: string | null;
  api_secret: string | null;
  api_enabled: number;
  api_ip_whitelist: string | null;
  real_name: string | null;
  id_card: string | null;
  verified: number;
  verified_at: string | null;
  host_status: string;
  host_balance: number;
  host_commission_rate: number | null;
  host_approved_at: string | null;
  host_suspended_at: string | null;
  host_suspended_reason: string | null;
  points: number;
  total_points: number;
  invite_code: string | null;
  login_count: number;
  last_activity_at: string | null;
  activity_score: number;
  created_at: string;
  updated_at: string;
}

export interface DomainRow {
  id: number;
  owner_id: number | null;
  cf_account_id: number | null;
  dns_channel_id: number | null;
  name: string;
  cf_zone_id: string | null;
  zone_id: string | null;
  upstream_domain_id: number | null;
  status: number;
  allow_register: number;
  allow_ns_transfer: number;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubdomainRow {
  id: number;
  user_id: number;
  domain_id: number;
  plan_id: number | null;
  name: string;
  full_name: string;
  status: number;
  ns_mode: number;
  ns_servers: string | null;
  ns_changed_at: string | null;
  auto_renew: number;
  expires_at: string | null;
  last_renewed_at: string | null;
  upstream_subdomain_id: number | null;
  first_record_at: string | null;
  last_record_activity_at: string | null;
  idle_reminder_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DnsRecordRow {
  id: number;
  subdomain_id: number;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: number;
  priority: number | null;
  cf_record_id: string;
  created_at: string;
  updated_at: string;
}

export interface PlanRow {
  id: number;
  owner_id: number | null;
  name: string;
  price: number;
  duration_days: number;
  min_length: number;
  max_length: number;
  max_records: number;
  description: string | null;
  status: number;
  sort_order: number;
  is_free: number;
  max_purchase_count: number;
  renew_before_days: number;
  points_per_day: number;
  dns_channel_id: number | null;
  upstream_plan_id: number | null;
  upstream_price: number | null;
  created_at: string;
  updated_at: string;
}

export interface DnsChannelRow {
  id: number;
  owner_id: number | null;
  name: string;
  provider_type: string;
  credentials: string;
  status: number;
  config: string | null;
  remark: string | null;
  created_at: string;
  updated_at: string;
}

export interface SettingRow {
  key: string;
  value: string;
}

export interface CouponRow {
  id: number;
  code: string;
  name: string;
  type: string;
  value: number;
  min_amount: number;
  max_discount: number | null;
  total_count: number;
  used_count: number;
  per_user_limit: number;
  applicable_plans: string | null;
  applicable_type: string;
  excluded_domains: string | null;
  status: number;
  starts_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface PurchaseRecordRow {
  id: number;
  user_id: number;
  subdomain_id: number | null;
  plan_id: number | null;
  domain_id: number | null;
  amount: number;
  subdomain_name: string | null;
  coupon_id: number | null;
  discount_amount: number;
  final_amount: number;
  created_at: string;
}

export interface TicketRow {
  id: number;
  ticket_no: string;
  type: number;
  from_user_id: number;
  to_user_id: number | null;
  subject: string;
  content: string;
  status: number;
  created_at: string;
  updated_at: string;
}