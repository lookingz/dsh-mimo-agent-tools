// dsh-mimo-agent-tools — Xiaomi MiMo search + multimodal tools + voice UI host.
// Installed as a DSH bundle (`dsh plugin --profile <name> add .`).
// Registers mimo_search / mimo_vision / mimo_audio / mimo_video / mimo_asr /
// mimo_tts / mimo_voiceclone as model tools, plus (since #4, docs/adr/0001)
// the host half of the merged voice UI: 🔊 read-aloud + speech-strip web
// routes (web.js) over the audio store (audio-store.js), configured through
// the plugin Config (Plugins settings tab).
//
// The API key is resolved from the DSH credentials service (key
// XIAOMI_API_KEY, written by the web Models page). The python driver path is
// shell-expanded (${MIMO_DRIVER:-$HOME/.local/lib/...}) because the plugin
// sandbox has no process.env. Large base64 payloads are handled entirely
// inside the python driver to dodge the 64KB shell stdout cap; the UI/store
// routes use the ./mimo client (node fetch — no cap) instead.
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  cleanTmp, cleanupSessionArtifacts, enforceLongRetention, initAudioStore,
  manifestAppend, newAudioId, planSpeechArtifact, resolveAudioDir, wavDurationSeconds,
} from './audio-store.js'
import { createMiMoClient, resolveTtsTarget } from './mimo.js'
import { installMimoWeb, DEFAULT_STYLE as UI_DEFAULT_STYLE } from './web.js'

export const name = 'dsh-mimo-agent-tools'
export const inject = ['tools', 'shell', 'sandboxPolicy', 'credentials', 'skills']

/** Default style for 🔊 read-aloud and mimo_tts store mode (朗读语气). */
export const DEFAULT_TTS_STYLE = UI_DEFAULT_STYLE

/** Default voice map: OpenAI voice names → MiMo presets (Plugins settings tab editable). */
export const DEFAULT_VOICE_MAP = {
  alloy: { type: 'preset', voice: '冰糖' },
  echo: { type: 'preset', voice: '苏打' },
  fable: { type: 'preset', voice: '茉莉' },
  onyx: { type: 'preset', voice: '白桦' },
  nova: { type: 'preset', voice: 'Mia' },
  shimmer: { type: 'preset', voice: 'mimo_default' },
}

const voiceMapSchema = z.dict(
  z.object({
    type: z.union([z.const('preset'), z.const('voicedesign')]).required(),
    /** MiMo preset ID when type=preset; free-form Chinese voice description when type=voicedesign. */
    voice: z.string().required(),
    /**
     * Optional model override. Empty = inferred from type
     * (preset → mimo-v2.5-tts, voicedesign → mimo-v2.5-tts-voicedesign).
     * Set it to route this voice through mimo-v2.5-tts-voiceclone for a
     * cloned timbre (needs a reference clip at call time).
     */
    model: z.string().default(''),
  }),
)

/**
 * Plugin Config — surfaced through the alpha.1 Plugins settings tab
 * (SettingsForms projection, settings.plugins.tab). Replaces the retired
 * voice-mimo custom Settings page + settings namespace shim.
 */
export const Config = z.object({
  /** MiMo provider: base URL and DSH Credential reference. */
  provider: z
    .object({
      baseUrl: z.string().default('https://api.xiaomimimo.com/v1'),
      credential: z.string().default('XIAOMI_API_KEY'),
    })
    .default({}),
  /** Voice map: OpenAI voice name → MiMo preset or voice design. */
  voiceMap: voiceMapSchema.default(DEFAULT_VOICE_MAP),
  /** Audio output storage: layered tmp/ + long/ under audioDir. */
  audio: z
    .object({
      /** Root of the audio subtree. Empty = <dshHome>/cache/dsh-mimo-agent-tools. */
      dir: z.string().default(''),
      /** Inline-vs-card threshold (seconds) for in-conversation speech strips. */
      inlineThreshold: z.number().min(1).default(30),
      /** Loose long-term retention fallback. */
      longRetainCount: z.number().min(1).default(200),
      longRetainDays: z.number().min(1).default(30),
    })
    .default({}),
  /** 🔊 read-aloud + mimo_tts store mode defaults. */
  tts: z
    .object({
      model: z.string().default('mimo-v2.5-tts'),
      format: z.string().default('wav'),
      timeoutMs: z.number().min(1).default(60000),
      /** Read-aloud voice: a voiceMap key (default alloy→冰糖). */
      voice: z.string().default('alloy'),
      /** Read-aloud style (朗读语气), default 温柔. */
      style: z.string().default(DEFAULT_TTS_STYLE),
    })
    .default({}),
})

let currentConfig = {}

/** Fill Config defaults by hand (schemastery z.object has no .parse). */
function safeConfigOf(raw) {
  const c = raw ?? {}
  const provider = c.provider ?? {}
  const audio = c.audio ?? {}
  const tts = c.tts ?? {}
  return {
    provider: {
      baseUrl: provider.baseUrl || 'https://api.xiaomimimo.com/v1',
      credential: provider.credential || 'XIAOMI_API_KEY',
    },
    voiceMap: c.voiceMap ?? DEFAULT_VOICE_MAP,
    audio: {
      dir: audio.dir ?? '',
      inlineThreshold: audio.inlineThreshold ?? 30,
      longRetainCount: audio.longRetainCount ?? 200,
      longRetainDays: audio.longRetainDays ?? 30,
    },
    tts: {
      model: tts.model || 'mimo-v2.5-tts',
      format: tts.format ?? 'wav',
      timeoutMs: tts.timeoutMs ?? 60000,
      voice: tts.voice || 'alloy',
      style: (tts.style && tts.style.trim()) || DEFAULT_TTS_STYLE,
    },
  }
}

