/**
 * zen-gateway —— OFM 补丁插件的 OpenAI 兼容网关（v5，2026-11-21）。
 *
 * # 为什么存在（本体 2.8.9 换装后免费车道唯一活路）
 *
 * 上游 2.8.9 的 zen 免费车道走匿名公共池（裸 API / 任何 key 一律 429「Free
 * usage limit reached」，11-19/11-20 两轮实测：Bearer public、CLI 的 st_ key
 * 全部撞墙——上游按真 CLI 会话流量记账，API 调用不算数）。唯一活路 = fork 时
 * 代的本地 opencode 桥接（真 CLI 流量，走用户已登录的 Personal 账号，PowerShell
 * 实测可用）。用户铁律：**本体一行不许动，桥接/探针全放补丁插件**。
 *
 * # 接法（零本体改动的关键）
 *
 * OFM 聚合渠道（aggregate）原生支持自定义 OpenAI 兼容 provider：把
 * opencode_zen 渠道的 baseUrl 指到本网关（http://127.0.0.1:<port>/v1），
 * 聚合车道发来的标准 OpenAI 请求在这里翻译成桥接调用（renderBridgePrompt →
 * bridgeStream），响应再翻译回 OpenAI SSE chunk。[调用工具 名字：{json}]
 * 文本协议 ↔ OpenAI tool_calls 双向转换（移植自 fork adapter.js，2026-10-15
 * 起多轮实测的协议）。picker 里还是 opencode_zen/<模型> 那些行，流量改走本机
 * opencode 真 CLI——本体代码零改动。
 *
 * # 硬约束
 *
 * - 只绑 127.0.0.1（环回信任域，与 DSH 自身同级别暴露面）。
 * - 只放行 -free 后缀模型（assertFreeModel 同源闸，防付费档误入产生账单）。
 * - 任何失败只记日志/返回错误响应，绝不外抛连累 DSH 主进程（fail-loud 防雷：
 *   所有监听器都接住 error 事件）。
 *
 * @module src/zen-gateway.js
 */

import http from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { bridgeStream, createSession, deleteBridgeSession, readBridgeJson } from './opencode-bridge.js'

export const ZEN_SESSION_BINDINGS_PATH = join(dshHomeDir(), 'our-free-model-patch', 'zen-session-bindings.json')
const zenBindings = new Map()
const zenQueues = new Map()
let zenBindingsLoaded = false

/* ── 内置兜底模型清单（settings.json 读不到时用；全部 -free） ── */
const FALLBACK_MODELS = [
  'mimo-v2.6-flash-free', 'deepseek-v4.1-flash-free', 'longcat-2.5-free',
  'iceman-free', 'beam-free', 'flint-40b-free', 'nemotron-3.5-super-vl-free',
  'nemotron-3.5-lightning-free', 'jev-1.13-free', 'hy4-flash-free',
  'tidepool-alpha-free',
]

const FREE_MODEL_RE = /-free$/i
const TOOL_MARK = '[调用工具'

/* ── 工具协议（移植自 fork src/adapter.js，2026-10-15 → 2026-11-08 历代定案） ── */

function renderToolCatalog(tools) {
  /* OpenAI wire 形状 {type:'function', function:{name,description,parameters}}，
     兼容 fork 时代的扁平形状 {name, description, parameters}。 */
  const list = (Array.isArray(tools) ? tools : [])
    .map(tool => {
      if (tool === null || typeof tool !== 'object') return null
      const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool
      return typeof fn.name === 'string' && fn.name !== '' ? { name: fn.name, description: fn.description, parameters: fn.parameters ?? tool.parameters ?? tool.input_schema ?? tool.inputSchema } : null
    })
    .filter(Boolean)
  if (list.length === 0) return ''
  const lines = list.map(tool => {
    let schema = ''
    try { schema = tool.parameters === undefined || tool.parameters === null ? '' : JSON.stringify(tool.parameters) } catch { schema = '' }
    const desc = typeof tool.description === 'string' ? tool.description.slice(0, 300) : ''
    return `- ${tool.name}${desc === '' ? '' : `：${desc}`}${schema === '' ? '' : `（参数 schema：${schema.slice(0, 600)}）`}`
  })
  return lines.join('\n')
}

