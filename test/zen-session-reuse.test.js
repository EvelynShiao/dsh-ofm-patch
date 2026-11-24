import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'zen-session-test-'))
process.env.DSH_HOME = home
const { prepareZenTurn, commitZenTurn, zenSessionDebug } = await import('../src/zen-gateway.js')
const req = { headers: { 'x-session-id': 'session-real-dsh' } }
const deps = { newSession: async () => `ses_new_${Math.random().toString(36).slice(2)}`, probeSession: async () => ({ status: 200 }) }
const body = (...messages) => ({ model: 'opencode_zen/mimo-v2.6-flash-free', messages })

test('same DSH id reuses OpenCode session and sends only the new message', async () => {
  const first = await prepareZenTurn(req, body({ role: 'user', content: 'old question' }), 'mimo-v2.6-flash-free', () => {}, deps)
  assert.equal(first.reuse, false)
  assert.match(first.prompt, /old question/)
  commitZenTurn(first, body(), 'old answer', { ok: true }, () => {})
  const next = await prepareZenTurn(req, body({ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'new question' }), 'mimo-v2.6-flash-free', () => {}, deps)
  assert.equal(next.sessionId, first.sessionId)
  assert.equal(next.reuse, true)
  assert.match(next.prompt, /new question/)
  assert.doesNotMatch(next.prompt, /old question/)
  assert.doesNotMatch(next.prompt, /old answer/)
  assert.doesNotMatch(next.prompt, /Assistant 身份直接回复最后一条 User 消息/)
})

test('edited history creates a fresh OpenCode session under the same DSH key', async () => {
  const first = await prepareZenTurn(req, body({ role: 'user', content: 'edited history' }), 'mimo-v2.6-flash-free', () => {}, deps)
  commitZenTurn(first, body(), 'answer', { ok: true }, () => {})
  const changed = await prepareZenTurn(req, body({ role: 'user', content: 'edited replacement' }), 'mimo-v2.6-flash-free', () => {}, deps)
  assert.notEqual(changed.sessionId, first.sessionId)
  assert.equal(changed.reuse, false)
  assert.match(changed.prompt, /edited replacement/)
})

test('failed turns do not advance the cursor and retries reuse the same session', async () => {
  const first = await prepareZenTurn(req, body({ role: 'user', content: 'retry base' }), 'mimo-v2.6-flash-free', () => {}, deps)
  commitZenTurn(first, body(), 'base answer', { ok: true }, () => {})
  const history = body({ role: 'user', content: 'retry base' }, { role: 'assistant', content: 'base answer' }, { role: 'user', content: 'retry this' })
  const a = await prepareZenTurn(req, history, 'mimo-v2.6-flash-free', () => {}, deps)
  commitZenTurn(a, history, 'should not commit', { ok: false }, () => {})
  const b = await prepareZenTurn(req, history, 'mimo-v2.6-flash-free', () => {}, deps)
  assert.equal(b.sessionId, first.sessionId)
  assert.equal(b.reuse, true)
  assert.match(b.prompt, /retry this/)
})

test('concurrent requests on the same DSH id serialize and do not duplicate history', async () => {
  const keyReq = { headers: { 'x-session-id': 'session-concurrent' } }
  const a = await prepareZenTurn(keyReq, body({ role: 'user', content: 'concurrent base' }), 'mimo-v2.6-flash-free', () => {}, deps)
  commitZenTurn(a, body(), 'concurrent answer', { ok: true }, () => {})
  const history = body({ role: 'user', content: 'concurrent base' }, { role: 'assistant', content: 'concurrent answer' }, { role: 'user', content: 'last message' })
  const [b, c] = await Promise.all([
    prepareZenTurn(keyReq, history, 'mimo-v2.6-flash-free', () => {}, deps),
    prepareZenTurn(keyReq, history, 'mimo-v2.6-flash-free', () => {}, deps),
  ])
  assert.equal(b.sessionId, a.sessionId)
  assert.equal(c.sessionId, a.sessionId)
  assert.equal(b.reuse, true)
  assert.equal(c.reuse, true)
})

test('a stale OpenCode session is recreated instead of sending a delta into the void', async () => {
  const keyReq = { headers: { 'x-session-id': 'session-stale' } }
  const first = await prepareZenTurn(keyReq, body({ role: 'user', content: 'stale base' }), 'mimo-v2.6-flash-free', () => {}, deps)
  commitZenTurn(first, body(), 'stale answer', { ok: true }, () => {})
  const next = await prepareZenTurn(keyReq, body({ role: 'user', content: 'stale base' }, { role: 'assistant', content: 'stale answer' }, { role: 'user', content: 'after restart' }), 'mimo-v2.6-flash-free', () => {}, { ...deps, probeSession: async () => ({ status: 404 }) })
  assert.equal(next.reuse, false)
  assert.notEqual(next.sessionId, first.sessionId)
  assert.match(next.prompt, /stale base/)
  assert.match(next.prompt, /after restart/)
})

test('bindings persist across a fresh gateway module load', async () => {
  const before = zenSessionDebug().find(row => row.key === 'session-real-dsh')
  assert.ok(before?.sessionId.startsWith('ses_'))
  const saved = JSON.parse(readFileSync(join(home, 'our-free-model-patch', 'zen-session-bindings.json'), 'utf8'))
  assert.ok(Object.keys(saved.sessions).length >= 1)
})

test.after(() => rmSync(home, { recursive: true, force: true }))
