import { Router } from '../router';
import { successResponse, errorResponse } from '../utils/response';
import type { Env } from '../utils/types';

/**
 * 记录 cron 执行日志
 */
async function logCronRun(env: Env, task: string, status: string, message: string, details?: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO cron_logs (task, status, message, details, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).bind(task, status, message, details || null).run();
}

export function registerCronRoutes(router: Router) {
  /**
   * GET /api/cron/check-expiry
   * 检查即将到期的域名（7天内到期），记录日志
   */
  router.get('/api/cron/check-expiry', async (_request, env) => {
    try {
      const remindDays = 7;
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + remindDays);
      const expiryDateStr = expiryDate.toISOString().split('T')[0];

      const expiring = await env.DB.prepare(
        `SELECT s.id, s.full_name, s.user_id, s.expires_at, u.email, u.username
         FROM subdomains s
         JOIN users u ON s.user_id = u.id
         WHERE s.status = 1 AND s.expires_at IS NOT NULL
         AND date(s.expires_at) <= date(?)
         AND s.expires_at > datetime('now')
         ORDER BY s.expires_at ASC`
      ).bind(expiryDateStr).all();

      const count = expiring.results.length;
      const details = count > 0 ? JSON.stringify(expiring.results) : null;

      await logCronRun(env, 'check-expiry', 'success', `Found ${count} domains expiring within ${remindDays} days`, details);

      console.log(`[Cron] check-expiry: ${count} domains expiring within ${remindDays} days`);

      return successResponse({
        task: 'check-expiry',
        count,
        domains: expiring.results,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logCronRun(env, 'check-expiry', 'error', message);
      console.error(`[Cron] check-expiry error:`, message);
      return errorResponse(message, 500);
    }
  });

  /**
   * GET /api/cron/auto-renew
   * 自动续费即将到期的域名（1天内到期，auto_renew=1，余额充足）
   */
  router.get('/api/cron/auto-renew', async (_request, env) => {
    const now = new Date().toISOString();
    let renewed = 0;
    let skipped = 0;
    const errors: string[] = [];

    try {
      const candidates = await env.DB.prepare(
        `SELECT s.id, s.full_name, s.user_id, s.plan_id, s.expires_at,
                u.balance, p.price, p.duration_days
         FROM subdomains s
         JOIN users u ON s.user_id = u.id
         LEFT JOIN plans p ON s.plan_id = p.id
         WHERE s.auto_renew = 1 AND s.status = 1
         AND s.expires_at IS NOT NULL
         AND s.expires_at <= datetime('now', '+1 day')
         AND s.expires_at > datetime('now')`
      ).all();

      for (const sub of candidates.results) {
        const s = sub as Record<string, unknown>;
        const price = (s.price as number) || 0;
        const balance = (s.balance as number) || 0;
        const durationDays = (s.duration_days as number) || 30;

        if (balance < price) {
          skipped++;
          console.log(`[Cron] auto-renew: skip ${s.full_name} - insufficient balance (need ${price}, have ${balance})`);
          continue;
        }

        try {
          const newExpiry = new Date();
          newExpiry.setDate(newExpiry.getDate() + durationDays);

          await env.DB.batch([
            env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ?')
              .bind(price, s.user_id),
            env.DB.prepare('UPDATE subdomains SET expires_at = ?, last_renewed_at = ? WHERE id = ?')
              .bind(newExpiry.toISOString(), now, s.id),
            env.DB.prepare(
              `INSERT INTO purchase_records (user_id, subdomain_id, plan_id, amount, final_amount, subdomain_name, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).bind(s.user_id, s.id, s.plan_id, price, price, s.full_name, now),
          ]);

          renewed++;
          console.log(`[Cron] auto-renew: renewed ${s.full_name} for user ${s.user_id} (${price} yuan, ${durationDays} days)`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`${s.full_name}: ${msg}`);
          console.error(`[Cron] auto-renew error for ${s.full_name}:`, msg);
        }
      }

      const message = `Renewed ${renewed}, skipped ${skipped} (insufficient balance), errors ${errors.length}`;
      await logCronRun(env, 'auto-renew', errors.length > 0 ? 'partial' : 'success', message, errors.length > 0 ? JSON.stringify(errors) : null);

      console.log(`[Cron] auto-renew: ${message}`);

      return successResponse({
        task: 'auto-renew',
        renewed,
        skipped,
        errors,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logCronRun(env, 'auto-renew', 'error', message);
      console.error(`[Cron] auto-renew error:`, message);
      return errorResponse(message, 500);
    }
  });

  /**
   * GET /api/cron/check-idle
   * 检查闲置域名（创建30天以上且无任何 DNS 记录）
   */
  router.get('/api/cron/check-idle', async (_request, env) => {
    try {
      const idleDays = 30;
      const idleDate = new Date();
      idleDate.setDate(idleDate.getDate() - idleDays);
      const idleDateStr = idleDate.toISOString();

      const idleDomains = await env.DB.prepare(
        `SELECT s.id, s.full_name, s.user_id, s.created_at, s.first_record_at,
                u.email, u.username
         FROM subdomains s
         JOIN users u ON s.user_id = u.id
         WHERE s.status = 1
         AND s.first_record_at IS NULL
         AND (s.last_record_activity_at IS NULL OR s.last_record_activity_at <= ?)
         AND s.created_at <= ?
         ORDER BY s.created_at ASC`
      ).bind(idleDateStr, idleDateStr).all();

      // 标记已发送提醒
      for (const domain of idleDomains.results) {
        const d = domain as Record<string, unknown>;
        await env.DB.prepare(
          'UPDATE subdomains SET idle_reminder_sent_at = datetime(\'now\') WHERE id = ?'
        ).bind(d.id).run();
      }

      const count = idleDomains.results.length;
      const details = count > 0 ? JSON.stringify(idleDomains.results) : null;

      await logCronRun(env, 'check-idle', 'success', `Found ${count} idle domains (${idleDays}+ days, no DNS records)`, details);

      console.log(`[Cron] check-idle: ${count} idle domains found`);

      return successResponse({
        task: 'check-idle',
        count,
        domains: idleDomains.results,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logCronRun(env, 'check-idle', 'error', message);
      console.error(`[Cron] check-idle error:`, message);
      return errorResponse(message, 500);
    }
  });

  /**
   * GET /api/cron/cleanup
   * 清理过期的 token 和验证码
   */
  router.get('/api/cron/cleanup', async (_request, env) => {
    try {
      const now = new Date().toISOString();

      const results = await env.DB.batch([
        env.DB.prepare('DELETE FROM email_verifications WHERE expires_at < ?').bind(now),
        env.DB.prepare('DELETE FROM sms_verifications WHERE expires_at < ?').bind(now),
        env.DB.prepare('DELETE FROM magic_link_tokens WHERE expires_at < ?').bind(now),
      ]);

      const emailDeleted = results[0].meta?.changes || 0;
      const smsDeleted = results[1].meta?.changes || 0;
      const magicDeleted = results[2].meta?.changes || 0;
      const total = emailDeleted + smsDeleted + magicDeleted;

      const message = `Cleaned up ${total} expired records (email: ${emailDeleted}, sms: ${smsDeleted}, magic_link: ${magicDeleted})`;
      await logCronRun(env, 'cleanup', 'success', message);

      console.log(`[Cron] cleanup: ${message}`);

      return successResponse({
        task: 'cleanup',
        email_verifications: emailDeleted,
        sms_verifications: smsDeleted,
        magic_link_tokens: magicDeleted,
        total,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logCronRun(env, 'cleanup', 'error', message);
      console.error(`[Cron] cleanup error:`, message);
      return errorResponse(message, 500);
    }
  });

  /**
   * GET /api/cron/reset-email
   * 重置每日邮件发送限制
   */
  router.get('/api/cron/reset-email', async (_request, env) => {
    try {
      const today = new Date().toISOString().split('T')[0];

      const result = await env.DB.prepare(
        `UPDATE email_accounts SET daily_sent = 0, last_reset_at = ?
         WHERE date(last_reset_at) < date(?) OR last_reset_at IS NULL`
      ).bind(today, today).run();

      const count = result.meta?.changes || 0;

      const message = `Reset daily email limits for ${count} accounts`;
      await logCronRun(env, 'reset-email', 'success', message);

      console.log(`[Cron] reset-email: ${message}`);

      return successResponse({
        task: 'reset-email',
        accounts_reset: count,
        reset_date: today,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logCronRun(env, 'reset-email', 'error', message);
      console.error(`[Cron] reset-email error:`, message);
      return errorResponse(message, 500);
    }
  });
}