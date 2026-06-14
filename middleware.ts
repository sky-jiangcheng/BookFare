/**
 * Next.js 中间件 — 速率限制 + 安全头
 *
 * API 路由的频率限制。
 * 使用 Upstash Redis 实现分布式限流（支持 serverless 环境）；
 * Redis 不可用时降级为内存计数（仅在单实例场景有效）。
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAllowedOrigin } from '@/lib/utils/cors';

function addCorsHeaders(response: NextResponse, request: NextRequest): NextResponse {
  const origin = getAllowedOrigin(request);
  if (origin) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    response.headers.set('Access-Control-Max-Age', '3600');
  }
  return response;
}

// ============================================================
// 分布式速率限制器（Upstash Redis 优先，内存降级）
// ============================================================

interface RateLimitEntry {
  /** 窗口内请求数 */
  count: number;
  /** 窗口起始时间戳（ms） */
  windowStart: number;
}

/** 内存降级存储（仅 Redis 不可用时使用，serverless 下每个冷启动独立） */
const memoryRateLimitMap = new Map<string, RateLimitEntry>();

/** 默认配置：每 IP 每 60 秒最多 30 次 API 请求 */
const DEFAULT_MAX_REQUESTS = 30;
const DEFAULT_WINDOW_MS = 60_000;

/**
 * 尝试通过 Upstash Redis 进行分布式限流。
 * 使用 Lua 脚本保证原子性，避免竞态条件。
 * Redis 不可用时返回 null，由调用方降级到内存限流。
 */
const RATE_LIMIT_LUA_SCRIPT = `
local windowKey = KEYS[1]
local countKey = KEYS[2]
local windowMs = tonumber(ARGV[1])
local maxRequests = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = math.ceil(windowMs / 1000) * 2

local windowStart = redis.call('GET', windowKey)
if not windowStart or (now - tonumber(windowStart)) > windowMs then
  redis.call('SET', windowKey, now, 'EX', ttl)
  redis.call('SET', countKey, 1, 'EX', ttl)
  return {1, maxRequests - 1, now + windowMs}
end

local currentCount = redis.call('INCR', countKey)
local remaining = math.max(0, maxRequests - currentCount)
local allowed = 0
if currentCount <= maxRequests then
  allowed = 1
end

return {allowed, remaining, tonumber(windowStart) + windowMs}
`;

async function checkRedisRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): Promise<{ allowed: boolean; remaining: number; resetTime: number } | null> {
  try {
    const { redis } = await import('@/lib/upstash');
    if (!redis) return null;

    const now = Date.now();
    const windowKey = `ratelimit:window:${key}`;
    const countKey = `ratelimit:count:${key}`;

    const result = await redis.eval(
      RATE_LIMIT_LUA_SCRIPT,
      [windowKey, countKey],
      [String(windowMs), String(maxRequests), String(now)]
    ) as [number, number, number];

    return {
      allowed: result[0] === 1,
      remaining: result[1],
      resetTime: result[2],
    };
  } catch (error) {
    // Redis unavailable — degrade to per-instance in-memory limiting. Log so a
    // silent loss of distributed rate-limit visibility doesn't go unnoticed.
    console.warn('[middleware] Redis rate-limit failed, degrading to in-memory limiting:', error);
    return null;
  }
}

function checkMemoryRateLimit(
  key: string,
  maxRequests: number = DEFAULT_MAX_REQUESTS,
  windowMs: number = DEFAULT_WINDOW_MS,
): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now();
  const entry = memoryRateLimitMap.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
    // 新窗口
    memoryRateLimitMap.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: maxRequests - 1, resetTime: now + windowMs };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetTime: entry.windowStart + windowMs };
  }

  entry.count += 1;
  return { allowed: true, remaining: maxRequests - entry.count, resetTime: entry.windowStart + windowMs };
}

/** 标记是否已输出过内存限流降级警告（避免日志刷屏） */
let memoryFallbackWarned = false;

/**
 * 统一限流检查：Redis 优先 → 内存降级
 *
 * 内存降级在 serverless 环境下每个冷启动独立，限流效果有限，
 * 但至少能为单实例内的重复请求提供基本保护。
 */
async function checkRateLimit(
  key: string,
  maxRequests: number = DEFAULT_MAX_REQUESTS,
  windowMs: number = DEFAULT_WINDOW_MS,
): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
  const redisResult = await checkRedisRateLimit(key, maxRequests, windowMs);
  if (redisResult !== null) return redisResult;

  // 降级到内存限流 — 在 serverless 环境下输出警告
  if (!memoryFallbackWarned) {
    console.warn(
      '[rate-limit] Falling back to in-memory rate limiting. ' +
      'This is ineffective in serverless environments (each cold start has independent state). ' +
      'Configure UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for distributed rate limiting.',
    );
    memoryFallbackWarned = true;
  }
  return checkMemoryRateLimit(key, maxRequests, windowMs);
}

// ============================================================
// IP 地址提取（支持 IPv4 和 IPv6）
// ============================================================

/** IPv4 正则：4 组 1-3 位数字 */
const IPv4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

