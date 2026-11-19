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

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
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

  /* v4 · zen 账号车道：路由 + token 自愈 + 开机重建（详见下方模块注释） */
  installZenLaneRoutes(ctx)
  startZenTokenSync()
  setTimeout(() => { void healZenLane() }, 8_000).unref?.()
}

/* ═══ v4 · zen 账号车道开关（2026-11-19 用户拍板「放补丁插件+OFM里加可见开关」）═══
 * 原理：OFM 2.8.5 的聚合渠道（aggregate）原生支持自定义 provider——借 OpenCode
 * CLI 登录账号的 OAuth access token（opencode.db credential 表）打现行端点
 * /inference/openai/v1，绕开写死 Bearer public 的匿名公共池（已被全网烧穿）。
 * 本插件代管 opencode_zen 渠道的完整生命周期：开=save+discover+白名单合并，
 * 关=remove；每 30 分钟自检 CLI 侧 token 轮换（CLI 自动续期后自动重写凭据）；
 * 开机自愈（healZenLane）：状态开着但 OFM 侧渠道被上游更新/重置冲掉时重建。
 * 上游更新冲不掉本功能：全部逻辑在补丁插件，OFM 侧只落 settings.aggregate 段。 */

const ZEN_PROVIDER = 'opencode_zen'
const ZEN_BASE_URL = 'https://opencode.ai/inference/openai/v1'
const ZEN_TOKEN_SYNC_MS = 30 * 60_000
/* 内置兜底清单（2026-11-19 models.dev opencode provider 的 -free 全集）；
   开启时先 save 这份，再 discover 上游实盘清单落盘 discovered。 */
const ZEN_FALLBACK_MODELS = [
  'tidepool-alpha-free', 'glm-5.3-flash-free', 'muse-spark-1.3-contributor-free',
  'kimi-k2.5-free', 'ling-2.6-flash-free', 'iceman-free', 'cat-jam-free',
  'deepseek-v4.1-flash-free', 'glm-4.7-free', 'trinity-large-preview-free',
  'minimax-m2.5-free', 'fledge-alpha-free', 'minimax-m3-free', 'mimo-v2-omni-free',
  'exo-free', 'mimo-v2-flash-free', 'hy3-free', 'll-alpha-free',
  'nemotron-3-super-free', 'north-mini-code-free', 'nemotron-3.5-super-vl-free',
  'hy3-preview-free', 'nemotron-3.5-lightning-free', 'qwen3.6-plus-free',
  'ling-3.0-flash-free', 'muse-spark-1.2-contributor-free', 'laguna-s-2.1-free',
  'mimo-v2.6-flash-free', 'inkling-2-small-free', 'ring-2.6-1t-free',
  'jev-1.13-free', 'space-bunny-free', 'longcat-2.5-preview-free',
  'crouton-alpha-free', 'ling-3.0-flash-fin-free', 'flint-40b-free',
  'hy4-flash-free', 'longcat-2.0-free', 'step-5-preview-free', 'mimo-v2-pro-free',
  'longcat-2.5-free', 'minimax-m3.1-flash-free', 'ling-3.1-flash-free',
  'glm-5-free', 'nemotron-3-ultra-free', 'pulse-alpha-free', 'beam-free',
  'minimax-m2.1-free', 'deepseek-v4-flash-free', 'ling-3.0-tiny-free',
  'mimo-v2.5-free', 'x-preview-f-free',
]

const zenStatePath = () => join(dshHomeDir(), 'our-free-model-patch', 'zen-lane.json')

function readZenState() {
  try {
    const parsed = JSON.parse(readFileSync(zenStatePath(), 'utf8'))
    return { enabled: false, lastTokenHash: '', lastSyncAt: 0, lastError: '', modelCount: 0, tokenExpires: 0, email: '', ...parsed }
  } catch {
    return { enabled: false, lastTokenHash: '', lastSyncAt: 0, lastError: '', modelCount: 0, tokenExpires: 0, email: '' }
  }
}

function writeZenState(state) {
  try {
    writeFileSync(zenStatePath(), JSON.stringify(state, null, 2) + '\n')
  } catch { /* 状态落盘失败不外抛，路由读内存兜底 */ }
}

