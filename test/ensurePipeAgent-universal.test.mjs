import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensurePipeAgent, FREE_MODEL_RE } from '../src/opencode-bridge.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-test-'))
const cfgPath = path.join(tmpDir, 'opencode.json')

try {
  // Test 1: Fresh config - should write universal limits for all -free models
  fs.writeFileSync(cfgPath, JSON.stringify({}, null, 2))

  const result1 = ensurePipeAgent(cfgPath)
  console.log('Test 1 (fresh config):', result1)
  if (result1 !== 'updated') throw new Error('Expected "updated" for fresh config')

  const cfg1 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  if (cfg1.compaction?.auto !== false || cfg1.compaction?.background !== false) {
    throw new Error('Compaction not disabled')
  }
  console.log('Compaction disabled:', cfg1.compaction)

  // Check all -free models have universal limits
  const models1 = cfg1.provider?.opencode?.models || {}
  for (const [modelId, modelCfg] of Object.entries(models1)) {
    if (FREE_MODEL_RE.test(modelId)) {
      const limit = modelCfg?.limit
      if (!limit || limit.context !== 50000000 || limit.output !== 32000) {
        throw new Error(`Model ${modelId} missing universal limits: ${JSON.stringify(limit)}`)
      }
      console.log(`  ${modelId}: context=${limit.context}, output=${limit.output}`)
    }
  }

  // Test 2: Idempotent - should return 'ok'
  const result2 = ensurePipeAgent(cfgPath)
  console.log('Test 2 (idempotent):', result2)
  if (result2 !== 'ok') throw new Error('Expected "ok" for idempotent call')

  // Test 3: Config with existing mimo 1M - should upgrade to universal
  fs.writeFileSync(cfgPath, JSON.stringify({
    compaction: { auto: true, background: true },
    provider: {
      opencode: {
        models: {
          'mimo-v2.6-flash-free': { limit: { context: 1048576, output: 32000 } },
          'deepseek-v4.1-flash-free': { limit: { context: 200000, output: 8192 } },
          'some-paid-model': { limit: { context: 128000, output: 4096 } }
        }
      }
    }
  }, null, 2))

  const result3 = ensurePipeAgent(cfgPath)
  console.log('Test 3 (upgrade from mimo 1M):', result3)
  if (result3 !== 'updated') throw new Error('Expected "updated" for upgrade')

  const cfg3 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  if (cfg3.compaction?.auto !== false || cfg3.compaction?.background !== false) {
    throw new Error('Compaction not disabled after upgrade')
  }
  const models3 = cfg3.provider?.opencode?.models || {}
  for (const [modelId, modelCfg] of Object.entries(models3)) {
    if (FREE_MODEL_RE.test(modelId)) {
      const limit = modelCfg?.limit
      if (!limit || limit.context !== 50000000 || limit.output !== 32000) {
        throw new Error(`Model ${modelId} not upgraded to universal: ${JSON.stringify(limit)}`)
      }
      console.log(`  ${modelId}: context=${limit.context}, output=${limit.output}`)
    }
    // Paid model should be untouched
    if (modelId === 'some-paid-model') {
      const limit = modelCfg?.limit
      if (limit?.context === 50000000) {
        throw new Error('Paid model incorrectly modified')
      }
      console.log(`  ${modelId} (paid): untouched, context=${limit?.context}`)
    }
  }

  console.log('\n✅ All tests passed!')

} finally {
  // Cleanup temp
  try { fs.rmSync(tmpDir, { recursive: true }) } catch {}
}