/**
 * dsh-mimo-agent-tools/mimo — reusable, ctx-light MiMo TTS/ASR client.
 *
 * Absorbs the MiMo HTTPS transport from dsh-voice-mimo (lib/tts.js +
 * lib/web.js) per docs/adr/0001: agent-tools becomes the single MiMo
 * transport and voice-mimo imports this client instead of carrying its own.
 *
 * Deliberately ctx-light: no shell, no sandboxPolicy, no credentials
 * service, no DSH imports — the caller passes an apiKey (resolved however
 * it likes) and may inject `fetchImpl` for tests. The python-driver route
 * (createRuntime in index.js) is untouched; those tools keep running
 * through the shell pipeline where the 64KB stdout cap matters.
 *
 * Voice-map semantics (preset / voicedesign / voiceclone) stay
 * caller-configurable: pass a voiceMap to speak() or resolve your own
 * target with resolveTtsTarget and call speak with it.
 */

const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'

/** MiMo TTS preset voices (mimo-v2.5-tts accepts these directly). */
export const PRESET_VOICES = new Set(['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'])

/** Official guidance: segment TTS text beyond this many characters. */
export const MAX_TTS_TEXT_CHARS = 2500

/**
 * Truncate TTS target text to MAX_TTS_TEXT_CHARS (codepoint-safe). Returns
 * { text, truncated } — a silent over-limit request would fail at the API,
 * so we cut explicitly and let the caller surface the flag.
 */
export function truncateTtsText(text) {
  const t = String(text ?? '')
  if (t.length <= MAX_TTS_TEXT_CHARS) return { text: t, truncated: false }
  return { text: Array.from(t).slice(0, MAX_TTS_TEXT_CHARS).join(''), truncated: true }
}

/**
 * Resolve a voice name against the voiceMap into a concrete MiMo TTS target:
 *   { model, voiceType, userContent, audio, needsReference }
 *
 * voiceType ∈ preset | voicedesign | voiceclone — the style-channel decision
 * (applyStyle) keys off it. Mirrors dsh-voice-mimo's voice_speak semantics:
 * preset → mimo-v2.5-tts with audio.voice; voicedesign → -voicedesign with
 * optimize_text_preview; voiceclone → -voiceclone, needs a reference audio.
 *
 * `voiceMap` is caller-owned (the voice-mimo Settings migration lives in
 * #4): entries may carry { model, type: 'voicedesign', voice } or
 * { model: '<...tts-voiceclone>' }. An unmapped non-preset name is treated
 * as a voicedesign description.
 */
export function resolveTtsTarget(cfg, voiceMap, voiceName) {
  const mapped = voiceMap?.[voiceName]
  const mappedModel = mapped?.model || ''
  if (mappedModel.includes('voiceclone')) {
    return {
      model: mappedModel,
      voiceType: 'voiceclone',
      userContent: 'Use this reference voice to speak the following text naturally.',
      audio: { format: 'wav' },
      needsReference: true,
    }
  }
  if (mapped !== undefined && mapped.type === 'voicedesign') {
    return {
      model: mapped.model || 'mimo-v2.5-tts-voicedesign',
      voiceType: 'voicedesign',
      userContent: mapped.voice,
      audio: { format: 'wav', optimize_text_preview: true },
      needsReference: false,
    }
  }
  // A bare non-preset name is a voicedesign description (mirrors the
  // mimo_tts tool semantics in index.js); the mimo_default fallback for a
  // missing voice happens at the speak() level, not here.
  const preset = mapped !== undefined ? mapped.voice : voiceName
  if (!PRESET_VOICES.has(preset)) {
    return {
      model: mapped?.model || 'mimo-v2.5-tts-voicedesign',
      voiceType: 'voicedesign',
      userContent: preset,
      audio: { format: 'wav', optimize_text_preview: true },
      needsReference: false,
    }
  }
  return {
    model: mapped?.model || cfg?.model || 'mimo-v2.5-tts',
    voiceType: 'preset',
    userContent: 'Speak the following text naturally.',
    audio: { format: 'wav', voice: preset },
    needsReference: false,
  }
}

/**
 * Apply the style/sing decisions to one TTS request:
 * - preset / voiceclone → the style rides the USER message (voiceclone
 *   appends so the clone directive survives).
 * - voicedesign → the user message is owned by the voice description, so
 *   the style moves to an inline tag prefix `(style)` on the assistant text.
 * - sing → a bare `(唱歌)` prefix; preset-only (verified: a combined
 *   bracket drifts the model into reading instead of singing).
 * Returns { userContent, text }.
 */
export function applyStyle({ style, sing, voiceType, userContent, text }) {
  const s = typeof style === 'string' ? style.trim() : ''
  let nextUser = userContent
  let nextText = String(text ?? '')
  if (sing === true) {
    if (voiceType !== 'preset') {
      throw new Error(`singing requires a preset voice (mimo-v2.5-tts); the resolved voice type is ${voiceType}`)
    }
    nextText = `(唱歌)${nextText}`
  } else if (s) {
    if (voiceType === 'voicedesign') {
      nextText = `(${s})${nextText}`
    } else if (voiceType === 'voiceclone') {
      nextUser = nextUser ? `${nextUser} ${s}` : s
    } else {
      nextUser = s
    }
  }
  return { userContent: nextUser, text: nextText }
}

/** True for data: and http(s): URLs — those pass through unwrapped. */
export const isDataOrHttpUrl = (s) => /^(data:|https?:\/\/)/.test(s)

