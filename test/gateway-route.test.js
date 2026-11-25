import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createZenGatewayHandler } from '../src/zen-gateway.js'

test('gateway health route stays outside the OFM API prefix', async t => {
  const server = http.createServer(createZenGatewayHandler())
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const valid = await fetch(`${base}/api/ofm-patch/zen-gateway/healthz`)
  assert.equal(valid.status, 200)
  assert.equal((await valid.json()).ok, true)
  const old = await fetch(`${base}/api/our-free-model-patch/zen-gateway/healthz`)
  assert.equal(old.status, 404)
})
