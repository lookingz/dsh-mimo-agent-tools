/**
 * dsh-mimo-agent-tools/client — browser UI half (ported from dsh-voice-mimo,
 * per docs/adr/0001 single-repo merge; issue #4, absorbing voice-mimo
 * #13/#16). DSH client-bundler convention: the `./client` export is the web
 * entry, loaded via window.__ModuleLoader__ with the modules declared in
 * package.json `dsh.client.inject` available to `require`.
 *
 * Merged in:
 *  - 🔊 read-aloud SpeakerButton at `conversation.chat.assistant-actions` —
 *    click → POST /_dsh/mimo-agent-tools/speak → the host synthesizes through
 *    the shared ./mimo client → <audio> plays the same-origin audioUrl.
 *    (Read-aloud fix: react is declared in dsh.client.inject and the module
 *    id matches the package name — the voice-mimo breakage root cause was the
 *    factory requiring an undeclared module at load time.)
 *  - In-conversation speech strip (play / download / regenerate) for
 *    `mimo_tts` results stored via the store flag (tool.call.toolview); the
 *    machine envelope the host render emits carries audioUrl/seconds/inline.
 *  - Archived-session cleanup watcher (host/archived-sessions-changed only
 *    reaches the client runtime; this half drives the host cleanup route).
 *
 * Dropped from the voice-mimo port (issue #4): 🎤 MicButton (the official
 * speechToText seam in ./speech covers it), 🧠 UnderstandButton (mimo_audio),
 * auto read-aloud/notify (never used — retired with the feature), the custom
 * Settings page (voice map lives in plugin Config, rendered by the Plugins
 * settings tab), and the client diagnostic log (log route retired with it).
 *
 * Plain JavaScript, no JSX — elements via React.createElement.
 */

