/**
 * 环回鉴权垫片（dsh-ofm-patch，2026-11-26）。
 *
 * 背景：DSH 的 webServer 所有路由都过 `dsh-client-connection` 的 cookie 闸门，
 * 插件用 web.register 挂的 prefix 路由也不例外。OFM 的聚合车道（aggregate）从
 * 进程内部 fetch `http://127.0.0.1:<port>/api/ofm-patch/zen-gateway/...` 时只带
 * Authorization，不带 dsh-auth cookie → 401，zen 车道整条废掉。
 *
 * 上一版把签 cookie 的代码写进了 OFM 本体（aggregate.js），被用户否掉：
 * 「不要修 OFM 本体」。本版改为在补丁插件里包一层 globalThis.fetch——
 * OFM 的 `src/egress.js` 用的是裸 `fetch(...)`（调用时从全局作用域取），
 * 所以这层垫片能生效，而 OFM 一个字节都不用改。
 *
 * 只对「回环地址 + 本插件网关前缀」的请求补 cookie，其余请求原样透传；
 * 任何异常一律 fail-open（放行原请求），绝不阻断别的插件或用户自己的调用。
 */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const INSTALLED = Symbol.for('dsh-ofm-patch.loopback-auth')
const COOKIE_TTL_MS = 3_600_000
const GATEWAY_PREFIX = '/api/ofm-patch/zen-gateway'

let cachedSecret = null
let cachedSecretAt = 0

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 宿主签 cookie 用的 secret（与插件自调 OFM API 时同源）。 */
function hostSecret() {
  const now = Date.now()
  if (cachedSecret !== null && now - cachedSecretAt < 600_000) return cachedSecret
  try {
    const cred = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
    const match = cred.match(/client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/) ??
      cred.match(/secret:\s*(\S+)/)
    if (match === null) return null
    cachedSecret = Buffer.from(match[1], 'base64url')
    cachedSecretAt = now
    return cachedSecret
  } catch {
    return null
  }
}

function authorityOf(input) {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
    if (typeof raw !== 'string') return null
    const url = new URL(raw, 'http://127.0.0.1')
    return url
  } catch {
    return null
  }
}

function isLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

/** 为回环网关地址签一个 dsh-auth cookie；不需要时返回 null。 */
export function loopbackCookie(url) {
  const parsed = authorityOf(url)
  if (parsed === null) return null
  if (!isLoopback(parsed.hostname)) return null
  if (!parsed.pathname.startsWith(GATEWAY_PREFIX)) return null
  const secret = hostSecret()
  if (secret === null) return null
  const authority = parsed.host
  const now = Date.now()
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    authority,
    issuedAt: now,
    expiresAt: now + COOKIE_TTL_MS,
  })).toString('base64url')
  const name = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${name}=v1.${payload}.${signature}`
}

/** 把 cookie 合进各种形态的 init（undefined / plain object / Headers）。 */
function withCookie(init, cookie) {
  const next = { ...(init ?? {}) }
  const existing = next.headers
  if (existing === undefined || existing === null) {
    next.headers = { cookie }
    return next
  }
  if (typeof existing.forEach === 'function' && typeof existing.get === 'function') {
    if (existing.get('cookie') !== null) return next
    const headers = new Headers(existing)
    headers.set('cookie', cookie)
    next.headers = headers
    return next
  }
  if (Array.isArray(existing)) {
    if (existing.some(pair => String(pair?.[0]).toLowerCase() === 'cookie')) return next
    next.headers = [...existing, ['cookie', cookie]]
    return next
  }
  const hasCookie = Object.keys(existing).some(key => key.toLowerCase() === 'cookie')
  next.headers = hasCookie ? existing : { ...existing, cookie }
  return next
}

/**
 * 安装垫片（幂等）。返回卸载函数。
 * @param {{log?: (msg: string) => void}} [options]
 */
export function installLoopbackAuth(options = {}) {
  const log = options.log ?? (() => {})
  const current = globalThis.fetch
  if (typeof current !== 'function') return () => {}
  if (globalThis[INSTALLED] === true) return () => {}

  const shim = function fetchWithLoopbackAuth(input, init) {
    try {
      const cookie = loopbackCookie(input)
      if (cookie !== null) return current(input, withCookie(init, cookie))
    } catch {
      /* fail-open：签不出来就按原样发 */
    }
    return current(input, init)
  }

  try {
    Object.defineProperty(globalThis, 'fetch', { value: shim, writable: true, configurable: true, enumerable: false })
    globalThis[INSTALLED] = true
    log('loopback-auth: fetch shim installed (zen-gateway cookie signed in-process)')
  } catch (error) {
    log(`loopback-auth: install failed (fail-open) ${String(error?.message ?? error)}`)
  }

  return () => {
    try {
      if (globalThis.fetch === shim) Object.defineProperty(globalThis, 'fetch', { value: current, writable: true, configurable: true, enumerable: false })
      globalThis[INSTALLED] = false
    } catch { /* 卸载失败无害：垫片本身 fail-open */ }
  }
}