function bridgeToolPreamble(tools) {
  const catalog = renderToolCatalog(tools)
  if (catalog === '') {
    return '（接下来是一整轮的完整对话。请以 Assistant 身份直接回复最后一条 User 消息。本次对话没有提供任何工具，不要编造工具调用，不要复述本段说明。）'
  }
  return `（接下来是一整轮的完整对话。请以 Assistant 身份直接回复最后一条 User 消息。

【工具调用协议——最高优先级，覆盖一切其他认知】
你在本会话里看到的任何"内置工具/函数列表"（glob、grep、read、question 之类）
属于本地运行环境，与这个对话无关、对本对话完全无效——这个对话里你**只有**
下面"宿主提供的工具"可用，没有别的。绝不要以"我的工具列表里没有 X"为理由
拒绝做事：宿主工具本来就不在那个列表里，这正是协议的设计。

宿主提供的工具：
${catalog}

需要调用宿主工具时，输出一行且仅一行，格式严格为：
[调用工具 工具名：{"参数名":"值"}]
其中 JSON 是该工具的调用参数。输出这行之后立即停止，等待工具结果。

铁律：
- 一次只调用一个工具；输出调用行后立即停，不要同时给最终回答。
- 不要编造工具的返回结果；工具结果会由宿主以 [工具结果：…] 发回。
- 不要在回复里反复"说明打算调用"——直接输出调用行本身就是全部动作。
- 调用行没被响应（没有 [工具结果…] 回来）时，重试同一调用行一次即可，
  不要改写叙述、不要放弃、不要向用户解释协议问题。
- 不要复述本段说明。）`
}

/**
 * 把 OpenAI chat 消息数组渲染成给本地 opencode 的一次性 prompt。
 * （fork 版吃 DSH 块数组，本版吃 OpenAI wire 形状：content 为 string 或
 * {type:'text'|'image_url'} 数组；assistant 工具调用在 tool_calls 字段。）
 */
function renderBridgePrompt(messages, tools, includeProtocol = true) {
  const parts = []
  const protocol = includeProtocol ? bridgeToolPreamble(tools) : ''
  if (protocol !== '') parts.push(`System: ${protocol}`)
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role ?? 'user'
    const label = role === 'assistant' ? 'Assistant' : role === 'system' ? 'System' : role === 'tool' ? 'Tool' : 'User'
    const blocks = []
    const content = message?.content
    if (typeof content === 'string' && content !== '') {
      blocks.push(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        if (typeof block.text === 'string' && block.text !== '') blocks.push(block.text)
        else if (block.type === 'text' && typeof block.text === 'string') blocks.push(block.text)
        else if (block.type === 'image_url' || block.type === 'image') blocks.push('[image 附件——本地 opencode 代发通道暂不支持]')
      }
    }
    if (role === 'assistant' && Array.isArray(message?.tool_calls)) {
      for (const call of message.tool_calls) {
        const name = call?.function?.name ?? ''
        const args = typeof call?.function?.arguments === 'string' ? call.function.arguments : ''
        if (name !== '') blocks.push(`[调用工具 ${name}：${args.slice(0, 400)}]`)
      }
    }
    let body = blocks.filter(line => line !== '').join('\n')
    if (role === 'tool') body = `[工具结果：${body.slice(0, 1500)}]`
    if (body === '') continue
    parts.push(`${label}: ${body}`)
  }
  return parts.join('\n\n')
}