/** Infer the voice channel from a MiMo TTS model id (regenerate replay). */
export function voiceTypeOf(model) {
  const m = String(model || '')
  if (m.includes('voiceclone')) return 'voiceclone'
  if (m.includes('voicedesign')) return 'voicedesign'
  return 'preset'
}

/**
 * Wrap audio bytes into a data URL. Accepts a base64 string or a
 * Buffer/Uint8Array. Used for ASR input_audio and voiceclone references —
 * both travel inside the JSON body (fetch has no stdout cap).
 */
export function toDataUrl(input, mime = 'audio/wav') {
  const b64 = typeof input === 'string' && !isDataOrHttpUrl(input)
    ? input
    : Buffer.from(input).toString('base64')
  return `data:${mime};base64,${b64}`
}

/**
 * Create a MiMo TTS/ASR client. apiKey is required (plain string — the
 * caller decides how it is resolved); baseUrl and fetchImpl are optional.
 */
export function createMiMoClient({ baseUrl = DEFAULT_BASE_URL, apiKey, fetchImpl } = {}) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const doFetch = fetchImpl ?? globalThis.fetch

  async function post(payload, timeoutMs, label) {
    let response
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new Error(`MiMo ${label} request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`MiMo ${label} HTTP ${response.status}: ${text.slice(0, 400)}`)
    }
    return await response.json()
  }

  /**
   * Synthesize speech. Returns { bytes: Buffer, mime, truncated }.
   * - voice: preset id, free-form voicedesign description, or a voiceMap key
   * - voiceMap: caller-owned map (see resolveTtsTarget)
   * - model: optional override for the preset-TTS model (default
   *   mimo-v2.5-tts); voiceMap entries may also carry their own model
   * - reference: REQUIRED for voiceclone voices — a data URL (or
   *   base64/Buffer + referenceMime) of the short reference clip
   * - style / sing: see applyStyle; format: 'wav' (default) | 'mp3'
   */
  async function speak({ voice, text, voiceMap, model, reference, referenceMime = 'audio/wav', style, sing, format = 'wav', timeoutMs = 120000 }) {
    const target = resolveTtsTarget({ model }, voiceMap, voice ?? 'mimo_default')
    const cut = truncateTtsText(text)
    let { userContent, text: bodyText } = applyStyle({
      style, sing, voiceType: target.voiceType, userContent: target.userContent, text: cut.text,
    })
    const audio = { ...target.audio, format: format === 'mp3' ? 'mp3' : 'wav' }
    if (target.needsReference) {
      if (reference === undefined || reference === null || reference === '') {
        throw new Error(`voice "${voice}" is a voiceclone target and requires a reference clip`)
      }
      audio.voice = typeof reference === 'string' && isDataOrHttpUrl(reference)
        ? reference
        : toDataUrl(reference, referenceMime)
    }
    const data = await post({
      model: target.model,
      messages: [
        { role: 'user', content: userContent },
        { role: 'assistant', content: bodyText },
      ],
      audio,
    }, timeoutMs, 'TTS')
    const base64 = data?.choices?.[0]?.message?.audio?.data
    if (typeof base64 !== 'string' || base64.length === 0) {
      throw new Error('MiMo TTS returned no audio data')
    }
    return { bytes: Buffer.from(base64, 'base64'), mime: `audio/${format === 'mp3' ? 'mpeg' : 'wav'}`, truncated: cut.truncated }
  }

  /**
   * Post one ALREADY-RESOLVED TTS request (target + style + truncation decided
   * by the caller — the web routes / mimo_tts store mode reproduce
   * manifest-recorded requests verbatim, so they must not re-resolve).
   * Returns { bytes, mime }.
   */
  async function speakResolved({ model, userContent, text, audio, timeoutMs = 60000 }) {
    const data = await post({
      model,
      messages: [
        { role: 'user', content: userContent },
        { role: 'assistant', content: text },
      ],
      audio,
    }, timeoutMs, 'TTS')
    const base64 = data?.choices?.[0]?.message?.audio?.data
    if (typeof base64 !== 'string' || base64.length === 0) {
      throw new Error('MiMo TTS returned no audio data')
    }
    const fmt = audio?.format === 'mp3' ? 'mpeg' : 'wav'
    return { bytes: Buffer.from(base64, 'base64'), mime: `audio/${fmt}` }
  }

  /**
   * Transcribe audio to text with mimo-v2.5-asr. `audio` is a base64
   * string, a data URL/HTTP URL (passed through as-is), or raw bytes +
   * mimeType (default audio/wav). Returns { text }.
   */
  async function transcribe({ audio, mimeType = 'audio/wav', language, timeoutMs = 120000 }) {
    if (audio === undefined || audio === null || audio === '') {
      throw new Error('transcribe requires audio (base64, data URL, or bytes)')
    }
    const data_url = typeof audio === 'string' && isDataOrHttpUrl(audio)
      ? audio
      : toDataUrl(audio, mimeType)
    const payload = {
      model: 'mimo-v2.5-asr',
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: data_url } }] }],
      stream: false,
    }
    if (typeof language === 'string' && language.trim() !== '') payload.asr_options = { language }
    const data = await post(payload, timeoutMs, 'ASR')
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('MiMo ASR returned no transcript text')
    return { text: content.trim() }
  }

  return { speak, speakResolved, transcribe, url }
}