/** Live plugin Config getter (web routes read per request). */
const getConfig = () => currentConfig

/**
 * Default model for mimo_audio (audio understanding). Migrated from
 * mimo-v2.5 (offline 2026-10-21 10:00 UTC+8, absorbed from dsh-voice-mimo
 * #15). The ASR (mimo-v2.5-asr) and TTS (mimo-v2.5-tts/-voicedesign/
 * -voiceclone) lines stay current — only audio understanding moves.
 */
export const DEFAULT_AUDIO_MODEL = 'mimo-v2.6'

/**
 * Shared MiMo runtime: shell pipeline (Git Bash routing, python driver spec
 * files), credential resolution, and the runDriver call every MiMo API
 * request goes through. Extracted to module scope so sibling plugin entries
 * (speech.js — the official speechToText provider) reuse the exact same
 * pipeline as the agent tools instead of duplicating it.
 */
export function createRuntime(ctx) {
  const BASE_URL = 'https://api.xiaomimimo.com/v1'
  // Windows port (2026-09-29): run shell work through a POSIX bash — MSYS2 or Git for
  // Windows — which supplies the printf/base64/curl/wc/rm/mktemp toolchain and a real /tmp
  // this plugin was written against, and whose msys path mangling converts /c/... arguments
  // for the native python.exe. Their `python` is the user's Python; `python3` is the
  // WindowsApps stub, so PY is used everywhere below. MIMO_BASH overrides the discovery.
  const ENV = typeof process === 'undefined' ? {} : (process.env ?? {})
  const GIT_BASH = [
    ENV.MIMO_BASH,
    'C:/msys64/usr/bin/bash.exe',
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
    ENV.LOCALAPPDATA === undefined ? undefined : `${ENV.LOCALAPPDATA}/Programs/Git/bin/bash.exe`,
  ].find((candidate) => candidate !== undefined && candidate !== '' && existsSync(candidate))
  const PY = 'python'
  const msysPathOf = (p) => {
    const s = String(p).replace(/\\/g, '/')
    return /^[A-Za-z]:\//.test(s) ? '/' + s[0].toLowerCase() + s.slice(2) : s
  }
  const DRIVER_SPEC = '${MIMO_DRIVER:-' + msysPathOf(fileURLToPath(new URL('./driver/mimo_driver.py', import.meta.url))) + '}'
  const TMP_ROOT = '/tmp'
  const KEY_REF = 'XIAOMI_API_KEY'
  const PRESET_VOICES = new Set(['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'])

  // UTF-8-safe base64: Node's b64() rejects non-Latin-1 (Chinese TTS text
  // would throw "Invalid character"). Encode via TextEncoder + bytes first.
  function b64(s) {
    const bytes = new TextEncoder().encode(String(s))
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin)
  }

  function shq(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'"
  }
  function wslPathOf(path) {
    // Git Bash form (C:\\Work\\x -> /c/Work/x): bash builtins accept it directly and
    // MSYS converts it back for native executables such as python.exe.
    return /^([A-Za-z]):[\\/]/.test(path) ? '/' + path[0].toLowerCase() + path.slice(2).replace(/\\/g, '/') : String(path).replace(/\\/g, '/')
  }
  function winPathOf(path) {
    // Windows form (C:\\Work\\x -> C:/Work/x) for paths that travel INSIDE the
    // driver spec JSON: MSYS converts only argv paths, never file contents,
    // so native python.exe cannot open a /c/... path found inside the spec
    // (reproduced: FileNotFoundError -> "no response"). Shell-side and argv
    // references keep the /c/ form via wslPathOf.
    return String(path).replace(/\\/g, '/')
  }
  function mimeOf(path) {
    // Strip query/fragment so a URL like https://x/a.mp3?token=1 resolves.
    const p = String(path).split(/[?#]/)[0].toLowerCase()
    const map = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.bmp': 'image/bmp', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
      '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4',
      '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4'
    }
    for (const [ext, mime] of Object.entries(map)) if (p.endsWith(ext)) return mime
    return 'application/octet-stream'
  }
  async function run(command, exec, opts = {}) {
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const policy = sandboxPolicy === undefined ? undefined : sandboxPolicy.resolve(
      exec !== undefined && exec.agent !== undefined ? { session: exec.agent.session } : {}
    )
    const shell = ctx.get('shell')
    // Route through Git Bash so POSIX pipelines, /tmp and ${VAR:-default} resolve on Windows.
    const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'"
    // The seam may already BE a POSIX bash (the profile's msys-bash executor); wrap only
    // when the host shell is not POSIX (the PowerShell implementation).
    const shellName = String(shell?.constructor?.name ?? '')
    const posixShell = /bash|(^|\b)sh\b/i.test(shellName)
    const effective = GIT_BASH === undefined || posixShell ? command : `& ${psq(GIT_BASH)} -lc ${psq(command)}`
    const request = {
      command: effective,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
      ...(exec !== undefined && exec.signal !== undefined ? { signal: exec.signal } : {})
    }
    // DSH 0.2.0: shell.run(spec) → shell.execute(spec) + execution.result()
    const execution = await shell.execute(shell.resolve(request))
    return await execution.result()
  }

  async function resolveKey() {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve(KEY_REF)
        if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) return resolved.value
      } catch {}
    }
    throw new Error(`${KEY_REF} is not configured — store it in the DSH credentials service (web Models page)`)
  }

  async function runDriver(spec, exec, timeoutMs = 120000) {
    const key = await resolveKey()
    const full = { url: BASE_URL + '/chat/completions', key, timeout: timeoutMs / 1000 | 0, ...spec }
    const specFile = `${TMP_ROOT}/mimo_spec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`
    const respFile = `${TMP_ROOT}/mimo_resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`
    const specJson = JSON.stringify(full)
    const cmd = `printf '%s' ${shq(b64(specJson))} | base64 -d > ${shq(specFile)} && ${PY} ${DRIVER_SPEC} ${shq(specFile)} ${shq(respFile)}`
    const r = await run(cmd, exec, { timeoutMs: timeoutMs + 20000 })
    const status = r.stdout.text.trim()
    let respText = null
    try { respText = (await run(`cat ${shq(respFile)}`, exec, { timeoutMs: 10000 })).stdout.text } catch {}
    await run(`rm -f ${shq(specFile)} ${shq(respFile)}`, exec, { timeoutMs: 5000 }).catch(() => {})
    if (status === 'OK') {
      try {
        const data = JSON.parse(respText.trim())
        // Normalize API-level errors (d.error) once here so every tool's
        // execute is just `if (!res.ok) return res`.
        if (data?.error !== undefined) {
          return { ok: false, error: typeof data.error === 'string' ? data.error : data.error.message ?? 'API error' }
        }
        return { ok: true, data }
      } catch { return { ok: false, error: 'unparseable API response' } }
    }
    const t = (respText || '').trim()
    if (t.startsWith('HTTP_ERR:')) {
      const rest = t.slice(9)
      try {
        const e = JSON.parse(rest).error
        return { ok: false, error: (typeof e.message === 'string' ? e.message : '') + (e.param ? ` (${e.param})` : '') }
      } catch { return { ok: false, error: rest.slice(0, 400) } }
    }
    if (t.startsWith('NET_ERR:')) return { ok: false, error: t.slice(8) }
    return { ok: false, error: (t || 'no response').slice(0, 400) }
  }

  return { BASE_URL, TMP_ROOT, KEY_REF, PRESET_VOICES, b64, shq, wslPathOf, winPathOf, msysPathOf, mimeOf, run, resolveKey, runDriver }
}

