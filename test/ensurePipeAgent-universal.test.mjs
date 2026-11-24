import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensurePipeAgent } from '../src/opencode-bridge.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-test-'))
const cfgPath = path.join(tmpDir, 'opencode.json')

try {
  // Test 1: fresh config → 写入 agent + 关压缩；不得创建任何逐模型窗口覆盖
  fs.writeFileSync(cfgPath, JSON.stringify({}, null, 2))
  const r1 = ensurePipeAgent(cfgPath)
  console.log('Test 1 (fresh config):', r1)
  if (r1 !== 'updated') throw new Error('Expected "updated" for fresh config')

  const c1 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  if (c1.compaction?.auto !== false || c1.compaction?.background !== false) throw new Error('Compaction not disabled')
  const models1 = c1.provider?.opencode?.models
  if (models1 !== undefined && Object.keys(models1).length > 0) {
    throw new Error(`不应创建逐模型窗口覆盖: ${JSON.stringify(models1)}`)
  }
  console.log('Compaction disabled:', c1.compaction, '| models untouched:', models1 ?? '(absent)')

  // Test 2: 幂等 → ok
  const r2 = ensurePipeAgent(cfgPath)
  console.log('Test 2 (idempotent):', r2)
  if (r2 !== 'ok') throw new Error('Expected "ok" for idempotent call')

  // Test 3: 既有模型窗口配置 + 压缩被升级重开 → 只修 compaction，模型 limit 一字不动
  fs.writeFileSync(cfgPath, JSON.stringify({
    compaction: { auto: true, background: true },
    provider: {
      opencode: {
        models: {
          'mimo-v2.6-flash-free': { limit: { context: 1048576, output: 32000 } },
          'some-paid-model': { limit: { context: 128000, output: 4096 } }
        }
      }
    }
  }, null, 2))
  const r3 = ensurePipeAgent(cfgPath)
  console.log('Test 3 (compaction re-enabled):', r3)
  if (r3 !== 'updated') throw new Error('Expected "updated" when compaction was re-enabled')

  const c3 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  if (c3.compaction?.auto !== false || c3.compaction?.background !== false) throw new Error('Compaction not re-disabled')
  const m3 = c3.provider?.opencode?.models
  if (m3['mimo-v2.6-flash-free']?.limit?.context !== 1048576) throw new Error('mimo limit 被误改')
  if (m3['some-paid-model']?.limit?.context !== 128000) throw new Error('paid model 被误改')
  console.log('Existing model limits untouched:', JSON.stringify(m3))

  // Test 4: agent 形状过时 + 压缩正确 → updated（注册表自愈路径仍有效）
  const c4 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  c4.agent.mute2.description = 'stale shape'
  fs.writeFileSync(cfgPath, JSON.stringify(c4, null, 2))
  const r4 = ensurePipeAgent(cfgPath)
  console.log('Test 4 (stale agent shape):', r4)
  if (r4 !== 'updated') throw new Error('Expected "updated" for stale agent shape')
  const c4b = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  if (c4b.agent.mute2.description !== 'dsh our-free-model bridge: DSH tool protocol in system prompt') throw new Error('agent shape not restored')

  console.log('\nAll tests passed!')
} finally {
  try { fs.rmSync(tmpDir, { recursive: true }) } catch {}
}