/** 读 OpenCode CLI 的 opencode.ai OAuth 凭据（opencode.db credential 表，只读）。 */
async function readCliCredential() {
  const candidates = [
    process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db') : null,
    join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.local', 'share', 'opencode', 'opencode.db'),
    join(process.env.LOCALAPPDATA ?? '', 'opencode', 'opencode.db'),
  ].filter(Boolean)
  let dbPath = null
  for (const c of candidates) { try { if (existsSync(c)) { dbPath = c; break } } catch { /* next */ } }
  if (!dbPath) return { error: 'opencode.db not found (run: opencode auth login)' }
  let DatabaseSync
  try { ({ DatabaseSync } = await import('node:sqlite')) } catch (e) { return { error: `node:sqlite unavailable: ${String(e?.message ?? e)}` } }
  let db
  try { db = new DatabaseSync(dbPath, { readOnly: true }) } catch (e) { return { error: `db open failed: ${String(e?.message ?? e)}` } }
  try {
    const rows = db.prepare("SELECT value FROM credential WHERE integration_id='opencode'").all()
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value)
        if (parsed?.access && (!parsed.expires || parsed.expires > Date.now())) {
          return { token: parsed.access, expires: parsed.expires ?? 0, email: parsed.metadata?.email ?? '' }
        }
      } catch { /* skip malformed row */ }
    }
    return { error: 'no active opencode credential (run: opencode auth login)' }
  } finally { try { db.close() } catch { /* already closed */ }
  }
}