export async function apply(ctx, config) {
  const { PRESET_VOICES, shq, wslPathOf, winPathOf, mimeOf, run, resolveKey, runDriver } = createRuntime(ctx)
  currentConfig = safeConfigOf(config)

  const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  const renderText = (_a, v) => [{ type: 'text', text: typeof v.answer === 'string' ? v.answer : JSON.stringify(v, null, 2) }]
  const renderThink = (_a, v) => {
    const lines = []
    if (typeof v.reasoning === 'string' && v.reasoning.length > 0) {
      lines.push('<details><summary>Reasoning</summary>\n\n' + v.reasoning + '\n\n</details>')
    }
    lines.push(typeof v.answer === 'string' ? v.answer : JSON.stringify(v, null, 2))
    return [{ type: 'text', text: lines.join('\n\n') }]
  }

  /**
   * mimo_tts render: bare-file results keep the plain JSON summary; stored
   * results (store:true) add the machine envelope the ./client UI strip
   * parses (audioUrl/seconds/inline) as a second text block.
   */
  const renderTts = (args, value) => {
    const blocks = [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    if (value.audioUrl) {
      blocks.push({
        type: 'text',
        text: JSON.stringify({
          path: value.path,
          bytes: value.bytes,
          audioUrl: value.audioUrl,
          seconds: value.seconds,
          inline: value.inline,
        }),
      })
    }
    return blocks
  }

  /**
   * mimo_tts store mode (decision: explicit `store` flag; the default
   * file-writing behavior is untouched). Synthesizes through the shared
   * ./mimo client (node fetch — no 64KB shell cap), lands the artifact in
   * audioDir/long/ + manifest, and returns the strip envelope. The manifest
   * record {text, voice, model, style, sing} is what POST /regenerate
   * replays. Applies the Config tts.style default through the shared
   * applyStyle mixed channel; resolves the voice through the Config voiceMap.
   */
  async function storeSpeak(args, exec) {
    const cfg = currentConfig
    const tts = cfg.tts ?? {}
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (text.trim().length === 0) return { ok: false, error: 'text is required' }
    const style = (typeof args.style === 'string' && args.style.trim()) ? args.style.trim() : tts.style || DEFAULT_TTS_STYLE
    const client = createMiMoClient({
      baseUrl: (cfg.provider?.baseUrl || 'https://api.xiaomimimo.com/v1'),
      apiKey: await resolveKey(),
    })
    let bytes
    let target
    try {
      target = resolveTtsTarget(tts, cfg.voiceMap ?? {}, args.voice || tts.voice || 'alloy')
      // The client applies the style (mixed channel), truncates, and handles
      // the voiceclone reference — single transport for every TTS caller.
      const out = await client.speak({
        voice: args.voice || tts.voice || 'alloy',
        voiceMap: cfg.voiceMap ?? {},
        text,
        style,
        sing: args.sing === true,
        reference: args.reference,
        format: args.format === 'mp3' ? 'mp3' : (tts.format || 'wav'),
        timeoutMs: tts.timeoutMs || 60000,
      })
      bytes = out.bytes
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const audioDir = resolveAudioDir(cfg, resolveDshHome())
    const plan = planSpeechArtifact({
      audioDir,
      id: newAudioId(),
      text,
      voice: args.voice || tts.voice || 'alloy',
      model: target.model,
      style,
      sing: args.sing === true,
      // agent.id is the branded SessionId (the whole agent.session object is
      // the live session, not its identifier).
      sessionId: exec?.agent?.id ?? null,
      callId: exec?.callId ?? null,
    })
    await initAudioStore(audioDir)
    await writeFile(plan.path, bytes)
    await manifestAppend(audioDir, plan.manifest)
    await enforceLongRetention(audioDir, {
      count: cfg.audio?.longRetainCount ?? 200,
      days: cfg.audio?.longRetainDays ?? 30,
    })
    const seconds = wavDurationSeconds(bytes)
    const result = {
      ok: true,
      path: plan.path,
      bytes: bytes.length,
      audioUrl: `/_dsh/mimo-agent-tools/audio/${plan.manifest.id}`,
      style,
    }
    if (seconds > 0) {
      result.seconds = Math.round(seconds * 10) / 10
      result.inline = !(seconds > (cfg.audio?.inlineThreshold ?? 30))
    }
    return result
  }

  const tools = [
    {
      name: 'mimo_search',
      description: 'Search the web through the Xiaomi MiMo native web_search tool (mimo-v2.5-pro). Returns a model-written answer plus cited sources (url/title/snippet/publishedAt). Use for current events, news, prices, facts, and any query needing fresh web information.',
      parameters: {
        query: { type: 'string', required: true, description: 'The search query' },
        max_keyword: { type: 'integer', description: 'Max keywords per search round (default 3, cost control)' },
        limit: { type: 'integer', description: 'Max citations returned (default 5)' },
        force_search: { type: 'boolean', description: 'Force a fresh web search instead of allowing cached results (default true)' },
        user_location: { type: 'object', additionalProperties: true, description: 'Approximate user location to bias results, e.g. {"type":"approximate","country":"China","region":"Hubei","city":"Wuhan"}' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const key = await resolveKey()
        const maxKeyword = args.max_keyword !== undefined ? args.max_keyword : 3
        const limit = args.limit !== undefined ? args.limit : 5
        const tool = { type: 'web_search', max_keyword: maxKeyword, force_search: args.force_search !== undefined ? args.force_search : true, limit }
        if (args.user_location !== undefined && args.user_location !== null) tool.user_location = args.user_location
        const body = {
          model: 'mimo-v2.5-pro',
          messages: [{ role: 'user', content: `Perform a web search for the query: ${args.query}` }],
          max_completion_tokens: 1024,
          stream: false,
          thinking: { type: 'disabled' },
          tools: [tool]
        }
        const json = JSON.stringify(body)
        const cmd = `curl -s --max-time 60 --location '${BASE_URL}/chat/completions' -H 'api-key: ${key}' -H 'Content-Type: application/json' -d ${shq(json)}`
        const r = await run(cmd, exec, { timeoutMs: 70000 })
        let data = null
        let parseError = null
        const out = r.stdout.text.trim()
        if (out) { try { data = JSON.parse(out) } catch { parseError = out.slice(0, 400) } }
        if (data === null) return { ok: false, error: parseError || 'no response', stderr: r.stderr.text.trim().slice(0, 400) }
        if (data.error !== undefined) return { ok: false, error: typeof data.error === 'string' ? data.error : data.error.message }
        const msg = data.choices?.[0]?.message
        const content = typeof msg?.content === 'string' && msg.content.length > 0 ? msg.content : null
        const seen = new Set()
        const sources = []
        for (const ann of msg?.annotations ?? []) {
          if (ann?.type !== 'url_citation' || typeof ann.url !== 'string' || ann.url.length === 0) continue
          if (seen.has(ann.url)) continue
          seen.add(ann.url)
          sources.push({
            url: ann.url,
            ...(typeof ann.title === 'string' && ann.title.length > 0 ? { title: ann.title } : {}),
            ...(typeof ann.summary === 'string' && ann.summary.length > 0 ? { snippet: ann.summary } : {}),
            ...(typeof ann.publish_time === 'string' && ann.publish_time.length > 0 ? { publishedAt: ann.publish_time } : {}),
            ...(typeof ann.site_name === 'string' && ann.site_name.length > 0 ? { site_name: ann.site_name } : {}),
            ...(typeof ann.logo_url === 'string' && ann.logo_url.length > 0 ? { logo_url: ann.logo_url } : {})
          })
        }
        return { ok: true, query: args.query, answer: content, sources, usage: data.usage ?? null }
      }
    },
    {
      name: 'mimo_think',
      description: 'Deep reasoning with the Xiaomi MiMo deep-thinking mode (mimo-v2.5-pro). The model works through the problem step by step before answering; the response carries both the full reasoning chain (reasoning_content) and the final answer. Use for complex reasoning, code generation, math, multi-step analysis, and any task where a plain answer risks missing a step.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'The question or problem to reason about' },
        model: { type: 'string', description: 'Model (default mimo-v2.5-pro; mimo-v2.5 also supports deep thinking)' }
      },
      output: { schema: { type: 'json' }, render: renderThink },
      async execute(args, exec) {
        const res = await runDriver({ model: args.model || 'mimo-v2.5-pro', kind: 'think', prompt: args.prompt }, exec)
        if (!res.ok) return { ok: false, error: res.error }
        const d = res.data
        const msg = d.choices?.[0]?.message
        return {
          ok: true,
          reasoning: typeof msg?.reasoning_content === 'string' && msg.reasoning_content.length > 0 ? msg.reasoning_content : null,
          answer: typeof msg?.content === 'string' && msg.content.length > 0 ? msg.content : null,
          usage: d.usage ?? null
        }
      }
    },
    {
      name: 'mimo_json',
      description: 'Structured JSON output from the Xiaomi MiMo model (mimo-v2.5-pro / mimo-v2.5) via response_format json_object. Describe the exact JSON structure you need (fields, types, nesting, an example) in the prompt; the model returns only valid JSON. Use when you need machine-parseable structured data, not prose.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'What to compute, plus the exact JSON structure required (fields, types, nesting; an example helps)' },
        model: { type: 'string', description: 'Model (default mimo-v2.5-pro; mimo-v2.5 also supports structured output)' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const res = await runDriver({ model: args.model || 'mimo-v2.5-pro', kind: 'json', prompt: args.prompt }, exec)
        if (!res.ok) return { ok: false, error: res.error }
        const d = res.data
        const content = d.choices?.[0]?.message?.content ?? null
        let data = null
        if (typeof content === 'string' && content.length > 0) {
          try { data = JSON.parse(content) } catch { data = content }
        }
        return { ok: true, data, usage: d.usage ?? null }
      }
    },
    {
      name: 'mimo_vision',
      description: 'Analyze one or more images with the Xiaomi MiMo vision model (mimo-v2.5). Accepts local file paths (Windows C:\\... or WSL /mnt/...) which are base64-encoded automatically, or public image URLs. Supports JPEG/PNG/GIF/WebP/BMP.',
      parameters: {
        images: { type: 'array', required: true, items: { type: 'string' }, description: 'Local file paths or public URLs of images to analyze' },
        prompt: { type: 'string', required: true, description: 'What to ask about the image(s)' }
      },
      output: { schema: { type: 'json' }, render: renderText },
      async execute(args, exec) {
        const locals = []
        const urls = []
        for (const img of args.images) {
          if (/^https?:\/\//.test(img) || /^data:/.test(img)) urls.push(img)
          else locals.push({ kind: 'image', mime: mimeOf(img), path: winPathOf(img) })
        }
        const res = await runDriver({ model: 'mimo-v2.5', kind: 'vision', files: locals, urls, prompt: args.prompt }, exec)
        if (!res.ok) return { ok: false, error: res.error }
        const d = res.data
        return { ok: true, answer: d.choices?.[0]?.message?.content ?? null, usage: d.usage ?? null }
      }
    },
    {
      name: 'mimo_audio',
      description: 'Analyze audio content with the Xiaomi MiMo model (mimo-v2.6). Accepts a local file path (Windows or WSL path; auto base64) or a public URL. Supports wav/mp3/flac/ogg/m4a.',
      parameters: {
        audio: { type: 'string', required: true, description: 'Local audio file path or public URL' },
        prompt: { type: 'string', description: 'What to do with the audio (default: transcribe)' }
      },
      output: { schema: { type: 'json' }, render: renderText },
      async execute(args, exec) {
        const isUrl = /^https?:\/\//.test(args.audio) || /^data:/.test(args.audio)
        const res = await runDriver({
          model: DEFAULT_AUDIO_MODEL, kind: 'audio',
          files: isUrl ? [] : [{ kind: 'audio', mime: mimeOf(args.audio), path: winPathOf(args.audio) }],
          urls: isUrl ? [args.audio] : [],
          prompt: args.prompt || 'Please transcribe the audio content.'
        }, exec)
        if (!res.ok) return { ok: false, error: res.error }
        const d = res.data
        return { ok: true, answer: d.choices?.[0]?.message?.content ?? null, usage: d.usage ?? null }
      }
    },
    {
      name: 'mimo_video',
      description: 'Analyze video content with the Xiaomi MiMo model (mimo-v2.5). Accepts a local video file path (Windows or WSL path; auto base64) or a public URL. Supports mp4/webm/mov.',
      parameters: {
        url: { type: 'string', required: true, description: 'Local video file path or public URL (mp4/webm/mov)' },
        prompt: { type: 'string', description: 'What to ask about the video (default: describe)' },
        fps: { type: 'integer', description: 'Frame sampling rate for analysis (e.g. 1, 2). Lower = cheaper/faster, higher = more detail. Optional.' },
        media_resolution: { type: 'string', description: 'Resolution sent to the model (e.g. "default", "480p", "720p"). Optional.' }
      },
      output: { schema: { type: 'json' }, render: renderText },
      async execute(args, exec) {
        const isUrl = /^https?:\/\//.test(args.url) || /^data:/.test(args.url)
        const res = await runDriver({
          model: 'mimo-v2.5', kind: 'video',
          files: isUrl ? [] : [{ kind: 'video', mime: mimeOf(args.url), path: winPathOf(args.url) }],
          urls: isUrl ? [args.url] : [],
          prompt: args.prompt || 'Please describe the video content.',
          fps: args.fps,
          media_resolution: args.media_resolution
        }, exec)
        if (!res.ok) return { ok: false, error: res.error }
        const d = res.data
        return { ok: true, answer: d.choices?.[0]?.message?.content ?? null, usage: d.usage ?? null }
      }
    },
    {
      name: 'mimo_asr',
      description: 'Speech-to-text with the Xiaomi MiMo ASR model (mimo-v2.5-asr). Accepts a local audio file path (Windows or WSL path; auto base64) or public URL. Supports wav/mp3.',
      parameters: {
        audio: { type: 'string', required: true, description: 'Local audio file path or public URL' },
        language: { type: 'string', description: 'Optional language code, e.g. zh, en' }
      },
      output: { schema: { type: 'json' }, render: renderText },
      async execute(args, exec) {
        const isUrl = /^https?:\/\//.test(args.audio) || /^data:/.test(args.audio)
        const res = await runDriver({
          model: 'mimo-v2.5-asr', kind: 'asr',
          files: isUrl ? [] : [{ kind: 'audio', mime: mimeOf(args.audio), path: winPathOf(args.audio) }],
          urls: isUrl ? [args.audio] : [],
          prompt: '',
          language: args.language
        }, exec)
        if (!res.ok) return { ok: false, error: res.error }
        const d = res.data
        return { ok: true, answer: d.choices?.[0]?.message?.content ?? null, usage: d.usage ?? null }
      }
    },
    {
      name: 'mimo_tts',
      description: 'Text-to-speech with the Xiaomi MiMo TTS models. Writes the synthesized audio to a Windows-side file (default C:\\Windows\\Temp\\mimo_tts_<ts>.wav). Voice: preset ID (mimo_default/冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean) or a free-form Chinese voice description (voicedesign).',
      parameters: {
        text: { type: 'string', required: true, description: 'Text to synthesize' },
        voice: { type: 'string', description: 'Preset voice ID or custom voice description (default mimo_default)' },
        output: { type: 'string', description: 'Output path on the Windows side (default C:\\Windows\\Temp\\mimo_tts_<ts>.wav)' },
        format: { type: 'string', description: 'Output audio format: wav (default) or mp3' },
        store: { type: 'boolean', description: 'Store the audio in the plugin audio store and render an in-conversation playable strip (play / download / regenerate) instead of writing a bare file. Voice/style defaults come from the plugin Config (Plugins settings tab).' },
        style: { type: 'string', description: 'Optional speaking style (语气): a natural-language instruction such as 温柔/沉稳/轻快, or a full director-style paragraph (角色/场景/指导). With preset voices the style becomes the user instruction; with voicedesign voices it becomes an inline (风格) tag prefix.' }
      },
      output: { schema: { type: 'json' }, render: renderTts },
      async execute(args, exec) {
        if (args.store === true) return storeSpeak(args, exec)
        const key = await resolveKey()
        const fmt = args.format === 'mp3' ? 'mp3' : 'wav'
        const outPath = args.output || `C:\\Windows\\Temp\\mimo_tts_${Date.now()}.${fmt}`
        const outWsl = '/mnt/c/Windows/Temp/' + outPath.split(/[\\/]/).pop()
        const voice = args.voice || 'mimo_default'
        const isPreset = PRESET_VOICES.has(voice)
        const model = isPreset ? 'mimo-v2.5-tts' : 'mimo-v2.5-tts-voicedesign'
        const style = typeof args.style === 'string' ? args.style.trim() : ''
        let userContent = isPreset ? (style || 'Speak the following text naturally.') : voice
        let text = args.text
        if (!isPreset && style) {
          // voicedesign owns the user message (the voice description), so the
          // style rides as an inline (风格) tag prefix — matches voice-mimo.
          text = `(${style})${text}`
        }
        const messages = []
        messages.push({ role: 'user', content: userContent })
        messages.push({ role: 'assistant', content: text })
        const audio = isPreset
          ? { format: fmt, voice }
          : { format: fmt, optimize_text_preview: true }
        const body = JSON.stringify({ model, messages, audio })
        const tmp = `${TMP_ROOT}/mimo_tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        const py = b64([
          'import json,sys,base64,urllib.request,urllib.error',
          'b=open(sys.argv[1],"rb").read()',
          'req=urllib.request.Request(sys.argv[2],data=b,headers={"api-key":sys.argv[3],"Content-Type":"application/json"})',
          'try:',
          '  r=urllib.request.urlopen(req,timeout=150)',
          '  open(sys.argv[4],"wb").write(r.read())',
          '  print("OK")',
          'except urllib.error.HTTPError as e:',
          '  print("HTTP_ERR:"+e.read().decode("utf-8","replace")[:500])',
          'except Exception as ex:',
          '  print("NET_ERR:"+str(ex)[:300])',
        ].join('\n'))
        const pyCmd = `${PY} -c 'import base64,sys; open(sys.argv[1],"wb").write(base64.b64decode(sys.stdin.read()))' ${shq(tmp + '.json')} <<'DSH_EOF'\n${b64(body)}\nDSH_EOF\nprintf '%s' ${py} | base64 -d | ${PY} - ${shq(tmp + '.json')} ${shq(BASE_URL + '/chat/completions')} ${shq(key)} ${shq(tmp + '.resp')}`
        const r = await run(pyCmd, exec, { timeoutMs: 200000 })
        const out = r.stdout.text.trim()
        if (!out.startsWith('OK')) {
          await run(`rm -f ${shq(tmp + '.json')} ${shq(tmp + '.resp')}`, exec, { timeoutMs: 5000 }).catch(() => {})
          return { ok: false, error: out.replace(/^(HTTP_ERR|NET_ERR):/, '') || 'TTS failed' }
        }
        const dec = b64([
          'import json,base64,sys',
          'd=json.load(open(sys.argv[1]))',
          'b=d["choices"][0]["message"]["audio"]["data"]',
          'open(sys.argv[2],"wb").write(base64.b64decode(b))',
        ].join('\n'))
        const decRun = await run(`printf '%s' ${dec} | base64 -d | ${PY} - ${shq(tmp + '.resp')} ${shq(outWsl)}`, exec, { timeoutMs: 30000 })
        await run(`rm -f ${shq(tmp + '.json')} ${shq(tmp + '.resp')}`, exec, { timeoutMs: 5000 }).catch(() => {})
        if (decRun.exitCode !== 0) return { ok: false, error: decRun.stderr.text.trim().slice(0, 300) }
        let bytes = 0
        try { bytes = Number((await run(`wc -c < ${shq(outWsl)}`, exec, { timeoutMs: 5000 })).stdout.text.trim()) || 0 } catch {}
        return { ok: true, output: outWsl, bytes }
      }
    },
    {
      name: 'mimo_voiceclone',
      description: 'Voice cloning with the Xiaomi MiMo voice-clone model (mimo-v2.5-tts-voiceclone). Given a reference audio file (wav/mp3, local path or public URL) and target text, synthesizes speech in the reference speaker\'s voice. The reference audio is sent as a data URL; keep it short (a few seconds is enough).',
      parameters: {
        text: { type: 'string', required: true, description: 'Text to synthesize in the cloned voice' },
        reference: { type: 'string', required: true, description: 'Reference audio path (local WSL/Windows path) or public URL — a short clip of the voice to clone' },
        output: { type: 'string', description: 'Output path on the Windows side (default C:\\Windows\\Temp\\mimo_voiceclone_<ts>.wav)' },
        format: { type: 'string', description: 'Output audio format: wav (default) or mp3' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const key = await resolveKey()
        const fmt = args.format === 'mp3' ? 'mp3' : 'wav'
        const outPath = args.output || `C:\\Windows\\Temp\\mimo_voiceclone_${Date.now()}.${fmt}`
        const outWsl = '/mnt/c/Windows/Temp/' + outPath.split(/[\\/]/).pop()
        const ref = String(args.reference)
        const refWsl = wslPathOf(ref)
        const isUrl = /^https?:\/\//i.test(ref)
        // Real MIME from the reference file extension — hardcoding audio/wav
        // misreports an mp3 reference to the API (which then rejects it).
        const refMime = mimeOf(ref)
        const tmp = `${TMP_ROOT}/mimo_vc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        // One python pass: read the reference audio (local file or URL), encode
        // it as a data URL, build the full request body in memory, POST to MiMo,
        // and write the raw response to a file. Everything stays on disk — the
        // reference audio base64 (~154KB for a 115KB clip) must never cross the
        // 64KB shell stdout cap that would truncate the data URL.
        const py = b64([
          'import sys,json,base64,urllib.request,urllib.error',
          'src,text,mime,fmt,api,url,out = sys.argv[1:8]',
          'b=urllib.request.urlopen(src,timeout=60).read() if src.startswith(("http://","https://")) else open(src,"rb").read()',
          'durl="data:%s;base64,"%mime+base64.b64encode(b).decode()',
          'payload={"model":"mimo-v2.5-tts-voiceclone","messages":[{"role":"user","content":"Use this reference voice to speak the following text naturally."},{"role":"assistant","content":text}],"audio":{"format":fmt,"voice":durl}}',
          'req=urllib.request.Request(url,data=json.dumps(payload).encode(),headers={"api-key":api,"Content-Type":"application/json"})',
          'try:',
          '  r=urllib.request.urlopen(req,timeout=180)',
          '  open(out,"wb").write(r.read())',
          '  print("OK")',
          'except urllib.error.HTTPError as e:',
          '  open(out,"wb").write(e.read())',
          '  print("HTTP_ERR")',
          'except Exception as ex:',
          '  open(out,"w").write("NET_ERR:"+str(ex)[:300])',
          '  print("NET_ERR")',
        ].join('\n'))
        const pyCmd = `printf '%s' ${py} | base64 -d | ${PY} - ${shq(isUrl ? ref : refWsl)} ${shq(args.text)} ${shq(refMime)} ${shq(fmt)} ${shq(key)} ${shq(BASE_URL + '/chat/completions')} ${shq(tmp + '.resp')}`
        const r = await run(pyCmd, exec, { timeoutMs: 220000 })
        const status = r.stdout.text.trim()
        await run(`rm -f ${shq(tmp + '.json')}`, exec, { timeoutMs: 5000 }).catch(() => {})
        if (!status.startsWith('OK')) {
          // On failure the response file may carry the HTTP error body; read it
          // through python (not cat) so a large body cannot hit the stdout cap.
          const errPy = b64([
            'import sys',
            'try: print(open(sys.argv[1],"rb").read().decode("utf-8","replace")[:400])',
            'except Exception: print("")',
          ].join('\n'))
          const errRun = await run(`printf '%s' ${errPy} | base64 -d | ${PY} - ${shq(tmp + '.resp')}`, exec, { timeoutMs: 10000 })
          const errText = (errRun.stdout.text || '').trim()
          await run(`rm -f ${shq(tmp + '.resp')}`, exec, { timeoutMs: 5000 }).catch(() => {})
          return { ok: false, error: errText.replace(/^(HTTP_ERR|NET_ERR):/, '') || status || 'voice clone failed' }
        }
        // Extract the base64 audio from the response JSON via python reading the
        // file directly — the audio data can be ~150KB, far beyond the 64KB
        // stdout cap, so `cat` would truncate it.
        const extractPy = b64([
          'import sys,json,base64',
          'try:',
          '  d=json.load(open(sys.argv[1],"rb"))',
          '  b=d["choices"][0]["message"]["audio"]["data"]',
          '  open(sys.argv[2],"wb").write(base64.b64decode(b))',
          '  print("OK")',
          'except Exception as ex:',
          '  print("ERR:"+str(ex)[:300])',
        ].join('\n'))
        const extractRun = await run(`printf '%s' ${extractPy} | base64 -d | ${PY} - ${shq(tmp + '.resp')} ${shq(outWsl)}`, exec, { timeoutMs: 30000 })
        await run(`rm -f ${shq(tmp + '.resp')}`, exec, { timeoutMs: 5000 }).catch(() => {})
        if (!extractRun.stdout.text.trim().startsWith('OK')) {
          return { ok: false, error: (extractRun.stdout.text.trim().replace(/^ERR:/, '') || 'failed to decode audio') }
        }
        let bytes = 0
        try { bytes = Number((await run(`wc -c < ${shq(outWsl)}`, exec, { timeoutMs: 5000 })).stdout.text.trim()) || 0 } catch {}
        return { ok: true, output: outWsl, bytes }
      }
    }
  ]

  for (const tool of tools) {
    ctx.tools.register(defineTool(tool))
  }

  // Voice UI host routes (🔊 read-aloud + audio streaming + regenerate +
  // archive cleanup) — the browser half is the ./client entry.
  installMimoWeb(ctx, getConfig)

  // audio-tools skill: guidance for the MiMo audio toolset (transcribe /
  // speak / voiceclone / understand). Registered synchronously, before any
  // await, so consumers reading apply()'s side effects without awaiting see
  // tools + routes + skill together. The tools themselves are always
  // registered — they are lightweight pure-API calls, unlike vision-toolkit's
  // ten schemas — so this skill only teaches when to use which, and notes
  // what each call sends to the MiMo API.
  const audioSkill = {
    name: 'audio-tools',
    description: 'MiMo audio tools: mimo_asr (transcribe), mimo_tts (speak), mimo_voiceclone (clone a voice), mimo_audio (understand audio content).',
    whenToUse: 'Use whenever a task involves audio: transcribing a recording, synthesizing speech, cloning a voice from a reference clip, or understanding the content of an audio file.',
    content: [
      '# audio-tools (MiMo edition)',
      '',
      'The Xiaomi MiMo audio tools turn a text-only agent into an audio-capable one. Use the native tools directly; the underlying API is Xiaomi MiMo, not OpenAI — the audio endpoints differ (no /audio/transcriptions or /audio/speech).',
      '',
      '## Tools',
      '',
      '- **mimo_asr** — transcribe an audio file (wav/mp3, local path or URL) to text with the MiMo ASR model. Optionally pass `language` (e.g. zh, en) for a hint.',
      '- **mimo_tts** — synthesize text into a .wav/.mp3 file. `voice` is a preset ID (mimo_default/冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean) or a free-form Chinese voice description (uses the voicedesign model). `style` adds a speaking tone; `format` picks wav (default) or mp3. Output lands on the Windows side (default C:\\Windows\\Temp). With `store: true` the audio goes to the plugin audio store instead and a playable strip (play/download/regenerate) appears in the conversation — use it when the speech is FOR the user in this conversation; voice/style then default to the plugin Config (朗读音色/朗读语气).',
      '- **mimo_voiceclone** — clone a voice: give a short reference audio clip (local path or URL) plus target text; output is speech in the reference speaker\'s voice. `format` picks wav (default) or mp3.',
      '- **mimo_audio** — understand the content of an audio file (wav/mp3/flac/ogg/m4a): summarize, extract information, or answer questions about what is said or played.',
      '',
      '## Usage notes',
      '',
      '- Inputs accept local paths (WSL `/home/...`, `/mnt/c/...` or Windows `C:\\...`) or public URLs.',
      '- TTS and voiceclone write .wav files to `C:\\Windows\\Temp` by default (`.mp3` with `format: "mp3"`); pass `output` to choose another Windows-side path.',
      '- For voice cloning, keep the reference clip short (a few seconds); the audio is sent to the MiMo API as a data URL.',
      '- These tools send audio to the Xiaomi MiMo API; do not use them for sensitive audio you cannot upload.',
    ].join('\n'),
  }
  try {
    ctx.skills.register(audioSkill)
  } catch (error) {
    // A duplicate or invalid registration must not take the plugin down.
    const logger = ctx.logger
    logger?.warn?.('dsh-mimo-agent-tools: audio-tools skill registration failed: %s', error instanceof Error ? error.message : String(error))
  }

  // Audio storage skeleton: create tmp/ + long/ under audioDir, clear the
  // previous process's tmp/ leftovers (idempotent), then run the startup
  // sweep — loose retention + archived-session long/ cleanup (#5 semantics).
  // This is the only await-ed part of apply(); everything above (tools,
  // routes, skill) registers synchronously.
  try {
    const audioDir = resolveAudioDir(currentConfig.audio, resolveDshHome())
    await initAudioStore(audioDir)
    await cleanTmp(audioDir)
    ctx.logger?.info?.(`[dsh-mimo-agent-tools] audioDir ready at ${audioDir} (tmp cleaned)`)
    try {
      const audio = currentConfig.audio ?? {}
      const retention = await enforceLongRetention(audioDir, {
        count: audio.longRetainCount ?? 200,
        days: audio.longRetainDays ?? 30,
      })
      if (retention.removed > 0) {
        ctx.logger?.info?.(`[dsh-mimo-agent-tools] retention removed ${retention.removed} long-term artifacts`)
      }
      const archived = ctx.workspaceRegistry?.archivedSessionIds ?? []
      for (const sessionId of archived) {
        const outcome = await cleanupSessionArtifacts(audioDir, sessionId)
        if (outcome.removed > 0) {
          ctx.logger?.info?.(`[dsh-mimo-agent-tools] startup sweep cleaned ${outcome.removed} artifact(s) of archived session ${sessionId}`)
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(
        `[dsh-mimo-agent-tools] startup sweep failed (retention/archived cleanup will retry on demand): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  } catch (error) {
    ctx.logger?.warn?.(
      `[dsh-mimo-agent-tools] audioDir init failed: ${error instanceof Error ? error.message : String(error)} — 🔊 read-aloud will retry per request`,
    )
  }
}