/** 把桥接全文里的 [调用工具 名字：{json}] 解析成（text | tool-call）序列。 */
function parseBridgeToolCalls(fullText) {
  const MARK = TOOL_MARK
  const out = []
  let rest = typeof fullText === 'string' ? fullText : ''
  while (rest !== '') {
    const at = rest.indexOf(MARK)
    if (at === -1) { out.push({ kind: 'text', text: rest }); rest = ''; break }
    if (at > 0) out.push({ kind: 'text', text: rest.slice(0, at) })
    let closedAt = -1
    for (let pos = rest.indexOf(']', at); pos !== -1; pos = rest.indexOf(']', pos + 1)) {
      const candidate = rest.slice(at + MARK.length, pos).trim()
      const sepAt = candidate.indexOf('：')
      const argsRaw = sepAt === -1 ? '' : candidate.slice(sepAt + 1).trim()
      try { JSON.parse(argsRaw === '' ? '{}' : argsRaw) } catch { continue }
      closedAt = pos
      break
    }
    if (closedAt === -1) {
      out.push({ kind: 'text', text: rest.slice(at) })
      rest = ''
      break
    }
    const body = rest.slice(at + MARK.length, closedAt).trim()
    rest = rest.slice(closedAt + 1)
    const sep = body.indexOf('：')
    const name = sep === -1 ? body.trim() : body.slice(0, sep).trim()
    const argsRaw = sep === -1 ? '' : body.slice(sep + 1).trim()
    let args = '{}'
    try { args = JSON.stringify(JSON.parse(argsRaw === '' ? '{}' : argsRaw)) } catch { args = null }
    if (name === '' || args === null) out.push({ kind: 'text', text: `${MARK}${body}]` })
    else out.push({ kind: 'tool-call', name, arguments: args })
  }
  return out
}

/* ── 流式安全阀：标记起（含被 delta 切开的标记前缀）扣住不实时吐，
      闭合的标记整段扣下（结束后转 tool_calls），其余照常实时吐。
      （语义同 fork adapter.js emitLive/tryCloseMark，2026-10-22 定案版。） ── */

function markerSafeSplit(buf) {
  const at = buf.indexOf(TOOL_MARK)
  if (at === -1) {
    let keep = Math.min(TOOL_MARK.length - 1, buf.length)
    while (keep > 0 && !buf.endsWith(TOOL_MARK.slice(0, keep))) keep--
    return { safe: buf.slice(0, buf.length - keep), hold: buf.slice(buf.length - keep) }
  }
  return { safe: buf.slice(0, at), hold: buf.slice(at) }
}

function tryCloseMark(buf) {
  const at = buf.indexOf(TOOL_MARK)
  if (at === -1) return { closed: false, tail: buf }
  for (let pos = buf.indexOf(']', at); pos !== -1; pos = buf.indexOf(']', pos + 1)) {
    const candidate = buf.slice(at + TOOL_MARK.length, pos).trim()
    const sepAt = candidate.indexOf('：')
    const argsRaw = sepAt === -1 ? '' : candidate.slice(sepAt + 1).trim()
    if (sepAt !== -1 && candidate.slice(0, sepAt).trim() !== '') {
      try { JSON.parse(argsRaw === '' ? '{}' : argsRaw); return { closed: true, tail: buf.slice(pos + 1) } } catch { /* 找下一个 ] */ }
    }
  }
  return { closed: false, tail: buf }
}

/* ── 模型清单：优先读 OFM settings 的 opencode_zen 渠道 models（只读） ── */

function dshHomeDir() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const home = process.env.USERPROFILE ?? process.env.HOME
  return home ? `${String(home).replace(/[\\/]+$/u, '')}/.dsh` : '.dsh'
}

/* ── 动态模型清单：从本机 opencode 服务 /api/model 拉取（自动识别 -free，带 context/output） ──
 * 上游切换模型时自动跟随，无需改代码。缓存 5 分钟，失败时回退到上次成功清单或内置兜底。 */
let _modelCache = { at: 0, models: null, meta: null }
const MODEL_CACHE_MS = 5 * 60_000

function readOpencodeService() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const candidates = [
    process.env.OPENCODE_SERVER_URL ? { url: process.env.OPENCODE_SERVER_URL, password: process.env.OPENCODE_SERVER_PASSWORD ?? '' } : null,
    join(home, '.local', 'state', 'opencode', 'service.json'),
    join(home, '.config', 'opencode', 'service.json'),
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      if (typeof p === 'object') return p
      const j = JSON.parse(readFileSync(p, 'utf8'))
      if (typeof j?.url === 'string' && j.url.length > 0) return { url: j.url.replace(/\/+$/, ''), password: String(j?.password ?? '') }
      if (typeof j?.password === 'string' && j.password.length > 0) return { url: 'http://127.0.0.1:4096', password: j.password }
    } catch { /* 换下一个 */ }
  }
  return null
}

