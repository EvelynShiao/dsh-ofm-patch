/**
 * dsh-ofm-patch v2 — OFM 白名单同步器（零包装架构）。
 *
 * v1 教训（2026-11-17）：属性写回式包装 adapter.listModels 与上游 2.8.5 的
 * withDeadModelPruning Proxy（vendor/channel-pack）结构性冲突——Proxy get 缓存
 * 看不到写穿到底层的 WRAP 标记，幂等失效 + 调用环 → 无限递归爆栈，picker 全灭。
 *
 * v2 原理：上游 2.8.5 原生支持 hiddenModelIds 黑名单（computeMembership 构建
 * membership 时过滤，listModels 只吐 membership 内模型）。本插件只做一件事：
 * 维护「白名单语义」——周期对比当前可见模型与白名单，把白名单外的新模型写进
 * hiddenModelIds（走 OFM 自己的 POST /api/our-free-model/settings，sanitize +
 * 落盘 + emitTopology 即时生效），全程零包装、零 adapter 触碰。
 *
 * 语义（fork 2026-10-23 定案延续）：
 * - visibleModels 是数组 → picker 只显示白名单内模型（新模型默认隐藏）。
 * - 白名单文件缺失/损坏/字段非数组 → 什么都不动（fail-open，picker 维持现状）。
 * - 白名单内 id 无条件从 hiddenModelIds 移除（用户加回白名单即时可见，无死锁）。
 * - resolveModel 不过滤：旧会话已选中的隐藏模型照常能跑（上游原生语义）。
 *
 * 数据源：
 * - 白名单：$DSH_HOME/our-free-model-patch/settings.json 的 visibleModels
 * - 可见集：ctx.llm.listModels('our-free-model' | 'our-free-model-region')
 *   （新模型在未被 hidden 前必然出现在 membership——正是要拦截的窗口）
 * - region 车道是动态的：上游 computeMembership 只在存在 regionBlocked 模型时
 *   才把该 key 放进 membership，'loader/volatile-update' 触发 registration.replace
 *   后 adapter 注销——NO_ADAPTER 是常态（本 egress 无 region 限制模型），
 *   不是故障；只在进入/离开该状态时各记一条日志，不每轮刷屏。
 * - 写入：POST /api/our-free-model/settings { hiddenModelIds }（自签 dsh-auth
 *   cookie，与宿主同机信任域；端口可经本插件 settings.json 的 hostPort 覆盖）
 *
 * @module index.js
 */

import { readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, createHmac } from 'node:crypto'

export const name = 'our-free-model-patch'
export const inject = ['llm']

const ROUTES = ['our-free-model', 'our-free-model-region']
const HIDDEN_CAP = 1000 // 上游 store.js 校验上限，超限整包 400
const SYNC_INTERVAL_MS = 60_000
const DEBOUNCE_MS = 2_000
// 车道动态注册的降噪状态：true = 已记过「未注册」且尚未恢复（静默中）
const laneSilent = new Map()

/** DSH 主目录：与宿主/其他插件同一套推导（DSH_HOME 优先）。 */
function dshHomeDir(env = process.env) {
  const fromEnv = env?.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const home = env?.USERPROFILE ?? env?.HOME
  return home ? `${String(home).replace(/[\\/]+$/u, '')}/.dsh` : '.dsh'
}

function log(line, home = dshHomeDir()) {
  try {
    appendFileSync(join(home, 'dsh-ofm-patch.log'), `${new Date().toISOString()} ${line}\n`)
  } catch { /* 日志失败绝不外抛 */ }
}

/** 读白名单。返回数组 = 启用白名单；null = 透传（不写任何 hidden）。 */
function readWhitelist(home = dshHomeDir()) {
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'our-free-model-patch', 'settings.json'), 'utf8'))
    return Array.isArray(parsed?.visibleModels)
      ? parsed.visibleModels.filter(id => typeof id === 'string' && id.length > 0)
      : null
  } catch {
    return null
  }
}

/** 读本插件可选配置（hostPort）。 */
function readPatchConfig(home = dshHomeDir()) {
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'our-free-model-patch', 'settings.json'), 'utf8'))
    const port = Number(parsed?.hostPort)
    return Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}
  } catch {
    return {}
  }
}

