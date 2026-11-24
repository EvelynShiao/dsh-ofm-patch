import http from 'node:http'
import fs from 'node:fs'
import zlib from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), 'AppData', 'Local', 'DeepSeekHarness', '.dsh')
const roots = [path.join(dshHome, 'sessions')]
let sessionFile = null
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      if (name.startsWith('session-3e4b2f31-')) {
        const f = path.join(full, 'session.v4.jsonl.zstd')
        if (fs.existsSync(f)) sessionFile = f
      } else walk(full)
    }
  }
}
for (const root of roots) walk(root)
if (!sessionFile) throw new Error('找不到新的大肥鱼会话文件')

function decode(file) {
  const buf = fs.readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  let offset = 0
  let text = ''
  while (offset < buf.length) {
    let end = buf.indexOf(magic, offset + 4)
    if (end < 0) end = buf.length
    text += zlib.zstdDecompressSync(buf.subarray(offset, end)).toString('utf8')
    offset = end
  }
  return text
}

const events = decode(sessionFile).split('\n').filter(Boolean).map(line => JSON.parse(line))
const surface = new Map()
for (const event of events) {
  if (!event.type.endsWith('/message')) continue
  if (event.surfaceOp === 'append' || event.surfaceOp?.op === 'append') surface.set(event.seq, event)
  else if (event.surfaceOp === 'replace' || event.surfaceOp?.op === 'replace') {
    const op = typeof event.surfaceOp === 'object' ? event.surfaceOp : event
    for (let seq = op.startSeq; seq <= op.endSeq; seq++) surface.delete(seq)
    surface.set(event.seq, event)
  }
}
const messages = []
for (const seq of [...surface.keys()].sort((a, b) => a - b)) {
  const event = surface.get(seq)
  const role = event.data?.role ?? event.data?.message?.role
  if (!['user', 'assistant', 'developer', 'system'].includes(role)) continue
  const raw = event.data?.content ?? event.data?.message?.content
  const blocks = typeof raw === 'string' ? [{ type: 'text', text: raw }] : Array.isArray(raw) ? raw : []
  const content = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
  if (!content) continue
  messages.push({ role: role === 'developer' ? 'system' : role, content })
}
if (messages.length < 100) throw new Error(`提取消息异常，只有 ${messages.length} 条`)

const gateway = await import(pathToFileURL(path.join(dshHome, 'plugin-src', 'dsh-ofm-patch', 'src', 'zen-gateway.js')).href)
const server = http.createServer(gateway.createZenGatewayHandler({ log: line => console.log(`[gateway] ${line}`) }))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/chat/completions`
const sessionId = process.env.ZEN_BENCH_ID || `zen-bigfish-benchmark-${Date.now()}`
const requestHeaders = { 'content-type': 'application/json', 'x-session-id': sessionId }
const results = []
const marker = '只回复「增量测试收到」，不要回答其他内容。'
const secondMarker = '刚才我要求你回复的两个测试短句是什么？请逐字依次写出这两句，不要回答其他内容。'

async function send(label, list) {
  const started = Date.now()
  const res = await fetch(base, { method: 'POST', headers: requestHeaders, body: JSON.stringify({ model: 'opencode_zen/mimo-v2.6-flash-free', messages: list }) })
  const json = await res.json()
  const row = { label, http: res.status, elapsedMs: Date.now() - started, messages: list.length, content: json.choices?.[0]?.message?.content?.slice(0, 100), error: json.error, usage: json.usage }
  results.push(row)
  console.log(`RESULT ${JSON.stringify(row)}`)
  if (!res.ok || json.error) throw new Error(`${label} failed`)
  return json.choices?.[0]?.message?.content ?? ''
}

try {
  console.log(`SOURCE ${sessionFile}`)
  console.log(`HISTORY messages=${messages.length} chars=${JSON.stringify(messages).length}`)
  const firstAnswer = await send('full', messages)
  const added = [...messages, { role: 'assistant', content: firstAnswer }, { role: 'user', content: marker }]
  const secondAnswer = await send('incremental', added)
  const followup = [...added, { role: 'assistant', content: secondAnswer }, { role: 'user', content: '只回复「第二段增量收到」，不要回答其他内容。' }]
  const thirdAnswer = await send('incremental-again', followup)
  const recall = [...followup, { role: 'assistant', content: thirdAnswer }, { role: 'user', content: secondMarker }]
  const recalled = await send('incremental-recall', recall)
  if (!recalled.includes('增量测试收到') || !recalled.includes('第二段增量收到')) throw new Error(`增量回忆失败：${recalled}`)
  const reduced = added.filter((_, index) => index !== Math.floor(messages.length / 2))
  await send('deleted-middle-full-replay', reduced)
  const bindings = JSON.parse(fs.readFileSync(path.join(dshHome, 'our-free-model-patch', 'zen-session-bindings.json'), 'utf8'))
  const binding = bindings.sessions?.[`${sessionId}\0mimo-v2.6-flash-free`]
  if (!binding?.sessionId) throw new Error('缺少基准绑定，无法核查 compaction')
  const { readBridgeJson } = await import(pathToFileURL(path.join(dshHome, 'plugin-src', 'dsh-ofm-patch', 'src', 'opencode-bridge.js')).href)
  const reply = await readBridgeJson(`/api/session/${binding.sessionId}/message`)
  const rows = reply.data?.data ?? reply.data ?? []
  const compactions = rows.filter(row => row?.type === 'compaction').map(row => ({ reason: row.reason, status: row.status, error: row.error }))
  console.log(`COMPACTION_CHECK ${JSON.stringify({ compactions })}`)
  if (compactions.length > 0) throw new Error('禁压缩配置下仍发生 compaction')
} finally {
  await new Promise(resolve => server.close(resolve))
}
fs.writeFileSync(path.join(dshHome, 'our-free-model-patch', 'zen-bigfish-benchmark-result.json'), JSON.stringify({ sessionFile, sessionId, results }, null, 2))
