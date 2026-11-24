import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'zen-live-'))
process.env.DSH_HOME = home
const { createZenGatewayHandler } = await import('../src/zen-gateway.js')
const handler = createZenGatewayHandler({ log: line => console.log(`[gateway] ${line}`) })
const server = http.createServer(handler)
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

async function turn(messages, label) {
  const start = Date.now()
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': 'zen-live-smoke-only' },
    body: JSON.stringify({ model: 'opencode_zen/mimo-v2.6-flash-free', messages }),
  })
  const text = await res.text()
  const json = JSON.parse(text)
  console.log(JSON.stringify({ label, http: res.status, elapsedMs: Date.now() - start, content: json.choices?.[0]?.message?.content?.slice(0, 100), error: json.error, usage: json.usage }, null, 2))
  return json
}

try {
  const first = await turn([{ role: 'user', content: '只回复：缓存测试一' }], 'first')
  const answer = first.choices?.[0]?.message?.content ?? ''
  if (!answer) throw new Error('first turn did not produce a reply')
  await turn([{ role: 'user', content: '只回复：缓存测试一' }, { role: 'assistant', content: answer }, { role: 'user', content: '只回复：缓存测试二' }], 'incremental')
} finally {
  await new Promise(resolve => server.close(resolve))
  rmSync(home, { recursive: true, force: true })
}
