import { Router } from '../../router';
import { successResponse, errorResponse } from '../../utils/response';
import { authMiddleware } from '../../middleware/auth';
import type { DnsChannelRow } from '../../utils/types';

const SUPPORTED_PROVIDER_TYPES = [
  'cloudflare', 'aliyun', 'dnspod', 'baiducloud', 'huawei',
  'godaddy', 'namecom', 'namesilo', 'namecheap',
  'powerdns', 'route53', 'westcn', 'liuqu',
];

function maskCredentials(credentials: string): string {
  try {
    const creds = JSON.parse(credentials);
    const masked: Record<string, string> = {};
    for (const [key, value] of Object.entries(creds)) {
      if (typeof value === 'string') {
        if (value.length <= 6) {
          masked[key] = '******';
        } else {
          masked[key] = value.slice(0, 3) + '***' + value.slice(-3);
        }
      } else {
        masked[key] = '******';
      }
    }
    return JSON.stringify(masked);
  } catch {
    return '******';
  }
}

export function registerAdminChannelRoutes(router: Router) {
  /**
   * GET /api/admin/channels
   * 列出所有 DNS 渠道 (需要管理员权限)
   */
  router.get('/api/admin/channels', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const channels = await env.DB.prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM domains WHERE dns_channel_id = c.id) as domains_count,
              u.username as owner_username,
              u.email as owner_email
       FROM dns_channels c
       LEFT JOIN users u ON c.owner_id = u.id
       ORDER BY c.id DESC`
    ).all();

    const results = channels.results.map((row: Record<string, unknown>) => ({
      id: row.id,
      name: row.name,
      provider_type: row.provider_type,
      provider_name: row.provider_type,
      status: row.status,
      remark: row.remark,
      domains_count: row.domains_count,
      owner: row.owner_id
        ? {
            id: row.owner_id,
            username: row.owner_username,
            email: row.owner_email,
          }
        : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    return successResponse(results);
  });

  /**
   * POST /api/admin/channels
   * 创建 DNS 渠道 (需要管理员权限)
   */
  router.post('/api/admin/channels', async (request, env) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const body = await request.json() as {
      name: string;
      provider_type: string;
      credentials: Record<string, unknown>;
      config?: Record<string, unknown>;
      remark?: string;
      owner_id?: number;
    };

    const { name, provider_type, credentials, config, remark, owner_id } = body;

    if (!name || !name.trim()) {
      return errorResponse('渠道名称不能为空');
    }

    if (!provider_type) {
      return errorResponse('服务商类型不能为空');
    }

    if (!SUPPORTED_PROVIDER_TYPES.includes(provider_type)) {
      return errorResponse(
        `不支持的服务商类型: ${provider_type}，支持的类型: ${SUPPORTED_PROVIDER_TYPES.join(', ')}`
      );
    }

    if (!credentials || typeof credentials !== 'object' || Object.keys(credentials).length === 0) {
      return errorResponse('凭据信息不能为空');
    }

    // 验证 owner_id 是否存在
    if (owner_id) {
      const owner = await env.DB.prepare(
        'SELECT id FROM users WHERE id = ?'
      ).bind(owner_id).first<{ id: number }>();
      if (!owner) {
        return errorResponse('指定的所有者不存在', 404);
      }
    }

    const credentialsJson = JSON.stringify(credentials);
    const configJson = config ? JSON.stringify(config) : null;
    const now = new Date().toISOString();

    const result = await env.DB.prepare(
      `INSERT INTO dns_channels (owner_id, name, provider_type, credentials, config, remark, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      owner_id || null,
      name.trim(),
      provider_type,
      credentialsJson,
      configJson,
      remark || null,
      now,
      now
    ).run();

    const channelId = result.meta.last_row_id;

    const channel = await env.DB.prepare(
      'SELECT * FROM dns_channels WHERE id = ?'
    ).bind(channelId).first<DnsChannelRow>();

    return successResponse({
      id: channel?.id,
      name: channel?.name,
      provider_type: channel?.provider_type,
      status: channel?.status,
      remark: channel?.remark,
      created_at: channel?.created_at,
    }, '渠道创建成功');
  });

  /**
   * GET /api/admin/channels/:id
   * 获取 DNS 渠道详情 (需要管理员权限)
   */
  router.get('/api/admin/channels/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const channelId = parseInt(params.id);
    if (isNaN(channelId)) {
      return errorResponse('无效的渠道ID');
    }

    const channel = await env.DB.prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM domains WHERE dns_channel_id = c.id) as domains_count,
              u.username as owner_username,
              u.email as owner_email
       FROM dns_channels c
       LEFT JOIN users u ON c.owner_id = u.id
       WHERE c.id = ?`
    ).bind(channelId).first<DnsChannelRow & {
      domains_count: number;
      owner_username: string | null;
      owner_email: string | null;
    }>();

    if (!channel) {
      return errorResponse('渠道不存在', 404);
    }

    let config: Record<string, unknown> | null = null;
    if (channel.config) {
      try { config = JSON.parse(channel.config); } catch { /* ignore */ }
    }

    return successResponse({
      id: channel.id,
      name: channel.name,
      provider_type: channel.provider_type,
      provider_name: channel.provider_type,
      credentials: maskCredentials(channel.credentials),
      credentials_raw: channel.credentials,
      status: channel.status,
      config: config,
      remark: channel.remark,
      domains_count: channel.domains_count,
      owner: channel.owner_id
        ? {
            id: channel.owner_id,
            username: channel.owner_username,
            email: channel.owner_email,
          }
        : null,
      created_at: channel.created_at,
      updated_at: channel.updated_at,
    });
  });

  /**
   * PUT /api/admin/channels/:id
   * 更新 DNS 渠道 (需要管理员权限)
   */
  router.put('/api/admin/channels/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const channelId = parseInt(params.id);
    if (isNaN(channelId)) {
      return errorResponse('无效的渠道ID');
    }

    const existing = await env.DB.prepare(
      'SELECT * FROM dns_channels WHERE id = ?'
    ).bind(channelId).first<DnsChannelRow>();

    if (!existing) {
      return errorResponse('渠道不存在', 404);
    }

    const body = await request.json() as {
      name?: string;
      provider_type?: string;
      credentials?: Record<string, unknown>;
      config?: Record<string, unknown> | null;
      status?: number;
      remark?: string;
    };

    const { name, provider_type, credentials, config, status, remark } = body;

    if (provider_type && !SUPPORTED_PROVIDER_TYPES.includes(provider_type)) {
      return errorResponse(
        `不支持的服务商类型: ${provider_type}，支持的类型: ${SUPPORTED_PROVIDER_TYPES.join(', ')}`
      );
    }

    const updates: string[] = [];
    const binds: unknown[] = [];

    if (name !== undefined) {
      if (!name.trim()) {
        return errorResponse('渠道名称不能为空');
      }
      updates.push('name = ?');
      binds.push(name.trim());
    }

    if (provider_type !== undefined) {
      updates.push('provider_type = ?');
      binds.push(provider_type);
    }

    if (credentials !== undefined) {
      if (typeof credentials !== 'object' || Object.keys(credentials).length === 0) {
        return errorResponse('凭据信息不能为空');
      }
      updates.push('credentials = ?');
      binds.push(JSON.stringify(credentials));
    }

    if (config !== undefined) {
      updates.push('config = ?');
      binds.push(config ? JSON.stringify(config) : null);
    }

    if (status !== undefined) {
      updates.push('status = ?');
      binds.push(status);
    }

    if (remark !== undefined) {
      updates.push('remark = ?');
      binds.push(remark);
    }

    if (updates.length === 0) {
      return errorResponse('没有需要更新的字段');
    }

    updates.push("updated_at = datetime('now')");
    binds.push(channelId);

    await env.DB.prepare(
      `UPDATE dns_channels SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...binds).run();

    const updated = await env.DB.prepare(
      'SELECT * FROM dns_channels WHERE id = ?'
    ).bind(channelId).first<DnsChannelRow>();

    return successResponse({
      id: updated?.id,
      name: updated?.name,
      provider_type: updated?.provider_type,
      status: updated?.status,
      remark: updated?.remark,
      created_at: updated?.created_at,
      updated_at: updated?.updated_at,
    }, '渠道更新成功');
  });

  /**
   * DELETE /api/admin/channels/:id
   * 删除 DNS 渠道 (需要管理员权限)
   */
  router.delete('/api/admin/channels/:id', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const channelId = parseInt(params.id);
    if (isNaN(channelId)) {
      return errorResponse('无效的渠道ID');
    }

    const existing = await env.DB.prepare(
      'SELECT * FROM dns_channels WHERE id = ?'
    ).bind(channelId).first<DnsChannelRow>();

    if (!existing) {
      return errorResponse('渠道不存在', 404);
    }

    // 检查是否有域名使用此渠道
    const domainCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM domains WHERE dns_channel_id = ?'
    ).bind(channelId).first<{ count: number }>();

    if (domainCount && domainCount.count > 0) {
      return errorResponse(
        `该渠道下有 ${domainCount.count} 个域名正在使用，无法删除。请先迁移或删除相关域名`
      );
    }

    await env.DB.prepare(
      'DELETE FROM dns_channels WHERE id = ?'
    ).bind(channelId).run();

    return successResponse({
      id: channelId,
      name: existing.name,
    }, '渠道删除成功');
  });

  /**
   * POST /api/admin/channels/:id/verify
   * 验证 DNS 渠道凭据 (需要管理员权限)
   */
  router.post('/api/admin/channels/:id/verify', async (request, env, params) => {
    const auth = await authMiddleware(request, env, true);
    if (auth instanceof Response) return auth;

    const channelId = parseInt(params.id);
    if (isNaN(channelId)) {
      return errorResponse('无效的渠道ID');
    }

    const channel = await env.DB.prepare(
      'SELECT * FROM dns_channels WHERE id = ?'
    ).bind(channelId).first<DnsChannelRow>();

    if (!channel) {
      return errorResponse('渠道不存在', 404);
    }

    let credentials: Record<string, string>;
    try {
      credentials = JSON.parse(channel.credentials);
    } catch {
      return errorResponse('凭据格式无效，无法解析');
    }

    const providerType = channel.provider_type;

    try {
      if (providerType === 'cloudflare') {
        // 验证 Cloudflare API Token 或 API Key
        const apiToken = credentials.api_token || credentials.token;
        const apiKey = credentials.api_key;
        const email = credentials.email;

        let headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        if (apiToken) {
          headers['Authorization'] = `Bearer ${apiToken}`;
        } else if (apiKey && email) {
          headers['X-Auth-Email'] = email;
          headers['X-Auth-Key'] = apiKey;
        } else {
          return errorResponse('Cloudflare 凭据不完整，需要提供 api_token 或 (api_key + email)');
        }

        const response = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
          method: 'GET',
          headers,
        });

        const result = await response.json() as { success: boolean; errors?: Array<{ message: string }>; messages?: Array<{ message: string }> };

        if (result.success) {
          return successResponse({
            provider: 'cloudflare',
            status: 'success',
            message: 'Cloudflare API 凭据验证成功',
            raw: result,
          });
        } else {
          return errorResponse(
            `Cloudflare API 验证失败: ${result.errors?.[0]?.message || '未知错误'}`
          );
        }
      } else if (providerType === 'aliyun') {
        // 阿里云 DNS 验证：尝试获取域名列表
        const accessKeyId = credentials.access_key_id || credentials.AccessKeyId;
        const accessKeySecret = credentials.access_key_secret || credentials.AccessKeySecret;

        if (!accessKeyId || !accessKeySecret) {
          return errorResponse('阿里云凭据不完整，需要提供 access_key_id 和 access_key_secret');
        }

        return successResponse({
          provider: 'aliyun',
          status: 'success',
          message: '阿里云凭据格式验证通过（API 连通性验证需在服务端实现签名逻辑）',
        });
      } else if (providerType === 'route53') {
        const awsAccessKey = credentials.access_key_id || credentials.AccessKeyId;
        const awsSecretKey = credentials.secret_access_key || credentials.SecretAccessKey;

        if (!awsAccessKey || !awsSecretKey) {
          return errorResponse('AWS Route53 凭据不完整，需要提供 access_key_id 和 secret_access_key');
        }

        return successResponse({
          provider: 'route53',
          status: 'success',
          message: 'AWS Route53 凭据格式验证通过（API 连通性验证需在服务端实现 AWS Signature V4 签名逻辑）',
        });
      } else {
        // 其他服务商：基本格式验证
        return successResponse({
          provider: providerType,
          status: 'success',
          message: `凭据格式验证通过，${providerType} 服务商连通性验证暂不支持自动检测`,
        });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '未知错误';
      return errorResponse(`凭据验证异常: ${errorMessage}`);
    }
  });
}