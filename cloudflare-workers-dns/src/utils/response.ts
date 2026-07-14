/**
 * 统一 JSON 响应格式
 */
export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data?: T;
  error?: string;
}

export function jsonResponse<T>(data: T, status = 200): Response {
  const body: ApiResponse<T> = {
    code: status >= 400 ? status : 200,
    message: status >= 400 ? 'error' : 'success',
    data: status < 400 ? data : undefined,
    error: status >= 400 ? String(data) : undefined,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function successResponse<T>(data: T, message = 'success'): Response {
  return new Response(JSON.stringify({ code: 200, message, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function errorResponse(message: string, code = 400): Response {
  return new Response(JSON.stringify({ code, message, error: message }), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export function redirectResponse(url: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: { Location: url },
  });
}

export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Timestamp, X-Signature',
    'Access-Control-Max-Age': '86400',
  };
}

export function getClientIP(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Real-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    '127.0.0.1';
}