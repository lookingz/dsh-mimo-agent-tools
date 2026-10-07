// Tests for the ./mimo export — the ctx-light MiMo TTS/ASR client.
// No network: fetch is injected; every assertion inspects the request the
// client builds or the value it returns (mirrors dsh-voice-mimo semantics,
// which this module absorbs per docs/adr/0001).
//
// Run: node --test tests/client.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createMiMoClient,
  PRESET_VOICES,
  resolveTtsTarget,
  applyStyle,
  truncateTtsText,
  toDataUrl,
} from '../mimo.js'

const AUDIO_B64 = Buffer.from('RIFF0000WAVEfmt ').toString('base64')

function mockFetch(response) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => response.text ?? '',
      json: async () => response.json ?? {},
    }
  }
  return { calls, impl }
}

function clientWith(response, extra = {}) {
  const { calls, impl } = mockFetch(response)
  const client = createMiMoClient({ apiKey: 'test-key', fetchImpl: impl, ...extra })
  return { calls, client }
}

// ── voice-map semantics (pure helpers, caller-configurable) ──

test('PRESET_VOICES carries the nine preset names', () => {
  for (const v of ['mimo_default', '冰糖', 'Mia', 'Dean']) assert.ok(PRESET_VOICES.has(v))
})

test('resolveTtsTarget: preset → mimo-v2.5-tts with audio.voice', () => {
  const t = resolveTtsTarget({}, {}, 'Mia')
  assert.equal(t.model, 'mimo-v2.5-tts')
  assert.equal(t.voiceType, 'preset')
  assert.equal(t.audio.voice, 'Mia')
})

test('resolveTtsTarget: non-preset string → voicedesign description', () => {
  const t = resolveTtsTarget({}, {}, '温柔的女声')
  assert.equal(t.model, 'mimo-v2.5-tts-voicedesign')
  assert.equal(t.voiceType, 'voicedesign')
  assert.equal(t.userContent, '温柔的女声')
})

test('resolveTtsTarget: voiceMap entry decides (caller-configurable)', () => {
  const map = { news: { type: 'voicedesign', model: 'mimo-v2.5-tts-voicedesign', voice: '播音员腔' } }
  const t = resolveTtsTarget({}, map, 'news')
  assert.equal(t.voiceType, 'voicedesign')
  assert.equal(t.userContent, '播音员腔')
  const clone = resolveTtsTarget({}, { me: { model: 'mimo-v2.5-tts-voiceclone' } }, 'me')
  assert.equal(clone.voiceType, 'voiceclone')
  assert.equal(clone.needsReference, true)
})

test('applyStyle: preset style rides user message; voicedesign gets inline tag', () => {
  const preset = applyStyle({ style: '温柔', voiceType: 'preset', userContent: 'x', text: 'hi' })
  assert.equal(preset.userContent, '温柔')
  assert.equal(preset.text, 'hi')
  const vd = applyStyle({ style: '温柔', voiceType: 'voicedesign', userContent: '女声', text: 'hi' })
  assert.equal(vd.userContent, '女声')
  assert.equal(vd.text, '(温柔)hi')
})

test('truncateTtsText cuts beyond MAX_TTS_TEXT_CHARS codepoint-safely', () => {
  const { text, truncated } = truncateTtsText('a'.repeat(3000))
  assert.equal(truncated, true)
  assert.ok(text.length <= 2500)
})

test('toDataUrl wraps base64/Buffer into a data URL', () => {
  const d = toDataUrl(AUDIO_B64, 'audio/wav')
  assert.ok(d.startsWith('data:audio/wav;base64,'))
  const d2 = toDataUrl(Buffer.from('abc'), 'audio/mpeg')
  assert.ok(d2.startsWith('data:audio/mpeg;base64,'))
})

// ── speak (TTS, fetch transport) ──

test('speak: preset voice posts chat/completions with audio.voice and decodes audio', async () => {
  const { calls, client } = clientWith({ json: { choices: [{ message: { audio: { data: AUDIO_B64 } } }] } })
  const res = await client.speak({ voice: 'Mia', text: '你好' })
  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, 'https://api.xiaomimimo.com/v1/chat/completions')
  assert.equal(init.headers['api-key'], 'test-key')
  const body = JSON.parse(init.body)
  assert.equal(body.model, 'mimo-v2.5-tts')
  assert.equal(body.audio.voice, 'Mia')
  assert.equal(body.audio.format, 'wav')
  assert.equal(body.messages[1].content, '你好')
  assert.equal(res.bytes.toString('latin1').slice(0, 4), 'RIFF')
  assert.equal(res.mime, 'audio/wav')
})

test('speak: voicedesign + style moves style into an inline tag', async () => {
  const { calls, client } = clientWith({ json: { choices: [{ message: { audio: { data: AUDIO_B64 } } }] } })
  await client.speak({ voice: '温柔的女声', text: 'hi', style: '轻快' })
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'mimo-v2.5-tts-voicedesign')
  assert.equal(body.messages[0].content, '温柔的女声')
  assert.equal(body.messages[1].content, '(轻快)hi')
})

