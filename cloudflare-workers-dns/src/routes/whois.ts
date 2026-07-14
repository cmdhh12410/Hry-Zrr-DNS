import { Router } from '../router';
import { successResponse, errorResponse } from '../utils/response';
import type { Env } from '../utils/types';

/**
 * 从域名中提取 name 和 suffix (TLD)
 * 例如: example.com → { name: 'example', suffix: 'com' }
 *       sub.example.co.uk → { name: 'sub.example', suffix: 'co.uk' }
 */
function parseDomain(domain: string): { name: string; suffix: string } | null {
  const cleaned = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  if (!cleaned || !cleaned.includes('.')) return null;

  // 常见的多级 TLD 列表
  const multiLevelTLDs = [
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk',
    'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
    'com.br', 'org.br', 'net.br', 'gov.br',
    'com.au', 'net.au', 'org.au', 'gov.au', 'edu.au',
    'co.nz', 'net.nz', 'org.nz',
    'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in',
    'co.kr', 'or.kr', 'ne.kr',
    'com.tw', 'net.tw', 'org.tw',
    'com.hk', 'net.hk', 'org.hk',
    'com.sg', 'net.sg', 'org.sg',
  ];

  for (const mTLD of multiLevelTLDs) {
    if (cleaned.endsWith('.' + mTLD) && cleaned.length > mTLD.length + 1) {
      const name = cleaned.slice(0, -(mTLD.length + 1));
      return { name, suffix: mTLD };
    }
  }

  const parts = cleaned.split('.');
  const suffix = parts.pop()!;
  const name = parts.join('.');
  return { name, suffix };
}

export function registerWhoisRoutes(router: Router) {
  /**
   * GET /api/whois
   * 查询域名的 WHOIS 信息
   * Query params: ?domain=example.com
   */
  router.get('/api/whois', async (request, env) => {
    const url = new URL(request.url);
    const domain = url.searchParams.get('domain');

    if (!domain) {
      return errorResponse('请提供 domain 参数');
    }

    const parsed = parseDomain(domain);
    if (!parsed) {
      return errorResponse('域名格式不正确');
    }

    const { name, suffix } = parsed;

    try {
      const apiUrl = `https://whois.freeaiapi.xyz/?name=${encodeURIComponent(name)}&suffix=${encodeURIComponent(suffix)}`;
      const response = await fetch(apiUrl);

      if (!response.ok) {
        return errorResponse(`WHOIS 查询失败: 上游服务返回 ${response.status}`, 502);
      }

      const contentType = response.headers.get('Content-Type') || '';
      if (contentType.includes('application/json')) {
        const data = await response.json() as Record<string, unknown>;
        return successResponse(data);
      }

      const text = await response.text();
      return successResponse({ raw: text });
    } catch (err) {
      console.error('WHOIS query error:', err);
      return errorResponse(
        'WHOIS 查询服务暂时不可用，请稍后重试',
        503
      );
    }
  });
}