async function fetchOpencodeModels() {
  const svc = readOpencodeService()
  if (!svc) return null
  try {
    const auth = 'Basic ' + Buffer.from(`opencode:${svc.password}`).toString('base64')
    const res = await fetch(`${svc.url}/api/model`, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const doc = await res.json()
    const rows = Array.isArray(doc?.data) ? doc.data : []
    return rows.filter(m => m && typeof m.id === 'string' && FREE_MODEL_RE.test(m.id) && m.status !== 'disabled')
  } catch { return null }
}

function laneModels() {
  /* 同步返回当前缓存（首次为空时返回内置兜底），异步刷新在后台进行。
     调用方（/models 端点）每次拿到的是最近一次的实盘清单。 */
  if (_modelCache.models && Date.now() - _modelCache.at < MODEL_CACHE_MS) return _modelCache.models
  if (_modelCache.models) return _modelCache.models
  return FALLBACK_MODELS
}

/** 异步刷新模型清单（/models 端点 await 调用；其他路径可用 laneModels() 读缓存）。 */
async function refreshLaneModels() {
  const rows = await fetchOpencodeModels()
  if (rows && rows.length > 0) {
    _modelCache = {
      at: Date.now(),
      models: rows.map(m => m.id),
      meta: Object.fromEntries(rows.map(m => [m.id, {
        name: m.name ?? m.id,
        context: Number(m?.limit?.context) || null,
        output: Number(m?.limit?.output) || null,
        vision: Array.isArray(m?.capabilities?.input) && m.capabilities.input.includes('image'),
      }])),
    }
  }
  return _modelCache.models ?? FALLBACK_MODELS
}

/** 模型元数据（context/output/vision），供 OFM 设置页或白名单参考。 */
function modelMeta(modelId) {
  return _modelCache.meta?.[modelId] ?? null
}

function stripProviderPrefix(modelId) {
  const id = String(modelId ?? '').trim()
  return id.startsWith('opencode_zen/') ? id.slice('opencode_zen/'.length) : id
}

/* ── DSH 会话绑定：首轮全量、后续只发增量；编辑/删除重建本地 ses_ ── */

/* 2026-11-24 指纹改 sha256 摘要：旧版直接存完整消息 JSON，单条绑定能撑到 ~1.18MB
   （绑定文件被对话正文灌爆）；「历史没变过」的判定只需要等价比较，64 字符哈希足够。 */
function messageFingerprint(message) {
  let raw
  try { raw = JSON.stringify(message ?? null) } catch { raw = String(message) }
  return createHash('sha256').update(raw).digest('hex')
}

function messagesFingerprint(messages) {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex')
}

function loadZenBindings() {
  if (zenBindingsLoaded) return
  zenBindingsLoaded = true
  try {
    const data = JSON.parse(readFileSync(ZEN_SESSION_BINDINGS_PATH, 'utf8'))
    for (const [key, row] of Object.entries(data?.sessions ?? {})) {
      if (row && typeof row.sessionId === 'string' && row.sessionId.startsWith('ses_')) zenBindings.set(key, row)
    }
  } catch { /* 首次使用/旧版没有绑定文件 */ }
}

function saveZenBindings() {
  const tmp = `${ZEN_SESSION_BINDINGS_PATH}.tmp`
  mkdirSync(join(ZEN_SESSION_BINDINGS_PATH, '..'), { recursive: true })
  writeFileSync(tmp, JSON.stringify({ version: 1, sessions: Object.fromEntries(zenBindings) }))
  renameSync(tmp, ZEN_SESSION_BINDINGS_PATH)
}

function sessionKey(req, body, modelId) {
  const dshId = String(req?.headers?.['x-session-id'] ?? req?.headers?.['x-session-affinity'] ?? '').trim()
  // OFM 原生把 DSH sessionId 放进 x-session-id；缺失时不能伪造跨会话复用。
  return `${dshId || `anonymous:${messagesFingerprint(body?.messages ?? [])}`}\0${modelId}`
}

export async function prepareZenTurn(req, body, modelId, log = () => {}, deps = {}) {
  loadZenBindings()
  const key = sessionKey(req, body, modelId)
  const previous = zenQueues.get(key) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(() => prepareZenTurnUnsafe(key, req, body, modelId, log, deps))
  zenQueues.set(key, run)
  try { return await run } finally { if (zenQueues.get(key) === run) zenQueues.delete(key) }
}

async function prepareZenTurnUnsafe(key, req, body, modelId, log, deps) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const old = zenBindings.get(key)
  const usable = old && messages.length >= old.cursor && old.cursor > 0 &&
    old.fingerprints.every((fp, i) => fp === messageFingerprint(messages[i]))
  const reuse = Boolean(usable)
  const delta = reuse ? messages.slice(old.cursor) : messages
  /* 首轮已把 system/工具目录放进本地会话；续发只送增量，不能把协议再复制一遍。
     OpenCode 自己保存完整历史，重复注入只会浪费缓存和上下文。 */
  const prompt = renderBridgePrompt(delta, undefined, false)
  const basePrompt = renderBridgePrompt(messages, body?.tools)
  let sessionId = old?.sessionId ?? null
  let verified = false
  if (reuse) {
    const probe = await (deps.probeSession ?? readBridgeJson)(`/api/session/${encodeURIComponent(sessionId)}`)
    if (probe.status >= 200 && probe.status < 300) verified = true
  }
  if (!verified) {
    /* 2026-11-24 同一 DSH id 换新 ses_ 时，旧 opencode 会话就地清掉（用户定案：
       重建即自清）。OpenCode 侧从不自动回收会话，不清就会永久积压；删除走
       autostart:false 链路绝不拉起服务，失败也不拦重建（旧会话留着等 zen-cleanup）。 */
    if (old?.sessionId) {
      const removed = await (deps.deleteSession ?? deleteBridgeSession)(old.sessionId).catch(error => ({ status: 0, ok: false, error: String(error?.message ?? error) }))
      log(`session: cleaned superseded opencode=${old.sessionId} status=${removed?.status ?? 'n/a'}`)
    }
    if (deps.newSession) sessionId = await deps.newSession(modelId)
    else {
      const { ensureService } = await import('./opencode-bridge.js')
      const svc = await ensureService({ autostart: true })
      if (svc === null) throw new Error('本机 opencode 服务不可用')
      sessionId = (await createSession(svc, modelId, dshHomeDir())).id
    }
  }
  const effectiveReuse = reuse && verified
  const turn = { key, modelId, sessionId, prompt: effectiveReuse ? prompt : basePrompt, reuse: effectiveReuse, messages, basePrompt, oldCursor: old?.cursor ?? 0 }
  log(`session: key=${key.split('\0')[0]} opencode=${sessionId} mode=${effectiveReuse ? 'incremental' : 'new'} messages=${effectiveReuse ? delta.length : messages.length}/${messages.length} chars=${turn.prompt.length}`)
  return turn
}