test('speak: voiceMap entry + clone reference goes out as a data URL', async () => {
  const { calls, client } = clientWith({ json: { choices: [{ message: { audio: { data: AUDIO_B64 } } }] } })
  const res = await client.speak({
    voice: 'me',
    voiceMap: { me: { model: 'mimo-v2.5-tts-voiceclone' } },
    reference: `data:audio/wav;base64,${AUDIO_B64}`,
    text: 'clone me',
  })
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'mimo-v2.5-tts-voiceclone')
  assert.ok(body.audio.voice.startsWith('data:audio/wav;base64,'))
  assert.equal(res.bytes.length, 16)
})

test('speak: model option overrides the preset-TTS model (caller-configurable)', async () => {
  const { calls, client } = clientWith({ json: { choices: [{ message: { audio: { data: AUDIO_B64 } } }] } })
  await client.speak({ voice: 'Mia', text: 'hi', model: 'mimo-v2.5-tts-preview' })
  assert.equal(JSON.parse(calls[0].init.body).model, 'mimo-v2.5-tts-preview')
})

test('speak: mp3 format + custom baseUrl are honored', async () => {
  const { calls, client } = clientWith(
    { json: { choices: [{ message: { audio: { data: AUDIO_B64 } } }] } },
    { baseUrl: 'https://proxy.example/v1/' },
  )
  await client.speak({ text: 'hi', format: 'mp3' })
  assert.equal(calls[0].url, 'https://proxy.example/v1/chat/completions')
  assert.equal(JSON.parse(calls[0].init.body).audio.format, 'mp3')
})

test('speak: HTTP error surfaces status + body snippet', async () => {
  const { client } = clientWith({ ok: false, status: 429, text: 'rate limited' })
  await assert.rejects(() => client.speak({ text: 'hi' }), /HTTP 429/)
})

test('speak: missing audio data in a 2xx response is an explicit error', async () => {
  const { client } = clientWith({ json: { choices: [{ message: {} }] } })
  await assert.rejects(() => client.speak({ text: 'hi' }), /no audio data/)
})

// ── transcribe (ASR, fetch transport) ──

test('transcribe: base64 audio becomes a data URL; language rides asr_options', async () => {
  const { calls, client } = clientWith({ json: { choices: [{ message: { content: ' 你好世界 ' } }] } })
  const res = await client.transcribe({ audio: AUDIO_B64, language: 'zh' })
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'mimo-v2.5-asr')
  assert.equal(body.messages[0].content[0].type, 'input_audio')
  assert.ok(body.messages[0].content[0].input_audio.data.startsWith('data:audio/wav;base64,'))
  assert.deepEqual(body.asr_options, { language: 'zh' })
  assert.equal(res.text, '你好世界')
})

test('transcribe: no language → no asr_options key', async () => {
  const { calls, client } = clientWith({ json: { choices: [{ message: { content: 'hi' } }] } })
  await client.transcribe({ audio: AUDIO_B64 })
  assert.equal(JSON.parse(calls[0].init.body).asr_options, undefined)
})

test('transcribe: non-ok response rejects', async () => {
  const { client } = clientWith({ ok: false, status: 500, text: 'boom' })
  await assert.rejects(() => client.transcribe({ audio: AUDIO_B64 }), /HTTP 500/)
})

// ── speakResolved: pre-resolved target transport (web routes / store mode) ──

test('speakResolved: posts the given model/messages/audio verbatim, returns bytes', async () => {
  const { calls, client } = clientWith({ json: { choices: [{ message: { audio: { data: Buffer.from('RIFF').toString('base64') } } }] } })
  const out = await client.speakResolved({
    model: 'mimo-v2.5-tts',
    userContent: '温柔',
    text: '你好',
    audio: { format: 'wav', voice: '冰糖' },
  })
  assert.equal(Buffer.isBuffer(out.bytes), true)
  assert.equal(out.mime, 'audio/wav')
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body.messages, [
    { role: 'user', content: '温柔' },
    { role: 'assistant', content: '你好' },
  ])
  assert.deepEqual(body.audio, { format: 'wav', voice: '冰糖' })
  assert.equal(body.model, 'mimo-v2.5-tts')
})

test('speakResolved: no audio data → error; mp3 format → audio/mpeg mime', async () => {
  const a = clientWith({ json: { choices: [{ message: {} }] } })
  await assert.rejects(a.client.speakResolved({ model: 'm', userContent: 'u', text: 't', audio: { format: 'wav' } }), /no audio data/)
  const b = clientWith({ json: { choices: [{ message: { audio: { data: Buffer.from('x').toString('base64') } } }] } })
  const out = await b.client.speakResolved({ model: 'm', userContent: 'u', text: 't', audio: { format: 'mp3' } })
  assert.equal(out.mime, 'audio/mpeg')
})