/** 读 OFM 当前 hiddenModelIds（读文件只为幂等比对，写入永远走 API）。 */
function readCurrentHidden(home = dshHomeDir()) {
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'our-free-model', 'settings.json'), 'utf8'))
    return Array.isArray(parsed?.hiddenModelIds) ? parsed.hiddenModelIds.filter(id => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** dsh-auth cookie（与宿主 webserver 校验同一算法，authority 必须与 Host 一致）。 */
function authCookie(host) {
  const cred = readFileSync(join(dshHomeDir(), '.credentials.yaml'), 'utf8')
  const secret = Buffer.from(cred.match(/secret:\s*(\S+)/)[1], 'base64url')
  const b64url = b => Buffer.from(b).toString('base64url')
  const now = Date.now()
  const p64 = b64url(JSON.stringify({ version: 1, authority: host, issuedAt: now, expiresAt: now + 3600_000 }))
  return 'dsh-auth-' + b64url(createHash('sha256').update(host).digest()) + '=v1.' + p64 + '.' + createHmac('sha256', secret).update(p64).digest('base64url')
}

/** hidden 集合运算：(已hidden ∪ 当前可见) - 白名单，clamp 到上限。 */
function computeHidden(currentHidden, visibleNow, whitelist) {
  const allow = new Set(whitelist)
  const merged = new Set(currentHidden)
  for (const id of visibleNow) merged.add(id)
  const result = [...merged].filter(id => !allow.has(id))
  if (result.length > HIDDEN_CAP) {
    log(`computeHidden: ${result.length} exceeds cap ${HIDDEN_CAP}, clamping (whitelist semantics degraded this round)`)
    return result.slice(0, HIDDEN_CAP)
  }
  return result
}

/** POST /api/our-free-model/settings { hiddenModelIds } —— sanitize+落盘+emitTopology。 */
async function postHidden(ids, port) {
  const host = `127.0.0.1:${port}`
  const res = await fetch(`http://${host}/api/our-free-model/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: authCookie(host) },
    body: JSON.stringify({ hiddenModelIds: ids }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`settings POST ${res.status}: ${(await res.text()).slice(0, 120)}`)
  return res.json()
}

/** 一轮同步：可见集 → 集合运算 → 幂等写入。 */
async function syncOnce(llm, port) {
  const whitelist = readWhitelist()
  if (!Array.isArray(whitelist)) return 'whitelist absent, pass-through (no write)'

  const visibleNow = new Set()
  for (const route of ROUTES) {
    try {
      const rows = await llm.listModels(route)
      if (Array.isArray(rows)) {
        for (const row of rows) if (typeof row?.id === 'string') visibleNow.add(row.id)
        if (laneSilent.get(route)) {
          laneSilent.delete(route)
          log(`sync: ${route} lane back (${rows.length} rows visible)`)
        }
      }
    } catch (error) {
      const err = error ?? {}
      const msg = String(err.message ?? error)
      // 车道未注册 = 上游动态语义（无 region-blocked 模型时 membership 无此车道，
      // volatile-update replace 后注销），只在进入该状态时记一条，之后静默。
      if (err.code === 'NO_ADAPTER' || /no adapter registered for provider/u.test(msg)) {
        if (!laneSilent.get(route)) {
          laneSilent.set(route, true)
          log(`sync: ${route} lane not registered (dynamic lane absent) — skipping until it returns`)
        }
      } else {
        laneSilent.delete(route)
        log(`sync: listModels(${route}) failed (fail-open) ${msg}`)
      }
    }
  }

  const currentHidden = readCurrentHidden()
  const target = computeHidden(currentHidden, visibleNow, whitelist)

  const same = currentHidden.length === target.length
    && [...currentHidden].sort().join('\u0000') === [...target].sort().join('\u0000')
  if (same) return `in sync (whitelist ${whitelist.length}, hidden ${target.length}, visible ${visibleNow.size})`

  await postHidden(target, port)
  const added = target.filter(id => !currentHidden.includes(id))
  const removed = currentHidden.filter(id => !target.includes(id))
  log(`sync: hiddenModelIds updated ${currentHidden.length} -> ${target.length}` +
    (added.length ? ` (+[${added.join(',')}])` : '') +
    (removed.length ? ` (-[${removed.join(',')}])` : ''))
  return `updated (${target.length} hidden)`
}

export async function apply(ctx, config) {
  const llm = ctx?.llm
  if (!llm || typeof llm.listModels !== 'function') {
    log('apply: ctx.llm unavailable, synchronizer dormant')
    return
  }

  let syncing = false
  let rerun = false
  const run = async tag => {
    if (syncing) { rerun = true; return }
    syncing = true
    try {
      const port = readPatchConfig().port ?? 3080
      const outcome = await syncOnce(llm, port)
      log(`${tag}: ${outcome}`)
    } catch (error) {
      log(`${tag}: FAILED (fail-open) ${String(error?.message ?? error)}`)
    } finally {
      syncing = false
      if (rerun) { rerun = false; queueMicrotask(() => { void run('rerun') }) }
    }
  }

  // 1) 启动同步（OFM adapter 注册可能晚于本插件，延迟首跑 + 重试兜底）
  setTimeout(() => { void run('boot') }, 3_000).unref?.()
  setTimeout(() => { void run('boot-retry') }, 20_000).unref?.()

  // 2) 周期同步（拦截上游 catalog sync 新暴露的模型）
  const timer = setInterval(() => { void run('interval') }, SYNC_INTERVAL_MS)
  timer.unref?.()

  // 3) 白名单文件热改 → 立即重算（防抖）
  let debounce = null
  let watcher = null
  try {
    const fs = await import('node:fs')
    const whitelistPath = join(dshHomeDir(), 'our-free-model-patch', 'settings.json')
    watcher = fs.watch(whitelistPath, () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => { void run('whitelist-changed') }, DEBOUNCE_MS)
    })
  } catch (error) {
    log(`apply: whitelist watcher unavailable (interval still covers) ${String(error?.message ?? error)}`)
  }

  ctx.effect?.(() => () => {
    clearInterval(timer)
    clearTimeout(debounce)
    try { watcher?.close?.() } catch { /* already closed */ }
  }, 'ofm-patch: synchronizer lifecycle')

  log('apply: dsh-ofm-patch v2 active (whitelist->hiddenModelIds synchronizer, zero-wrap)')
}