window.__ModuleLoader__.load({
  id: 'dsh-mimo-agent-tools',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useState, useRef, useEffect } = React

    const inject = ['slots', 'workspaces']

    const SPEAK_ROUTE = '/_dsh/mimo-agent-tools/speak'
    const REGENERATE_ROUTE = '/_dsh/mimo-agent-tools/regenerate'
    const ARCHIVE_CLEANUP_ROUTE = '/_dsh/mimo-agent-tools/archive-cleanup'

    // ──────────────────────────────────────────────────────────────────────────
    // Shared single-playback registry: starting one sound stops the others
    // (mirrors the old global speechSynthesis.cancel() semantics).
    // ──────────────────────────────────────────────────────────────────────────
    let activeAudio = null
    const audioStopListeners = new Set()
    function notifyAudioStopped() {
      for (const fn of audioStopListeners) fn()
    }
    function stopActiveAudio() {
      if (activeAudio) {
        try { activeAudio.pause(); } catch (_) { /* ignore */ }
        activeAudio = null
        notifyAudioStopped()
      }
    }
    // Stop whatever else is playing WITHOUT letting the notify loop reset the
    // caller's own state (the caller asserts its state right after).
    function stopOthersExcept(handler) {
      if (handler) audioStopListeners.delete(handler)
      try {
        stopActiveAudio()
      } finally {
        if (handler) audioStopListeners.add(handler)
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 🔊 Speaker button — read one assistant reply aloud with MiMo TTS
    // ──────────────────────────────────────────────────────────────────────────
    // Click → POST /speak → the host synthesizes via the ./mimo client into
    // audioDir/tmp → <audio> plays the returned audioUrl. Voice/style come
    // from plugin Config (朗读音色/朗读语气, Plugins settings tab), resolved
    // host-side, so a config change applies to the next click immediately.
    //
    // Playback states: idle → busy (synthesizing) → playing (click to stop) |
    // ready (autoplay blocked by browser policy; click plays the loaded file).
    function SpeakerButton(props) {
      const { messageId, useSession } = props
      const [state, setState] = useState('idle') // idle | busy | playing | ready
      const audioRef = useRef(null)
      const abortRef = useRef(null)
      const stopHandlerRef = useRef(null)

      // session-scope slots inject `useSession` as a SELECTOR hook over the
      // current session snapshot. Chat nodes are view wrappers: kind
      // 'assistant-step' with the message under data.finalNode (messageId +
      // blocks) — extract the text inside the selector so streaming stays fresh.
      const text = typeof useSession === 'function'
        ? useSession((s) => {
            const nodes = s?.chat?.nodes?.values?.() ?? []
            const node = nodes.find((n) => (
              n && n.kind === 'assistant-step' && n.data &&
              n.data.finalNode && n.data.finalNode.messageId === messageId
            ))
            const blocks = node && node.data && node.data.finalNode ? node.data.finalNode.blocks : null
            if (!Array.isArray(blocks)) return ''
            return blocks
              .filter((b) => b && b.kind === 'text' && b.text)
              .map((b) => b.text)
              .join('\n')
              .trim()
          })
        : ''

      useEffect(() => {
        // Any other message starting playback stops us.
        const handleStop = () => setState('idle')
        stopHandlerRef.current = handleStop
        audioStopListeners.add(handleStop)
        return () => {
          audioStopListeners.delete(handleStop)
          if (abortRef.current) { try { abortRef.current.abort(); } catch (_) { /* ignore */ } }
          const a = audioRef.current
          if (a) {
            try { a.pause(); a.removeAttribute('src'); } catch (_) { /* ignore */ }
          }
          if (activeAudio === a) activeAudio = null
        }
      }, [])

      const playAudio = (url) => {
        stopOthersExcept(stopHandlerRef.current)
        const a = new Audio(url)
        audioRef.current = a
        activeAudio = a
        const settle = () => { setState('idle'); if (activeAudio === a) activeAudio = null; }
        a.onended = settle
        a.onerror = () => {
          setState('idle')
          if (activeAudio === a) activeAudio = null
          window.alert('音频播放失败：' + String((a.error && a.error.message) || 'unknown'))
        }
        const promise = a.play()
        if (promise && typeof promise.catch === 'function') {
          promise.catch(() => {
            // Autoplay policy: keep the loaded file, ask for one more click
            // (Chrome requires a user gesture for play() with sound).
            if (a === audioRef.current) setState('ready')
            if (activeAudio === a) activeAudio = null
          })
        }
      }

      const speak = () => {
        if (state === 'busy') return
        if (state === 'playing') {
          stopActiveAudio()
          return
        }
        if (state === 'ready' && audioRef.current) {
          // Playback was blocked before; this click is a user gesture.
          stopOthersExcept(stopHandlerRef.current)
          setState('playing')
          const a = audioRef.current
          activeAudio = a
          const promise = a.play()
          if (promise && typeof promise.catch === 'function') {
            promise.catch(() => {
              setState('idle')
              if (activeAudio === a) activeAudio = null
            })
          }
          return
        }
        if (!text) return
        setState('busy')
        const ctrl = new AbortController()
        abortRef.current = ctrl
        fetch(SPEAK_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: ctrl.signal,
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok) throw new Error(d.error?.message || 'synthesis failed')
            setState('playing')
            playAudio(d.value.audioUrl)
          })
          .catch((err) => {
            if (err && err.name === 'AbortError') return
            setState('idle')
            window.alert('语音合成失败：' + ((err && err.message) || err))
          })
      }

      const busy = state === 'busy'
      const speaking = state === 'playing'
      return React.createElement(
        'button',
        {
          type: 'button',
          className:
            'dsh-voice-btn dsh-voice-speaker' +
            (busy || speaking ? ' is-speaking' : '') +
            (state === 'ready' ? ' is-ready' : ''),
          onClick: speak,
          title: busy ? '合成中…' : speaking ? '停止朗读' : state === 'ready' ? '点击播放' : '朗读这条回答',
          'aria-label': '朗读这条回答',
          disabled: !text,
        },
        busy ? '⏳' : speaking ? '⏹' : '🔊',
      )
    }

    // ──────────────────────────────────────────────────────────────────────────
    // mimo_tts store-mode toolview: playable strip / card for agent speech
    // ──────────────────────────────────────────────────────────────────────────
    // The host render emits a machine envelope as a second text block:
    // {path, bytes, audioUrl, seconds, inline}. inline=false renders a card.
    function parseTtsEnvelope(content) {
      if (!Array.isArray(content)) return null
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          try {
            const v = JSON.parse(block.text)
            if (v && typeof v === 'object' && typeof v.audioUrl === 'string') return v
          } catch (_) { /* not our envelope */ }
        }
      }
      return null
    }
    function formatDuration(seconds) {
      const s = Math.max(0, Math.round(seconds || 0))
      if (s < 60) return s + 's'
      const m = Math.floor(s / 60)
      const r = s % 60
      return m + ':' + String(r).padStart(2, '0')
    }

    function MimoTtsView(props) {
      const { block } = props
      const [playing, setPlaying] = useState(false)
      // The file may have been cleaned by an archived session / retention
      // while the manifest entry (params) survives. probe:
      // unknown | ok | cleaned | missing — resolved with a HEAD probe.
      const [probe, setProbe] = useState('unknown')
      const [regenerating, setRegenerating] = useState(false)
      const audioRef = useRef(null)
      const stopHandlerRef = useRef(null)
      const playBtnRef = useRef(null)
      const mountedRef = useRef(true)

      const settled = block && block.kind === 'tool-result'
      const envelope = settled ? parseTtsEnvelope(block.content) : null
      const seconds = envelope && typeof envelope.seconds === 'number' ? envelope.seconds : 0
      const inline = !envelope || envelope.inline !== false

      // HEAD-probe the artifact once the call settles: 410 Gone = cleaned
      // (entry survived, file gone) → '已清理,可重新生成'. Network failure or
      // anything else leaves it playable (the <audio> element surfaces real
      // load errors on play).
      useEffect(() => {
        if (!settled || !envelope) return
        let alive = true
        setProbe('unknown')
        fetch(envelope.audioUrl, { method: 'HEAD', credentials: 'same-origin' })
          .then((r) => {
            if (!alive) return
            setProbe(r.status === 410 ? 'cleaned' : r.status === 404 ? 'missing' : 'ok')
          })
          .catch(() => { if (alive) setProbe('ok'); })
        return () => { alive = false }
      }, [settled, envelope ? envelope.audioUrl : null])

      // Re-synthesize a cleaned artifact from its manifest parameter record.
      // The host rewrites the SAME id, so the strip's audioUrl stays valid and
      // the play path just works again.
      const regenerate = () => {
        if (regenerating || !props.sessionId || !props.callId) return
        setRegenerating(true)
        fetch(REGENERATE_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: props.sessionId, callId: props.callId }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok) throw new Error((d.error && d.error.message) || 'regenerate failed')
            setProbe('ok')
          })
          .catch((err) => {
            window.alert('重新生成失败：' + ((err && err.message) || err))
          })
          .finally(() => { if (mountedRef.current) setRegenerating(false); })
      }

      useEffect(() => {
        const handleStop = () => setPlaying(false)
        stopHandlerRef.current = handleStop
        audioStopListeners.add(handleStop)
        return () => {
          mountedRef.current = false
          audioStopListeners.delete(handleStop)
          const a = audioRef.current
          if (a) {
            try { a.pause(); a.removeAttribute('src'); } catch (_) { /* ignore */ }
          }
          if (activeAudio === a) activeAudio = null
        }
      }, [])

      const startPlayback = () => {
        if (!envelope) return
        stopOthersExcept(stopHandlerRef.current)
        const a = new Audio(envelope.audioUrl)
        audioRef.current = a
        activeAudio = a
        const settle = () => {
          if (mountedRef.current) setPlaying(false)
          if (activeAudio === a) activeAudio = null
        }
        a.onended = settle
        a.onerror = settle
        const promise = a.play()
        if (promise && typeof promise.catch === 'function') {
          promise.catch(() => settle())
        }
        setPlaying(true)
      }

      const toggle = () => {
        if (!envelope) return
        if (playing) {
          stopActiveAudio()
          return
        }
        startPlayback()
      }

      // Fallback while running / when the envelope is missing: the plain text
      // summary line, so the tool row never renders empty.
      if (!envelope) {
        const text = settled && Array.isArray(block.content)
          ? block.content
              .filter((b) => b && b.type === 'text' && b.text && !b.text.trim().startsWith('{'))
              .map((b) => b.text)
              .join(' ')
          : ''
        return React.createElement('div', { style: { fontSize: '12px', opacity: 0.75, padding: '4px 2px' } }, text || '…')
      }

      const downloadName = (envelope.path || 'mimo-tts.wav').split(/[\\/]/).pop()
      const rowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(128,128,128,.25)',
        background: 'rgba(128,128,128,.06)',
        maxWidth: '100%',
      }
      const btnStyle = { background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '16px', lineHeight: 1, padding: '2px 4px' }
      const controls = [
        React.createElement('button', {
          key: 'play',
          ref: playBtnRef,
          type: 'button',
          onClick: toggle,
          style: btnStyle,
          title: playing ? '停止' : '播放',
          'aria-label': playing ? '停止' : '播放',
        }, playing ? '⏸' : '▶'),
        React.createElement('span', { key: 'dur', style: { fontSize: '12px', opacity: 0.75, minWidth: '44px' } }, formatDuration(seconds)),
        React.createElement('a', {
          key: 'dl',
          href: envelope.audioUrl,
          download: downloadName,
          style: { ...btnStyle, textDecoration: 'none', fontSize: '13px' },
          title: '下载',
        }, '⬇'),
      ]
      if (probe === 'cleaned' || probe === 'missing') {
        // The artifact was cleaned (archived session / retention); the
        // manifest entry still carries the synthesis parameters, so a
        // '重新生成' button restores it in place.
        return React.createElement('div', {
          style: { ...rowStyle, justifyContent: 'space-between', flexWrap: 'wrap' },
        },
          React.createElement('span', { style: { fontSize: '12px', opacity: 0.75 } },
            probe === 'missing' ? '音频缺失' : '已清理,可重新生成'),
          React.createElement('button', {
            type: 'button',
            onClick: regenerate,
            disabled: regenerating || !props.sessionId || !props.callId,
            style: { ...btnStyle, fontSize: '12px', whiteSpace: 'nowrap' },
            title: regenerating ? '重新生成中…' : '用原参数重新合成',
            'aria-label': '重新生成',
          }, regenerating ? '⏳ 生成中…' : '↻ 重新生成'),
        )
      }
      if (inline) {
        return React.createElement('div', { style: rowStyle }, controls)
      }
      // Long speech (inline=false from the host, Config audio.inlineThreshold)
      // renders as a distinct card.
      return React.createElement('div', {
        style: { ...rowStyle, flexDirection: 'column', alignItems: 'stretch', padding: '10px 12px', background: 'rgba(128,128,128,.09)' },
      },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', opacity: 0.7 } },
          React.createElement('span', null, 'Agent 语音'),
          React.createElement('span', null, formatDuration(seconds)),
        ),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, controls),
      )
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Plugin body
    // ──────────────────────────────────────────────────────────────────────────
    function apply(ctx) {
      // One shared style tag, removed on unload.
      let styleEl = document.getElementById('dsh-mimo-voice-style')
      if (!styleEl) {
        styleEl = document.createElement('style')
        styleEl.id = 'dsh-mimo-voice-style'
        styleEl.textContent = [
          '.dsh-voice-btn{',
          '  appearance:none;background:transparent;border:1px solid transparent;',
          '  border-radius:6px;cursor:pointer;font-size:14px;line-height:1;',
          '  padding:4px 6px;opacity:.7;transition:opacity .12s, background .12s, border-color .12s;',
          '}',
          '.dsh-voice-btn:hover{opacity:1;background:rgba(128,128,128,.12)}',
          '.dsh-voice-btn:disabled{opacity:.3;cursor:default}',
          '.dsh-voice-btn.is-listening,.dsh-voice-btn.is-speaking{',
          '  color:#e5484d;border-color:#e5484d;opacity:1;',
          '}',
          '.dsh-voice-btn.is-ready{',
          '  color:#e5a03d;border-color:#e5a03d;opacity:1;',
          '}',
        ].join('\n')
        document.head.append(styleEl)
      }
      ctx.effect(() => {
        return () => {
          if (styleEl && styleEl.isConnected) styleEl.remove()
        }
      }, 'dsh-mimo-agent-tools: remove voice styles')

      ctx.slots.inject('conversation.chat.assistant-actions', () => {
        const dispose = ctx.slots.register(
          { name: 'conversation.chat.assistant-actions', id: 'dsh-mimo-speaker', order: 30 },
          SpeakerButton,
        )
        return () => dispose()
      })

      // Stored mimo_tts speech renders as a playable strip / card inside the
      // tool row — keyed slot dispatched by the wire tool name.
      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
        { name: 'tool.call.toolview', key: 'mimo_tts', order: 30 },
        MimoTtsView,
      ))

      // Archive cleanup. The `host/archived-sessions-changed` frame reaches
      // the CLIENT runtime only (api-proxy pushes it to client mux queues,
      // not the host cordis bus), so this half diffs the full
      // archivedSessionIds set off ctx.workspaces.list and drives the host
      // cleanup route for each newly archived session. A fresh snapshot on
      // (re)load yields no "added" ids — only real transitions clean.
      ctx.effect(() => {
        let dispose = null
        try {
          const ws = ctx.workspaces
          if (ws && ws.list && typeof ws.list.subscribe === 'function') {
            let last = new Set(ws.list.getSnapshot().archivedSessionIds || [])
            const onChange = () => {
              let snapshot
              try { snapshot = ws.list.getSnapshot(); } catch (_) { return; }
              const cur = new Set(snapshot.archivedSessionIds || [])
              const added = Array.from(cur).filter((id) => !last.has(id))
              last = cur
              if (added.length === 0) return
              fetch(ARCHIVE_CLEANUP_ROUTE, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionIds: added }),
              }).catch(() => { /* cleanup retries at the next transition */ })
            }
            dispose = ws.list.subscribe(onChange)
          }
        } catch (_) { /* best-effort: the host startup sweep still covers it */ }
        return () => {
          if (dispose) { try { dispose(); } catch (_) { /* ignore */ } }
        }
      }, 'dsh-mimo-agent-tools: archived-session cleanup watcher')
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
