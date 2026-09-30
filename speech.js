/**
 * dsh-mimo-agent-tools/speech — MiMo provider for the OFFICIAL dsh
 * speechToText seam (@deepseek-ai/dsh-experimental-speech-to-text).
 *
 * The official voice-input stack (browser 🎤 capture → Typert RPC →
 * host-side provider registry) stays untouched; this entry plugs Xiaomi
 * MiMo ASR (mimo-v2.5-asr) into it as a cloud provider, reusing the exact
 * shell/python-driver pipeline the agent tools run on (createRuntime from
 * index.js — no duplicated transport).
 *
 * Separate entry on purpose: `inject: ['speechToText', ...]` keeps this
 * fiber DORMANT on deployments without the experimental voice-input bundle
 * (a missing dependency deactivates the entry, not the whole package), so
 * the main dsh-mimo-agent-tools plugin keeps working everywhere.
 *
 * Default routing: cordis.patch.yml overrides the `speech-to-text` row's
 * defaultProvider to `mimo` — this bundle must compose AFTER
 * @deepseek-ai/dsh-experimental-voice-input-bundle in dsh.profile.bundles
 * (the override only lands on an already-inserted row).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from './index.js'

export const name = 'dsh-mimo-agent-tools/speech'
export const inject = ['speechToText', 'shell', 'sandboxPolicy', 'credentials']

/** Canonical-WAV duration in seconds (RIFF chunk walk; PCM/floating, any channel count). */
export function wavSeconds(audio) {
  const dv = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  if (audio.byteLength < 44 || dv.getUint32(0, false) !== 0x52494646 /* 'RIFF' */) return 0
  let offset = 12
  let byteRate = 0
  while (offset + 8 <= audio.byteLength) {
    const id = dv.getUint32(offset, false)
    const size = dv.getUint32(offset + 4, true)
    if (id === 0x666d7420 /* 'fmt ' */) byteRate = dv.getUint32(offset + 16, true)
    if (id === 0x64617461 /* 'data' */) return byteRate > 0 ? size / byteRate : 0
    offset += 8 + size + (size % 2)
  }
  return 0
}

/** Seam language hint ('', 'auto') → omit MiMo asr_options; otherwise passthrough. */
export function asrLanguage(language) {
  const lang = String(language ?? '').trim()
  return lang === '' || lang === 'auto' ? undefined : lang
}

export function apply(ctx) {
  const { runDriver, msysPathOf } = createRuntime(ctx)
  const speechToText = ctx.speechToText

  const provider = {
    info: {
      id: 'mimo',
      name: 'Xiaomi MiMo (mimo-v2.5-asr, cloud)',
      location: 'cloud',
      // MiMo ASR auto-detects by default and accepts explicit hints.
      languages: ['auto', 'zh', 'en'],
    },
    async transcribe(input, signal) {
      const started = Date.now()
      // The seam hands us canonical WAV bytes; park them in a temp file the
      // python driver can base64 (its spec takes local file paths in msys form).
      const dir = await mkdtemp(join(tmpdir(), 'mimo-stt-'))
      const wav = join(dir, 'audio.wav')
      try {
        await writeFile(wav, input.audio)
        const res = await runDriver({
          model: 'mimo-v2.5-asr',
          kind: 'asr',
          files: [{ kind: 'audio', mime: 'audio/wav', path: msysPathOf(wav) }],
          urls: [],
          prompt: '',
          language: asrLanguage(input.language),
          // exec-shape carrier: run() forwards exec.signal so an aborted
          // recording cancels the shell pipeline instead of running to timeout.
        }, { signal }, 110000)
        if (!res.ok) throw new Error(`MiMo ASR failed: ${res.error}`)
        const text = res.data?.choices?.[0]?.message?.content
        if (typeof text !== 'string') throw new Error('MiMo ASR returned no transcript text')
        return {
          text: text.trim(),
          audioSeconds: wavSeconds(input.audio),
          inferenceSeconds: (Date.now() - started) / 1000,
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    },
  }

  ctx.effect(() => speechToText.register(provider))
}
