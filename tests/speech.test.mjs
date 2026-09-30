// Static tests for the speechToText provider entry (speech.js) — no network,
// no real ctx: fake the minimal speechToText service and assert what the
// provider declares and how it maps inputs.
//
// Run: node --test tests/speech.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, inject, wavSeconds, asrLanguage } from '../speech.js'

test('entry metadata: sub-entry name, injects the speechToText seam', () => {
  assert.equal(name, 'dsh-mimo-agent-tools/speech')
  assert.ok(inject.includes('speechToText'), 'must inject the official seam')
  // shell/credentials/sandboxPolicy are the run pipeline the driver needs.
  for (const dep of ['shell', 'credentials', 'sandboxPolicy']) assert.ok(inject.includes(dep))
})

test('registers one cloud provider named mimo with language hints', () => {
  const registered = []
  const effects = []
  const ctx = {
    speechToText: { register(p) { registered.push(p) } },
    // cordis ctx.effect invokes the callback immediately; its return is the disposer.
    effect(fn) { effects.push(fn); return fn() },
  }
  apply(ctx)
  assert.equal(registered.length, 1)
  const provider = registered[0]
  assert.equal(provider.info.id, 'mimo')
  assert.equal(provider.info.location, 'cloud')
  assert.deepEqual([...provider.info.languages], ['auto', 'zh', 'en'])
  // Registration is owned by a ctx.effect disposer (fiber lifetime).
  assert.equal(effects.length, 1)
  assert.equal(typeof effects[0], 'function')
})

test('wavSeconds walks RIFF chunks for the data size over byte rate', () => {
  // 16 kHz mono PCM16, 1 second of payload: byteRate=32000, data size=32000.
  const wav = new Uint8Array(44 + 32000)
  const dv = new DataView(wav.buffer)
  dv.setUint32(0, 0x52494646, false) // 'RIFF'
  dv.setUint32(12, 0x666d7420, false) // 'fmt '
  dv.setUint32(16, 16, true) // fmt chunk size
  dv.setUint32(28, 32000, true) // byte rate
  dv.setUint32(36, 0x64617461, false) // 'data'
  dv.setUint32(40, 32000, true)
  assert.equal(wavSeconds(wav), 1)
  // Non-WAV input degrades to 0, never throws.
  assert.equal(wavSeconds(new Uint8Array([1, 2, 3])), 0)
})

test('asrLanguage maps seam hints to MiMo asr_options language', () => {
  assert.equal(asrLanguage('zh'), 'zh')
  assert.equal(asrLanguage('en'), 'en')
  assert.equal(asrLanguage(''), undefined)
  assert.equal(asrLanguage('auto'), undefined)
  assert.equal(asrLanguage(undefined), undefined)
})
