// dsh-mimo-agent-tools — Xiaomi MiMo search + multimodal tools.
// Installed as a DSH bundle (`dsh plugin --profile <name> add .`).
// Registers mimo_search / mimo_vision / mimo_audio / mimo_video / mimo_asr /
// mimo_tts as model tools.
//
// The API key is resolved from the DSH credentials service (key
// XIAOMI_API_KEY, written by the web Models page). The python driver path is
// shell-expanded (${MIMO_DRIVER:-$HOME/.local/lib/...}) because the plugin
// sandbox has no process.env. Large base64 payloads are handled entirely
// inside the python driver to dodge the 64KB shell stdout cap.
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-mimo-agent-tools'
export const inject = ['tools', 'shell', 'sandboxPolicy', 'credentials', 'skills']

export function apply(ctx) {
  const BASE_URL = 'https://api.xiaomimimo.com/v1'
  const DRIVER_SPEC = '${MIMO_DRIVER:-$HOME/.local/lib/mimo-agent-tools/driver/mimo_driver.py}'
  const TMP_ROOT = '/tmp'
  const KEY_REF = 'XIAOMI_API_KEY'
  const PRESET_VOICES = new Set(['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dea'])

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
    return /^([A-Za-z]):[\\/]/.test(path) ? '/mnt/' + path[0].toLowerCase() + path.slice(2).replace(/\\/g, '/') : String(path).replace(/\\/g, '/')
  }
  function mimeOf(path) {
    const p = String(path).toLowerCase()
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
    const request = {
      command,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
      ...(exec !== undefined && exec.signal !== undefined ? { signal: exec.signal } : {})
    }
    return shell.run(shell.resolve(request))
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
    const cmd = `printf '%s' ${shq(b64(specJson))} | base64 -d > ${shq(specFile)} && python3 ${DRIVER_SPEC} ${shq(specFile)} ${shq(respFile)}`
    const r = await run(cmd, exec, { timeoutMs: timeoutMs + 20000 })
    const status = r.stdout.text.trim()
    let respText = null
    try { respText = (await run(`cat ${shq(respFile)}`, exec, { timeoutMs: 10000 })).stdout.text } catch {}
    await run(`rm -f ${shq(specFile)} ${shq(respFile)}`, exec, { timeoutMs: 5000 }).catch(() => {})
    if (status === 'OK') {
      try { return { ok: true, data: JSON.parse(respText.trim()) } } catch { return { ok: false, error: 'unparseable API response' } }
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

  const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  const renderText = (_a, v) => [{ type: 'text', text: typeof v.answer === 'string' ? v.answer : JSON.stringify(v, null, 2) }]

  const tools = [
    {
      name: 'mimo_search',
      description: 'Search the web through the Xiaomi MiMo native web_search tool (mimo-v2.5-pro). Returns a model-written answer plus cited sources (url/title/snippet/publishedAt). Use for current events, news, prices, facts, and any query needing fresh web information.',
      parameters: {
        query: { type: 'string', required: true, description: 'The search query' },
        max_keyword: { type: 'integer', description: 'Max keywords per search round (default 3, cost control)' },
        limit: { type: 'integer', description: 'Max citations returned (default 5)' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const key = await resolveKey()
        const maxKeyword = args.max_keyword !== undefined ? args.max_keyword : 3
        const limit = args.limit !== undefined ? args.limit : 5
        const body = {
          model: 'mimo-v2.5-pro',
          messages: [{ role: 'user', content: `Perform a web search for the query: ${args.query}` }],
          max_completion_tokens: 1024,
          stream: false,
          thinking: { type: 'disabled' },
          tools: [{ type: 'web_search', max_keyword: maxKeyword, force_search: true, limit }]
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
            ...(typeof ann.publish_time === 'string' && ann.publish_time.length > 0 ? { publishedAt: ann.publish_time } : {})
          })
        }
        return { ok: true, query: args.query, answer: content, sources, usage: data.usage ?? null }
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
          else locals.push({ kind: 'image', mime: mimeOf(img), path: wslPathOf(img) })
        }
        const res = await runDriver({ model: 'mimo-v2.5', kind: 'vision', files: locals, urls, prompt: args.prompt }, exec)
        if (!res.ok) return { ok: false, error: res.error }
        const d = res.data
        if (d.error !== undefined) return { ok: false, error: typeof d.error === 'string' ? d.error : d.error.message }
        return { ok: true, answer: d.choices?.[0]?.message?.content ?? null, usage: d.usage ?? null }
      }
    },
    {
      name: 'mimo_audio',
      description: 'Analyze audio content with the Xiaomi MiMo model (mimo-v2.5). Accepts a local file path (Windows or WSL path; auto base64) or a public URL. Supports wav/mp3/flac/ogg/m4a.',
      parameters: {
        audio: { type: 'string', required: true, description: 'Local audio file path or public URL' },
        prompt: { type: 'string', description: 'What to do with the audio (default: transcribe)' }
      },
      output: { schema: { type: 'json' }, render: renderText },
      async execute(args, exec) {
        const isUrl = /^https?:\/\//.test(args.audio) || /^data:/.test(args.audio)
        const res = await runDriver({
          model: 'mimo-v2.5', kind: 'audio',
          files: isUrl ? [] : [{ kind: 'audio', mime: mimeOf(args.audio), path: wslPathOf(args.audio) }],
          prompt: args.prompt || 'Please transcribe the audio content.'
        }, exec)
        if (!res.ok) return { ok: false, error: res.error }
        const d = res.data
        if (d.error !== undefined) return { ok: false, error: typeof d.error === 'string' ? d.error : d.error.message }
        return { ok: true, answer: d.choices?.[0]?.message?.content ?? null, usage: d.usage ?? null }
      }
    },
    {
      name: 'mimo_video',
      description: 'Analyze video content with the Xiaomi MiMo model (mimo-v2.5). Accepts a public video URL (mp4/webm/mov).',
      parameters: {
        url: { type: 'string', required: true, description: 'Public video URL (mp4/webm/mov)' },
        prompt: { type: 'string', description: 'What to ask about the video (default: describe)' }
      },
      output: { schema: { type: 'json' }, render: renderText },
      async execute(args, exec) {
        const key = await resolveKey()
        const body = JSON.stringify({
          model: 'mimo-v2.5',
          messages: [{ role: 'user', content: [{ type: 'video_url', video_url: { url: args.url } }, { type: 'text', text: args.prompt || 'Please describe the video content.' }] }],
          stream: false, max_completion_tokens: 2048, thinking: { type: 'disabled' }
        })
        const specFile = `${TMP_ROOT}/mimo_spec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`
        const respFile = `${TMP_ROOT}/mimo_resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`
        const py = b64([
          'import json,sys,base64,urllib.request,urllib.error',
          'b=open(sys.argv[1],"rb").read()',
          'req=urllib.request.Request(sys.argv[2],data=b,headers={"api-key":sys.argv[3],"Content-Type":"application/json"})',
          'try:',
          '  r=urllib.request.urlopen(req,timeout=90)',
          '  open(sys.argv[4],"wb").write(r.read())',
          '  print("OK")',
          'except urllib.error.HTTPError as e:',
          '  print("HTTP_ERR:"+e.read().decode("utf-8","replace")[:500])',
          'except Exception as ex:',
          '  print("NET_ERR:"+str(ex)[:300])',
        ].join('\n'))
        const cmd = `printf '%s' ${shq(b64(body))} | base64 -d > ${shq(specFile)} && printf '%s' ${py} | base64 -d | python3 - ${shq(specFile)} ${shq(BASE_URL + '/chat/completions')} ${shq(key)} ${shq(respFile)}`
        const r = await run(cmd, exec, { timeoutMs: 120000 })
        const status = r.stdout.text.trim()
        let respText = null
        try { respText = (await run(`cat ${shq(respFile)}`, exec, { timeoutMs: 10000 })).stdout.text } catch {}
        await run(`rm -f ${shq(specFile)} ${shq(respFile)}`, exec, { timeoutMs: 5000 }).catch(() => {})
        if (!status.startsWith('OK')) return { ok: false, error: (respText || status).replace(/^(HTTP_ERR|NET_ERR):/, '').slice(0, 400) }
        let d
        try { d = JSON.parse(respText.trim()) } catch { return { ok: false, error: 'unparseable response' } }
        if (d.error !== undefined) return { ok: false, error: typeof d.error === 'string' ? d.error : d.error.message }
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
          files: isUrl ? [] : [{ kind: 'audio', mime: mimeOf(args.audio), path: wslPathOf(args.audio) }],
          prompt: '',
          language: args.language
        }, exec)
        if (!res.ok) return { ok: false, error: res.error }
        const d = res.data
        if (d.error !== undefined) return { ok: false, error: typeof d.error === 'string' ? d.error : d.error.message }
        return { ok: true, answer: d.choices?.[0]?.message?.content ?? null, usage: d.usage ?? null }
      }
    },
    {
      name: 'mimo_tts',
      description: 'Text-to-speech with the Xiaomi MiMo TTS models. Writes the synthesized audio to a Windows-side .wav file (default C:\\Windows\\Temp\\mimo_tts_<ts>.wav). Voice: preset ID (mimo_default/冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo) or a free-form Chinese voice description (voicedesign).',
      parameters: {
        text: { type: 'string', required: true, description: 'Text to synthesize' },
        voice: { type: 'string', description: 'Preset voice ID or custom voice description (default mimo_default)' },
        output: { type: 'string', description: 'Output .wav path on the Windows side' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const key = await resolveKey()
        const outPath = args.output || `C:\\Windows\\Temp\\mimo_tts_${Date.now()}.wav`
        const outWsl = '/mnt/c/Windows/Temp/' + outPath.split(/[\\/]/).pop()
        const voice = args.voice || 'mimo_default'
        const isPreset = PRESET_VOICES.has(voice)
        const model = isPreset ? 'mimo-v2.5-tts' : 'mimo-v2.5-tts-voicedesign'
        const messages = []
        messages.push({ role: 'user', content: isPreset ? 'Speak the following text naturally.' : voice })
        messages.push({ role: 'assistant', content: args.text })
        const audio = isPreset
          ? { format: 'wav', voice }
          : { format: 'wav', optimize_text_preview: true }
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
        const pyCmd = `python3 -c 'import base64,sys; open(sys.argv[1],"wb").write(base64.b64decode(sys.stdin.read()))' ${shq(tmp + '.json')} <<'DSH_EOF'\n${b64(body)}\nDSH_EOF\nprintf '%s' ${py} | base64 -d | python3 - ${shq(tmp + '.json')} ${shq(BASE_URL + '/chat/completions')} ${shq(key)} ${shq(tmp + '.resp')}`
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
        const decRun = await run(`printf '%s' ${dec} | base64 -d | python3 - ${shq(tmp + '.resp')} ${shq(outWsl)}`, exec, { timeoutMs: 30000 })
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
        output: { type: 'string', description: 'Output .wav path on the Windows side (default C:\\Windows\\Temp\\mimo_voiceclone_<ts>.wav)' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args, exec) {
        const key = await resolveKey()
        const outPath = args.output || `C:\\Windows\\Temp\\mimo_voiceclone_${Date.now()}.wav`
        const outWsl = '/mnt/c/Windows/Temp/' + outPath.split(/[\\/]/).pop()
        const ref = String(args.reference)
        const refWsl = wslPathOf(ref)
        const isUrl = /^https?:\/\//i.test(ref)
        const tmp = `${TMP_ROOT}/mimo_vc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        // One python pass: read the reference audio (local file or URL), encode
        // it as a data URL, build the full request body in memory, POST to MiMo,
        // and write the raw response to a file. Everything stays on disk — the
        // reference audio base64 (~154KB for a 115KB clip) must never cross the
        // 64KB shell stdout cap that would truncate the data URL.
        const py = b64([
          'import sys,json,base64,urllib.request,urllib.error',
          'src,text,api,url,out = sys.argv[1:6]',
          'b=urllib.request.urlopen(src,timeout=60).read() if src.startswith(("http://","https://")) else open(src,"rb").read()',
          'durl="data:audio/wav;base64,"+base64.b64encode(b).decode()',
          'payload={"model":"mimo-v2.5-tts-voiceclone","messages":[{"role":"user","content":"Use this reference voice to speak the following text naturally."},{"role":"assistant","content":text}],"audio":{"format":"wav","voice":durl}}',
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
        const pyCmd = `printf '%s' ${py} | base64 -d | python3 - ${shq(isUrl ? ref : refWsl)} ${shq(args.text)} ${shq(key)} ${shq(BASE_URL + '/chat/completions')} ${shq(tmp + '.resp')}`
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
          const errRun = await run(`printf '%s' ${errPy} | base64 -d | python3 - ${shq(tmp + '.resp')}`, exec, { timeoutMs: 10000 })
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
        const extractRun = await run(`printf '%s' ${extractPy} | base64 -d | python3 - ${shq(tmp + '.resp')} ${shq(outWsl)}`, exec, { timeoutMs: 30000 })
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

  // audio-tools skill: guidance for the MiMo audio toolset (transcribe /
  // speak / voiceclone / understand). The tools themselves are always
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
      '- **mimo_tts** — synthesize text into a .wav file. `voice` is a preset ID (mimo_default/冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dea) or a free-form Chinese voice description (uses the voicedesign model). Output lands on the Windows side (default C:\\Windows\\Temp).',
      '- **mimo_voiceclone** — clone a voice: give a short reference audio clip (local path or URL) plus target text; output is speech in the reference speaker\'s voice.',
      '- **mimo_audio** — understand the content of an audio file (wav/mp3/flac/ogg/m4a): summarize, extract information, or answer questions about what is said or played.',
      '',
      '## Usage notes',
      '',
      '- Inputs accept local paths (WSL `/home/...`, `/mnt/c/...` or Windows `C:\\...`) or public URLs.',
      '- TTS and voiceclone write .wav files to `C:\\Windows\\Temp` by default; pass `output` to choose another Windows-side path.',
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
}