/** IPv6 正则：支持标准格式、压缩格式和 IPv4-mapped 格式 */
const IPv6_REGEX =
  /^([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}$|^::([0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{0,4}$|^([0-9a-fA-F]{1,4}:){1,6}:$|^::$/;

/**
 * 去掉 IP 地址中可能的端口号。
 * IPv4: 1.2.3.4:8080 → 1.2.3.4
 * IPv6: [::1]:8080 → ::1 （方括号形式）
 * IPv6: ::1 → ::1 （无端口）
 */
function removePort(ip: string): string {
  // IPv6 带方括号和端口：[::1]:8080
  if (ip.startsWith('[') && ip.includes(']:')) {
    return ip.slice(1, ip.indexOf(']:'));
  }
  // IPv6 带方括号无端口：[::1]
  if (ip.startsWith('[') && ip.endsWith(']')) {
    return ip.slice(1, -1);
  }
  // IPv4 带端口：1.2.3.4:8080（最后一个冒号后是纯数字）
  const lastColon = ip.lastIndexOf(':');
  if (lastColon > 0 && IPv4_REGEX.test(ip.slice(0, lastColon))) {
    return ip.slice(0, lastColon);
  }
  return ip;
}

/**
 * 验证 IP 地址格式（IPv4 / IPv6，可带端口）。
 */
function isValidIp(ip: string): boolean {
  const trimmed = ip.trim();
  if (!trimmed) return false;
  const hostPart = removePort(trimmed);
  if (IPv4_REGEX.test(hostPart)) return true;
  if (hostPart.includes(':') && IPv6_REGEX.test(hostPart)) return true;
  return false;
}

/**
 * 提取客户端真实 IP 地址。
 *
 * 优先级：x-forwarded-for 第一个条目 → x-real-ip → 'unknown'
 * 正确处理 IPv4 和 IPv6 格式（含带端口的格式）。
 * 无法识别时不使用 127.0.0.1，避免多用户共享同一限流桶。
 */
function extractClientIp(request: NextRequest): string {
  // x-forwarded-for 可能包含多个 IP（代理链），取第一个（最接近客户端的）
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const firstIp = forwardedFor.split(',')[0].trim();
    if (firstIp && isValidIp(firstIp)) {
      return removePort(firstIp).toLowerCase();
    }
  }

  // 尝试 x-real-ip header
  const realIp = request.headers.get('x-real-ip');
  if (realIp && isValidIp(realIp)) {
    return removePort(realIp).toLowerCase();
  }

  // 无法识别 IP 时使用 unknown（不使用 127.0.0.1 避免多用户共享同一限流桶）
  // 注意: x-forwarded-for 可被客户端伪造。在生产环境（Vercel）中此头由边缘网络可信代理设置；
  // 直接面向公网的部署应考虑使用可信代理列表验证或采用 True-Client-IP / CF-Connecting-IP 等替代来源。
  return 'unknown';
}

// ============================================================
// 内存限流清理（惰性清理替代 setInterval）
// ============================================================

/** 上次清理时间戳 */
let lastCleanupTime = 0;

/**
 * 惰性清理过期的内存限流条目。
 * 在每次限流检查时调用，替代 setInterval（serverless 不支持持久定时器）。
 */
function maybeCleanupMemoryMap(): void {
  const now = Date.now();
  // 最多每 60 秒清理一次
  if (now - lastCleanupTime < DEFAULT_WINDOW_MS) return;
  lastCleanupTime = now;

  for (const [key, entry] of memoryRateLimitMap.entries()) {
    if (now - entry.windowStart > DEFAULT_WINDOW_MS * 2) {
      memoryRateLimitMap.delete(key);
    }
  }
}

// ============================================================
// 中间件主逻辑
// ============================================================

/** 不需要频率限制的路径（健康检查、静态资源） */
const RATE_LIMIT_EXEMPT_PATHS = [
  '/api/health',
  '/_next/',
  '/static/',
  '/favicon',
  '/robots.txt',
];

/** 安全响应头：所有响应都设置 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 放行不需要限流的路径
  if (RATE_LIMIT_EXEMPT_PATHS.some((p) => pathname.startsWith(p))) {
    const response = NextResponse.next();
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      response.headers.set(key, value);
    }
    return addCorsHeaders(response, request);
  }

  // 仅对 API 路由做限流
  if (!pathname.startsWith('/api/')) {
    const response = NextResponse.next();
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      response.headers.set(key, value);
    }
    return addCorsHeaders(response, request);
  }

  const ip = extractClientIp(request);
  const rateLimitKey = `ratelimit:${ip}`;

  // 惰性清理过期条目
  maybeCleanupMemoryMap();

  const { allowed, remaining, resetTime } = await checkRateLimit(rateLimitKey);

  if (!allowed) {
    const retryAfter = Math.ceil((resetTime - Date.now()) / 1000);
    const response = new NextResponse(
      JSON.stringify({ error: '请求过于频繁，请稍后再试', retry_after: retryAfter }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(DEFAULT_MAX_REQUESTS),
          'X-RateLimit-Remaining': '0',
          ...SECURITY_HEADERS,
        },
      },
    );
    return addCorsHeaders(response, request);
  }

  const response = NextResponse.next();
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
  response.headers.set('X-RateLimit-Limit', String(DEFAULT_MAX_REQUESTS));
  response.headers.set('X-RateLimit-Remaining', String(remaining));
  return addCorsHeaders(response, request);
}

export const config = {
  matcher: '/api/:path*',
};