export function commitZenTurn(turn, body, finalText, outcome, log = () => {}) {
  if (!outcome?.ok) return
  const nextMessages = [...turn.messages, { role: 'assistant', content: finalText }]
  zenBindings.set(turn.key, {
    sessionId: turn.sessionId,
    cursor: nextMessages.length,
    fingerprints: nextMessages.map(messageFingerprint),
    model: turn.modelId,
    updatedAt: Date.now(),
  })
  saveZenBindings()
  log(`session: committed opencode=${turn.sessionId} cursor=${nextMessages.length}`)
}

export function zenSessionDebug() {
  loadZenBindings()
  return [...zenBindings.entries()].map(([key, row]) => ({ key: key.split('\0')[0], model: row.model, sessionId: row.sessionId, cursor: row.cursor, updatedAt: row.updatedAt }))
}

/* ── OpenAI 响应小件 ── */

let chunkCounter = 0
function completionId() {
  chunkCounter = (chunkCounter + 1) % 0xffff
  return `chatcmpl-ofmp-${Date.now().toString(36)}-${chunkCounter.toString(36)}`
}

function sseWrite(res, obj) {
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch { /* 客户端已断 */ }
}

function errorPayload(message, code) {
  return { error: { message: String(message ?? 'zen gateway error'), type: 'zen_bridge_error', code: code ?? 'bridge_error' } }
}

