import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'zen-session-test-'))
process.env.DSH_HOME = home
const { prepareZenTurn, commitZenTurn, zenSessionDebug, isBridgeSessionRow } = await import('../src/zen-gateway.js')
const req = { headers: { 'x-session-id': 'session-real-dsh' } }
/* 2026-11-24 自清：rebuild 会删旧 opencode 会话——默认走真 deleteBridgeSession
   （会碰本机服务），测试里换成间谍记录调用；走 rebuild 路径的用例都必须经这份 deps。 */
const deletedSessions = []
const deps = {
  newSession: async () => `ses_new_${Math.random().toString(36).slice(2)}`,
  probeSession: async () => ({ status: 200 }),
  deleteSession: async id => { deletedSessions.push(id); return { status: 200, ok: true, deletedId: id } },
}
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
  assert.equal(deletedSessions.length, 0) // 复用与首建都不该触发删除
})

test('edited history creates a fresh OpenCode session under the same DSH key', async () => {
  const priorSession = zenSessionDebug().find(row => row.key === 'session-real-dsh')?.sessionId
  let before = deletedSessions.length
  const first = await prepareZenTurn(req, body({ role: 'user', content: 'edited history' }), 'mimo-v2.6-flash-free', () => {}, deps)
  /* 自清断言：rebuild 删掉的正是上一条绑定里的旧 opencode 会话 */
  assert.deepEqual(deletedSessions.slice(before), [priorSession])
  commitZenTurn(first, body(), 'answer', { ok: true }, () => {})
  before = deletedSessions.length
  const changed = await prepareZenTurn(req, body({ role: 'user', content: 'edited replacement' }), 'mimo-v2.6-flash-free', () => {}, deps)
  assert.deepEqual(deletedSessions.slice(before), [first.sessionId])
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
  const before = deletedSessions.length
  const next = await prepareZenTurn(keyReq, body({ role: 'user', content: 'stale base' }, { role: 'assistant', content: 'stale answer' }, { role: 'user', content: 'after restart' }), 'mimo-v2.6-flash-free', () => {}, { ...deps, probeSession: async () => ({ status: 404 }) })
  /* 自清断言：探活 404 的死会话在重建时同样被删 */
  assert.deepEqual(deletedSessions.slice(before), [first.sessionId])
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

test('fingerprints are stored as 64-char sha256 hex (bindings stay small)', async () => {
  const saved = JSON.parse(readFileSync(join(home, 'our-free-model-patch', 'zen-session-bindings.json'), 'utf8'))
  const rows = Object.values(saved.sessions)
  assert.ok(rows.length >= 3)
  for (const row of rows) {
    assert.ok(Array.isArray(row.fingerprints) && row.fingerprints.length > 0)
    for (const fp of row.fingerprints) assert.match(fp, /^[0-9a-f]{64}$/)
  }
  /* 旧版存完整消息 JSON（单绑定实测 ~1.18MB）；换成哈希后整表必须回到 KB 量级。 */
  assert.ok(JSON.stringify(saved).length < 100_000)
})

test('isBridgeSessionRow matches bridge agents only (real GET /api/session shape: agent is a plain string)', () => {
  assert.equal(isBridgeSessionRow({ id: 'ses_x', agent: 'mute2' }), true)
  assert.equal(isBridgeSessionRow({ id: 'ses_x', agent: 'mute3' }), true)
  assert.equal(isBridgeSessionRow({ id: 'ses_x', agent: 'pipe' }), true)
  assert.equal(isBridgeSessionRow({ id: 'ses_x', agent: 'build' }), false)
  assert.equal(isBridgeSessionRow({ id: 'ses_x', agent: { name: 'mute3' } }), true) // 防 agent 将来改成对象形状
  assert.equal(isBridgeSessionRow({ id: 'ses_x' }), false)
  assert.equal(isBridgeSessionRow(null), false)
})

test.after(() => rmSync(home, { recursive: true, force: true }))