/** 调 OFM 自身 API（自签 dsh-auth cookie，与白名单同步器同一信任域）。 */
async function ofmApi(method, path, body) {
  const port = readPatchConfig().port ?? 3080
  const host = `127.0.0.1:${port}`
  const res = await fetch(`http://${host}/api/our-free-model${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: authCookie(host) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON body */ }
  return { ok: res.ok, status: res.status, json, text: text.slice(0, 300) }
}

/** 开启时把 opencode_zen/<id> 复合 id 合入白名单（防白名单同步器误藏渠道模型）。 */
function mergeZenWhitelist(upstreamIds) {
  try {
    const wlPath = join(dshHomeDir(), 'our-free-model-patch', 'settings.json')
    let parsed = {}
    try { parsed = JSON.parse(readFileSync(wlPath, 'utf8')) } catch { /* fresh file */ }
    const existing = Array.isArray(parsed.visibleModels) ? parsed.visibleModels : []
    const composite = (upstreamIds.length ? upstreamIds : ZEN_FALLBACK_MODELS).map(id => `${ZEN_PROVIDER}/${id}`)
    const merged = [...new Set([...existing, ...composite])]
    if (merged.length === existing.length) return
    writeFileSync(wlPath, JSON.stringify({ ...parsed, visibleModels: merged }, null, 2) + '\n')
    log(`zen-lane: whitelist ${existing.length} -> ${merged.length}`)
  } catch (e) { log(`zen-lane: whitelist merge failed (non-fatal) ${String(e?.message ?? e)}`) }
}

/** 开关主流程：true=save+discover+白名单；false=remove。全程状态落盘。 */
async function applyZenLane(enabled) {
  const state = readZenState()
  state.enabled = enabled === true
  state.lastError = ''
  try {
    if (!state.enabled) {
      const rm = await ofmApi('POST', '/providers/remove', { providerId: ZEN_PROVIDER })
      if (!rm.ok && rm.status !== 404) throw new Error(`remove ${rm.status}: ${rm.text}`)
      state.lastSyncAt = Date.now()
      writeZenState(state)
      log('zen-lane: disabled (opencode_zen removed from aggregate)')
      return state
    }
    const cred = await readCliCredential()
    if (cred.error) throw new Error(cred.error)
    const save = await ofmApi('POST', '/providers', {
      providerId: ZEN_PROVIDER, enabled: true, apiKey: cred.token,
      baseUrl: ZEN_BASE_URL, models: ZEN_FALLBACK_MODELS,
    })
    if (!save.ok) throw new Error(`save ${save.status}: ${save.text}`)
    let discovered = 0
    try {
      const disc = await ofmApi('POST', '/providers/discover', { providerId: ZEN_PROVIDER })
      if (disc.ok && Array.isArray(disc.json?.models)) {
        discovered = disc.json.models.length
        mergeZenWhitelist(disc.json.models)
      }
    } catch { /* discover 失败不阻断（save 已带内置清单） */ }
    state.lastTokenHash = createHash('sha256').update(cred.token).digest('hex').slice(0, 16)
    state.tokenExpires = cred.expires ?? 0
    state.email = cred.email ?? ''
    state.modelCount = discovered || ZEN_FALLBACK_MODELS.length
    state.lastSyncAt = Date.now()
    writeZenState(state)
    log(`zen-lane: enabled (token …${cred.token.slice(-4)}, models ${state.modelCount}, expires ${new Date(state.tokenExpires).toISOString()})`)
    return state
  } catch (error) {
    state.lastError = String(error?.message ?? error)
    writeZenState(state)
    log(`zen-lane: FAILED ${state.lastError}`)
    return state
  }
}

/** token 自愈循环：CLI 自动续期后（db 里 token 变化）自动重写渠道凭据。 */
async function syncZenToken() {
  const state = readZenState()
  if (state.enabled !== true) return
  try {
    const cred = await readCliCredential()
    if (cred.error) throw new Error(cred.error)
    const hash = createHash('sha256').update(cred.token).digest('hex').slice(0, 16)
    if (hash === state.lastTokenHash) return
    const save = await ofmApi('POST', '/providers', { providerId: ZEN_PROVIDER, enabled: true, apiKey: cred.token })
    if (!save.ok) throw new Error(`save ${save.status}: ${save.text}`)
    state.lastTokenHash = hash
    state.tokenExpires = cred.expires ?? state.tokenExpires
    state.email = cred.email ?? state.email
    state.lastSyncAt = Date.now()
    state.lastError = ''
    writeZenState(state)
    log('zen-lane: token rotated (CLI renewed) → aggregate credential updated')
  } catch (error) {
    const cur = readZenState()
    cur.lastError = `token-sync: ${String(error?.message ?? error)}`
    writeZenState(cur)
    log(`zen-lane: token sync FAILED ${cur.lastError}`)
  }
}

function startZenTokenSync() {
  const timer = setInterval(() => { void syncZenToken() }, ZEN_TOKEN_SYNC_MS)
  timer.unref?.()
}

/** 开机自愈：状态开着但 OFM 侧渠道丢失（上游更新/设置页重置）→ 重建。 */
async function healZenLane() {
  const state = readZenState()
  if (state.enabled !== true) return
  try {
    const r = await ofmApi('GET', `/providers?id=${ZEN_PROVIDER}`)
    const live = r.json?.configured
    if (live?.enabled === true && (live.apiKey || live.token)) return
    log('zen-lane: heal — state on but aggregate lane missing, rebuilding')
    await applyZenLane(true)
  } catch (e) { log(`zen-lane: heal check failed (non-fatal) ${String(e?.message ?? e)}`) }
}

/** 开关操作校验：dsh-auth cookie 验签（与宿主同机信任域，防跨源误触）。 */
function verifyZenAuth(req) {
  try {
    const port = readPatchConfig().port ?? 3080
    const authority = `127.0.0.1:${port}`
    const raw = String(req.headers?.cookie ?? '')
    const name = 'dsh-auth-' + Buffer.from(createHash('sha256').update(authority).digest()).toString('base64url')
    const pair = raw.split(/;\s*/u).find(c => c.startsWith(`${name}=v1.`))
    if (!pair) return false
    const [p64, sig] = pair.slice(name.length + 4).split('.')
    const secret = Buffer.from(readFileSync(join(dshHomeDir(), '.credentials.yaml'), 'utf8').match(/secret:\s*(\S+)/)[1], 'base64url')
    if (createHmac('sha256', secret).update(p64).digest('base64url') !== sig) return false
    const payload = JSON.parse(Buffer.from(p64, 'base64url').toString('utf8'))
    return payload?.authority === authority && Number(payload?.expiresAt) > Date.now()
  } catch { return false }
}

/** 路由：GET 状态 / POST {enabled}。挂在宿主 webServer（同 adapter-compat 模式）。 */
function installZenLaneRoutes(ctx) {
  try {
    const web = ctx?.get?.('webServer') ?? ctx?.webServer
    if (!web || typeof web.register !== 'function') {
      log('zen-lane: webServer unavailable (routes dormant until reload)')
      return
    }
    const reply = (res, status, obj) => {
      try { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-transform' }); res.end(JSON.stringify(obj)) } catch { /* ignore */ }
    }
    web.register({
      kind: 'exact',
      path: '/api/our-free-model-patch/zen-lane',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const state = readZenState()
          let live = null
          try {
            const r = await ofmApi('GET', `/providers?id=${ZEN_PROVIDER}`)
            live = r.json?.configured
              ? { enabled: r.json.configured.enabled === true, hasKey: Boolean(r.json.configured.apiKey), models: r.json.configured.models?.length ?? 0, discovered: r.json.configured.discovered?.length ?? 0, lastTest: r.json.configured.lastTest ?? null }
              : null
          } catch { /* OFM 未起/端口变化：live 留空 */ }
          return reply(res, 200, { ok: true, state, live })
        }
        if (req.method === 'POST') {
          if (!verifyZenAuth(req)) return reply(res, 401, { ok: false, error: 'bad dsh-auth cookie' })
          let body = ''
          try { for await (const chunk of req) { body += chunk; if (body.length > 16384) throw new Error('body too large') } } catch { /* clamp */ }
          let parsed = {}
          try { parsed = JSON.parse(body || '{}') } catch { /* empty body */ }
          const state = await applyZenLane(parsed.enabled === true)
          return reply(res, 200, { ok: !state.lastError, state })
        }
        return reply(res, 405, { ok: false, error: 'method-not-allowed' })
      },
    })
    log('zen-lane: routes registered (/api/our-free-model-patch/zen-lane)')
  } catch (e) { log(`zen-lane: route install FAILED ${String(e?.message ?? e)}`) }
}
