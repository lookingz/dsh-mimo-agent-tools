// mimo_tts store mode + plugin Config wiring (#4, decision: mimo_tts gains an
// explicit `store` flag; default file-writing behavior is untouched).
//
// The store path runs through the shared ./mimo client (node fetch — no shell,
// no 64KB cap), so the test stubs globalThis.fetch and a credentials-only ctx.
//
// Run: node --test tests/tts-store.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, Config } from '../index.js'

function pcmWav(seconds = 1) {
  const dataBytes = 48000 * seconds
  const buf = Buffer.alloc(12 + 8 + 16 + 8 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(buf.length - 8, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(24000, 24); buf.writeUInt32LE(48000, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  return buf
}

async function makeEnv(config) {
  const root = await mkdtemp(join(tmpdir(), 'mimo-tts-store-'))
  const audioDir = join(root, 'audio')
  const registered = []
  const skills = []
  const routes = []
  const fullConfig = {
    provider: { baseUrl: 'https://api.xiaomimimo.com/v1', credential: 'XIAOMI_API_KEY' },
    voiceMap: { alloy: { type: 'preset', voice: '冰糖' } },
    tts: { model: 'mimo-v2.5-tts', format: 'wav', timeoutMs: 60000, voice: 'alloy', style: '温柔' },
    audio: { dir: audioDir, inlineThreshold: 30 },
    ...config,
  }
  const ctx = {
    get(name) {
      if (name === 'credentials') return { resolve: async () => ({ value: 'test-key' }) }
      return undefined
    },
    tools: { register(t) { registered.push(t) } },
    skills: { register(s) { skills.push(s) } },
    inject(_, fn) {
      // fake webServer seam: run the effect with a recording webServer
      fn({
        webServer: { register(r) { routes.push(r); return () => {} } },
        effect(setup, label) {
          const dispose = setup(undefined, label)
          if (dispose) disposals.push(dispose)
        },
      })
    },
    logger: { warn() {}, info() {} },
  }
  const disposals = []
  void disposals
  await apply(ctx, fullConfig)
  const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
  return { ctx, byName, skills, routes, audioDir, fullConfig }
}

test('mimo_tts exposes the optional store flag', async () => {
  const { byName } = await makeEnv()
  const p = byName.mimo_tts.parameters.properties
  assert.equal(p.store.type, 'boolean')
  assert.ok(p.store.description.includes('audio store'))
})

test('Config schema exists with voiceMap + tts voice/style (Plugins settings tab projection)', () => {
  assert.ok(Config, 'Config export is required')
  const dump = Config.toString()
  assert.ok(dump.includes('voiceMap'), 'Config must carry voiceMap')
  assert.ok(dump.includes('tts'), 'Config must carry tts')
  assert.ok(dump.includes('provider'), 'Config must carry provider')
  assert.ok(dump.includes('audio'), 'Config must carry audio')
  assert.ok(!dump.includes('stt'), 'stt section is retired with the voice_* tools')
})

test('apply works with no config at all (backward compatible)', async () => {
  const registered = []
  const ctx = {
    get() { return undefined },
    tools: { register(t) { registered.push(t) } },
    skills: { register() {} },
    logger: { warn() {} },
  }
  await apply(ctx)
  assert.ok(registered.length >= 9)
})

test('mimo_tts store:true synthesizes into long/, records manifest, returns strip envelope', async () => {
  const { byName, audioDir } = await makeEnv()
  const bodies = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    bodies.push({ url, body: JSON.parse(init.body) })
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { audio: { data: pcmWav(1).toString('base64') } } }] }),
    }
  }
  try {
    const result = await byName.mimo_tts.execute(
      { text: ' 你好世界 ', store: true },
      { agent: { id: 'session-1' }, callId: 'call-1' },
    )
    assert.equal(result.ok, true)
    assert.match(result.audioUrl, /^\/_dsh\/mimo-agent-tools\/audio\/m-[A-Za-z0-9-]+\.wav$/)
    assert.equal(result.seconds, 1)
    assert.equal(result.inline, true)
    assert.equal(result.style, '温柔') // config default applied, recorded for regenerate
    assert.ok(result.path.startsWith(join(audioDir, 'long')))
    const written = await readFile(result.path)
    assert.ok(written.length > 0)
    // request went through the shared MiMo transport with the mapped voice
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].body.model, 'mimo-v2.5-tts')
    assert.equal(bodies[0].body.messages[0].content, '温柔') // preset → style user message
    assert.equal(bodies[0].body.messages[1].content, '你好世界')
    assert.deepEqual(bodies[0].body.audio, { format: 'wav', voice: '冰糖' })
    // strip render carries the machine envelope the UI parses
    const render = byName.mimo_tts.output.render({ text: '你好世界', store: true }, result)
    const envelopeBlock = render.find((b) => b.text.trim().startsWith('{'))
    const envelope = JSON.parse(envelopeBlock.text)
    assert.equal(envelope.audioUrl, result.audioUrl)
    assert.equal(envelope.seconds, 1)
    assert.equal(envelope.inline, true)
    assert.ok(!('notify' in envelope))
  } finally {
    globalThis.fetch = realFetch
  }
})

test('mimo_tts store:true with voiceclone-mapped voice and no reference → clear error', async () => {
  const { byName, fullConfig } = await makeEnv({
    voiceMap: { echo: { type: 'preset', voice: '苏打', model: 'mimo-v2.5-tts-voiceclone' } },
    tts: { model: 'mimo-v2.5-tts', format: 'wav', timeoutMs: 60000, voice: 'echo', style: '温柔' },
  })
  void fullConfig
  const result = await byName.mimo_tts.execute({ text: 'hi', store: true }, {})
  assert.equal(result.ok, false)
  assert.match(result.error, /reference/)
})

test('apply registers the four web routes under the webServer seam', async () => {
  const { routes } = await makeEnv()
  const paths = routes.map((r) => r.path).sort()
  assert.deepEqual(paths, [
    '/_dsh/mimo-agent-tools/archive-cleanup',
    '/_dsh/mimo-agent-tools/audio',
    '/_dsh/mimo-agent-tools/regenerate',
    '/_dsh/mimo-agent-tools/speak',
  ])
})