/* ── 单轮处理：OpenAI 请求 → 桥接 → OpenAI 响应 ── */

async function handleChat(req, res, body, log) {
  const requested = body?.model
  const modelId = stripProviderPrefix(requested)
  if (!FREE_MODEL_RE.test(modelId)) {
    const payload = errorPayload(`本地 opencode 代发通道只服务免费档模型（id 需以 -free 结尾），拒绝：${String(requested)}`, 'not_free_model')
    if (!res.headersSent) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
    return
  }
  const turn = await prepareZenTurn(req, body, modelId, log)
  const prompt = turn.prompt
  const ac = new AbortController()
  /* 2026-11-21 修「首测零内容」：Node 现代版 req 'close' 在请求体读完即触发
     （不是客户端断开），挂它 = 桥接开局即被 abort（实测 ok=false aborted、
     bytes=0）。客户端真断开的判定挂 res：连接关闭且响应未正常收尾才 abort。 */
  res.on('close', () => { if (!res.writableEnded) { try { ac.abort() } catch { /* 已断 */ } } })
  const wantsStream = body?.stream === true
  const id = completionId()
  const created = Math.floor(Date.now() / 1000)
  const modelOut = String(requested ?? modelId)

  /* 流式：先发 role 帧，再实时吐 content（标记安全阀），结束后 tool_calls + finish。 */
  if (wantsStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    sseWrite(res, { id, object: 'chat.completion.chunk', created, model: modelOut, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
  }

  let textBuf = ''   /* 未吐出的 hold 缓冲（标记起点起） */
  let full = ''      /* 全文累积（结束后解析 tool_calls 用） */
  let usage = null
  let firstFrameSent = false

  const emitText = delta => {
    if (typeof delta !== 'string' || delta === '') return
    if (wantsStream) sseWrite(res, { id, object: 'chat.completion.chunk', created, model: modelOut, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })
    firstFrameSent = true
  }

  const outcome = await new Promise(resolve => {
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    const run = bridgeStream({
      modelId,
      prompt,
      sessionId: turn.sessionId,
      signal: ac.signal,
      onDelta: delta => {
        if (typeof delta !== 'string' || delta === '') return
        full += delta
        textBuf += delta
        for (;;) {
          const { closed, tail } = tryCloseMark(textBuf)
          if (closed) { textBuf = tail; continue }
          const { safe, hold } = markerSafeSplit(textBuf)
          textBuf = hold
          if (safe !== '') emitText(safe)
          break
        }
      },
      onReasoning: delta => {
        if (typeof delta !== 'string' || delta === '' || !wantsStream) return
        sseWrite(res, { id, object: 'chat.completion.chunk', created, model: modelOut, choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }] })
      },
      onUsage: tokens => { if (tokens && typeof tokens === 'object') usage = tokens },
    })
    run.then(text => done({ ok: true, text: typeof text === 'string' ? text : full }), error => done({ ok: false, error }))
  })

  /* 收尾：吐 hold 尾巴（未闭合标记按正文处理——宁可见、不丢），解析 tool_calls。 */
  const finalText = typeof outcome.text === 'string' ? outcome.text : full
  if (textBuf !== '') { emitText(textBuf); textBuf = '' }
  const pieces = outcome.ok ? parseBridgeToolCalls(finalText) : []
  const toolCalls = pieces.filter(p => p.kind === 'tool-call')
  const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop'
  commitZenTurn(turn, body, finalText, outcome, log)
  const inputTokens = Number(usage?.input) || 0
  const cacheReadTokens = Number(usage?.cache?.read ?? usage?.cache_read ?? usage?.cacheRead ?? usage?.cacheReadInputTokens) || 0
  const usageBlock = usage
    ? {
      prompt_tokens: inputTokens + cacheReadTokens,
      completion_tokens: (Number(usage.output) || 0) + (Number(usage.reasoning) || 0),
      total_tokens: inputTokens + cacheReadTokens + (Number(usage.output) || 0) + (Number(usage.reasoning) || 0),
      prompt_tokens_details: { cached_tokens: cacheReadTokens },
      opencode_session_id: turn.sessionId,
      dsh_session_mode: turn.reuse ? 'incremental' : 'new',
    }
    : undefined

  if (wantsStream) {
    if (!outcome.ok) {
      /* 流里补错误帧：调用方（DSH 聚合车道）能拿到失败原因，不留黑洞。 */
      sseWrite(res, { error: errorPayload(outcome.error) })
    }
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]
      sseWrite(res, {
        id, object: 'chat.completion.chunk', created, model: modelOut,
        choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${id}-${i}`, type: 'function', function: { name: call.name, arguments: call.arguments } }] }, finish_reason: null }],
      })
    }
    sseWrite(res, { id, object: 'chat.completion.chunk', created, model: modelOut, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], ...(usageBlock ? { usage: usageBlock } : {}) })
    try { res.write('data: [DONE]\n\n') } catch { /* 客户端已断 */ }
    try { res.end() } catch { /* 已断 */ }
  } else {
    const contentText = pieces.filter(p => p.kind === 'text').map(p => p.text).join('')
    const message = { role: 'assistant', content: contentText }
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls.map((call, i) => ({ id: `call_${id}-${i}`, type: 'function', function: { name: call.name, arguments: call.arguments } }))
    }
    if (!res.headersSent) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id, object: 'chat.completion', created, model: modelOut, choices: [{ index: 0, message, finish_reason: finishReason }], ...(usageBlock ? { usage: usageBlock } : {}) }))
    }
  }
  log(`chat: model=${modelId} ok=${outcome.ok}${outcome.ok ? '' : ` err=${String(outcome.error?.message ?? outcome.error).slice(0, 160)}`} bytes=${finalText.length} toolCalls=${toolCalls.length}`)
}

/* ── 清理：本插件创建的桥接会话（agent 名单过滤；OpenCode 侧无自动清理，这里补位） ──
 * 2026-11-24 实测 GET /api/session 行形状：{id, projectID, agent, model, cost, tokens,
 * outcome, time, location}——agent 恒为字符串（"mute2"/"build"），无顶层 directory
 * （在 location.directory），按 agent 名单过滤即可精确圈定本插件的会话。 */
export const BRIDGE_AGENT_NAMES = ['mute2', 'mute3', 'pipe3', 'mute', 'pipe']
export function isBridgeSessionRow(row) {
  const agent = typeof row?.agent === 'string' ? row.agent : row?.agent?.name
  if (typeof agent === 'string' && BRIDGE_AGENT_NAMES.includes(agent)) return true
  return false
}
async function cleanupBridgeSessions({ dryRun = false, log = () => {} } = {}) {
  const listed = await readBridgeJson('/api/session', { timeoutMs: 15000 })
  if (listed.status !== 200) return { ok: false, reason: `opencode service not reachable (status ${listed.status})` }
  const rows = (Array.isArray(listed.data) ? listed.data : listed.data?.data) ?? []
  const targets = rows.filter(isBridgeSessionRow)
  log(`cleanup: matched ${targets.length}/${rows.length} bridge sessions (dryRun=${dryRun})`)
  if (dryRun || targets.length === 0) return { ok: true, dryRun, matched: targets.length, total: rows.length, deleted: 0, failed: 0 }
  let deleted = 0; const failed = []
  const queue = [...targets]
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (;;) {
      const row = queue.shift()
      if (!row) return
      const r = await deleteBridgeSession(row.id).catch(() => ({ ok: false }))
      if (r?.ok) deleted += 1
      else { failed.push({ id: row.id, status: r?.status }); if (failed.length > 20) queue.length = 0 }
    }
  }))
  return { ok: failed.length === 0, dryRun, matched: targets.length, total: rows.length, deleted, failed: failed.slice(0, 20) }
}

/* ── DSH webServer 路由处理器（2026-11-22：DSH 插件沙箱阻止 listen，改挂宿主 webServer） ──
 *
 * 不再 createServer/listen，改为导出 handler 由 index.js 注册到 webServer prefix 路由。
 * OFM 聚合车道 baseUrl = http://127.0.0.1:3080/api/ofm-patch/zen-gateway
 * OFM 会 POST 到 {baseUrl}/chat/completions，宿主 webServer 前缀匹配后调本 handler。
 * req.url 是完整路径（含前缀），这里提取子路径做路由。
 */
export function createZenGatewayHandler({ log = () => {} } = {}) {
  return (req, res) => {
    let body = ''
    let oversized = false
    req.on('data', chunk => {
      body += chunk
      if (body.length > 33_554_432) { oversized = true; try { req.destroy() } catch { /* 已断 */ } }
    })
    req.on('error', () => { /* 客户端断开，无追责 */ })
    req.on('end', () => {
      try {
        /* req.url 可能是完整路径（/api/ofm-patch/zen-gateway/chat/completions）
           或子路径（/chat/completions），取决于 DSH webServer 的转发方式。
           统一提取最后一个 / 后的段做路由。 */
        const fullUrl = (req.url ?? '').split('?')[0]
        const subPath = fullUrl.replace(/^\/api\/ofm-patch\/zen-gateway/, '') || '/'
        if (req.method === 'GET' && (subPath === '/v1/models' || subPath === '/models')) {
          /* 动态拉取本机 opencode 实盘清单（自动识别 -free，带 context/output 元数据）。
             上游切换模型时自动跟随，无需改代码。 */
          refreshLaneModels().then(models => {
            const data = models.map(id => {
              const meta = modelMeta(id)
              return { id, object: 'model', owned_by: 'ofm-patch-bridge', ...(meta ? { name: meta.name, context_window: meta.context, max_output: meta.output, vision: meta.vision } : {}) }
            })
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ object: 'list', data }))
          }).catch(() => {
            const data = laneModels().map(id => ({ id, object: 'model', owned_by: 'ofm-patch-bridge' }))
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ object: 'list', data }))
          })
          return
        }
        if (req.method === 'GET' && (subPath === '/' || subPath === '/healthz')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, lane: 'zen-bridge', note: 'OFM patch zen gateway: OpenAI-compat over local opencode bridge' }))
          return
        }
        if (req.method === 'GET' && subPath === '/sessions') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, sessions: zenSessionDebug() }))
          return
        }
        if (req.method === 'GET' && subPath === '/zen-cleanup') {
          /* GET 只出报告绝不删（防误触）；POST 才真删（{dryRun:true} 可先预演）。 */
          cleanupBridgeSessions({ dryRun: true, log }).then(result => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(result))
          }).catch(error => {
            log(`zen-cleanup GET FAILED ${String(error?.message ?? error)}`)
            if (!res.headersSent) { try { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify(errorPayload(error))) } catch { /* 已断 */ } }
          })
          return
        }
        if (req.method === 'POST' && subPath === '/zen-cleanup') {
          let parsed = {}
          try { parsed = body === '' ? {} : JSON.parse(body) } catch {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify(errorPayload('request body is not valid JSON', 'bad_json')))
            return
          }
          cleanupBridgeSessions({ dryRun: parsed?.dryRun === true, log }).then(result => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(result))
          }).catch(error => {
            log(`zen-cleanup POST FAILED ${String(error?.message ?? error)}`)
            if (!res.headersSent) { try { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify(errorPayload(error))) } catch { /* 已断 */ } }
          })
          return
        }
        if (req.method === 'POST' && (subPath === '/v1/chat/completions' || subPath === '/chat/completions')) {
          if (oversized) {
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify(errorPayload('request body too large', 'too_large')))
            return
          }
          let parsed = {}
          try { parsed = body === '' ? {} : JSON.parse(body) } catch {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify(errorPayload('request body is not valid JSON', 'bad_json')))
            return
          }
          void handleChat(req, res, parsed, log).catch(error => {
            log(`chat handler FAILED ${String(error?.message ?? error)}`)
            if (!res.headersSent) {
              try { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify(errorPayload(error))) } catch { /* 已断 */ }
            }
          })
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify(errorPayload(`no such route: ${req.method} ${subPath}`, 'not_found')))
      } catch (error) {
        log(`request dispatch FAILED ${String(error?.message ?? error)}`)
        if (!res.headersSent) {
          try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify(errorPayload(error))) } catch { /* 已断 */ }
        }
      }
    })
  }
}
