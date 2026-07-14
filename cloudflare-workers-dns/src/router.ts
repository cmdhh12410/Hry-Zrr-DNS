import type { Env } from './utils/types';
import { corsHeaders } from './utils/response';

type Handler = (request: Request, env: Env, params: Record<string, string>) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

/**
 * 简单路由匹配器
 */
class Router {
  private routes: Route[] = [];
  private middlewares: ((request: Request, env: Env) => Promise<Response | null>)[] = [];

  use(middleware: (request: Request, env: Env) => Promise<Response | null>) {
    this.middlewares.push(middleware);
  }

  get(pattern: string, handler: Handler) {
    this.routes.push({ method: 'GET', pattern, handler });
  }

  post(pattern: string, handler: Handler) {
    this.routes.push({ method: 'POST', pattern, handler });
  }

  put(pattern: string, handler: Handler) {
    this.routes.push({ method: 'PUT', pattern, handler });
  }

  delete(pattern: string, handler: Handler) {
    this.routes.push({ method: 'DELETE', pattern, handler });
  }

  patch(pattern: string, handler: Handler) {
    this.routes.push({ method: 'PATCH', pattern, handler });
  }

  private match(pattern: string, pathname: string): Record<string, string> | null {
    const patternParts = pattern.split('/');
    const pathParts = pathname.split('/');

    if (patternParts.length !== pathParts.length) {
      return null;
    }

    const params: Record<string, string> = {};
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(':')) {
        params[patternParts[i].slice(1)] = pathParts[i];
      } else if (patternParts[i] !== pathParts[i]) {
        return null;
      }
    }

    return params;
  }

  async handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    // 处理 CORS 预检请求
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(),
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Timestamp, X-Signature',
        },
      });
    }

    // 运行中间件
    for (const middleware of this.middlewares) {
      const result = await middleware(request, env);
      if (result) return result;
    }

    // 匹配路由
    for (const route of this.routes) {
      if (route.method !== method && route.method !== 'ALL') continue;
      const params = this.match(route.pattern, pathname);
      if (params !== null) {
        const response = await route.handler(request, env, params);
        // 为 JSON 响应添加 CORS 头
        const contentType = response.headers.get('Content-Type') || '';
        if (contentType.includes('application/json')) {
          const newHeaders = new Headers(response.headers);
          Object.entries(corsHeaders()).forEach(([k, v]) => {
            if (!newHeaders.has(k)) newHeaders.set(k, v);
          });
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        }
        return response;
      }
    }

    // 404
    return new Response(JSON.stringify({ code: 404, message: 'Not Found' }), {
      status: 404,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...corsHeaders(),
      },
    });
  }
}

export { Router };
export type { Handler, Route };