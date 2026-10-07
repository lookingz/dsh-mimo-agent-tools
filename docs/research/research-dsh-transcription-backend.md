# Research: dsh built-in voice-transcription backend & MiMo ASR bridge feasibility

Source: `C:\Work\code\deepseek-harness` @ tag `dsh-v0.2.0-rc.2` (read-only). All paths below are relative to that root.

## TL;DR

- dsh's voice input is a plugin stack: browser captures mic → Host-side `speechToText` **in-process provider registry** → transcription runs in a registered provider plugin; the only shipped provider is **local SenseVoice ONNX** (managed sherpa-onnx child process), not a cloud API.
- The backend contract is **not** OpenAI `/v1/audio/transcriptions` and not plain HTTP at the plugin edge: it is the TypeScript `SpeechProvider` interface (`transcribe(input: SpeechInput, signal): Promise<Transcript>`), audio = canonical **16 kHz mono PCM16 WAV** bytes, one-shot (no streaming).
- No endpoint-URL/apiKey/model config exists anywhere — there is nothing to "repoint". No cloud provider is hardcoded either; providers self-register via `ctx.speechToText.register()`.
- `rg -il mimo` over packages/ + apps/ → **zero references**; no existing third-party HTTP provider to mimic, but SenseVoice is a complete worked example of a provider plugin.
- **Verdict: adapter needed** — a small new provider plugin (or a tiny standalone plugin wrapping the MiMo bridge via `mimo_asr`-style HTTP) implementing `SpeechProvider` (~50 lines + config), registered in the voice-input bundle. Pointing a URL at something as-is is impossible; there is no URL knob.

## Where transcription lives

Four `packages/experimental/*` packages compose the feature (bundle wiring: `packages/experimental/voice-input-bundle/cordis.patch.yml:1-13`, deps in its `package.json`):

| Package | Role |
|---|---|
| `speech-to-text` | Host-side registry service `speechToText` (`src/index.ts:35-209`); provider-neutral types (`src/types.ts`); WAV validation (`src/wave.ts:9-23`) |
| `speech-to-text-sensevoice` | The only shipped provider: local SenseVoice ONNX via a managed process (`src/index.ts:20-41`, `src/recognizer.ts:224-291`) |
| `api-speech-to-text` | Authenticated Remote (Typert RPC) bridge for browser clients: `catalog/follow/configure/prepare/cancelPreparation/transcribe` (`src/index.ts:28-110`) |
| `client-ui-voice-input` | Browser capture (getUserMedia + MediaRecorder, resampled to 16 kHz mono PCM16 WAV, base64) and mic-button UI (`src/client/audio.ts:13-38,58-130`, `src/client/VoiceInput.tsx:110`, call wiring `src/client/mount.ts:33`) |

**Where transcription actually runs:** in the Host process (or a Host-managed child process), inside a registered provider plugin. Client sends base64 WAV over the Typert Remote; server decodes, validates, resolves provider, calls `provider.transcribe` (`api-speech-to-text/src/index.ts:89-110`). No browser speech API, no external cloud service.

## Backend contract (quoted)

Provider interface the backend must satisfy — `packages/experimental/speech-to-text/src/types.ts:101-125`:

```ts
/** Complete audio recording and an explicit language hint. */
export interface SpeechInput {
  readonly audio: Uint8Array      // canonical 16 kHz mono PCM16 WAV bytes
  readonly language: string       // e.g. 'auto' | 'zh' | 'en' | 'ja'
}

/** Final transcription; an empty string means no speech was recognized. */
export interface Transcript {
  readonly text: string
  readonly audioSeconds: number
  readonly inferenceSeconds: number
}

/** One replaceable recognizer. It owns preparation, execution, and cancellation. */
export interface SpeechProvider {
  readonly info: SpeechProviderInfo            // id, name, location: 'host-local' | 'cloud', languages
  readonly preparation?: SpeechPreparation     // optional; omit => immediately usable (types.ts:87-99)
  transcribe(input: SpeechInput, signal: AbortSignal): Promise<Transcript>
}
```

Wire shape (browser → Host, Typert Remote, JSON) — `api-speech-to-text/src/types.ts:14-19` and `index.ts:88-110`:

```ts
export interface TranscriptionRequest {
  readonly audioBase64: string      // canonical WAV, base64, no data-URL prefix
  readonly providerId?: SpeechProviderId
  readonly language?: string
}
// limits (index.ts:30-33): maxAudioBytes 4 MiB default, maxDurationSeconds 120 default
// errors: RemoteError 'speech/invalid-audio' | 'speech/transcription-failed'
```

- **Transport:** Typert Remote RPC over the existing authenticated client↔Host channel (`@deepseek-ai/dsh-typert-protocol`, `@Remote` decorators). Not HTTP/WebSocket/OpenAI-compatible at this edge.
- **Audio format:** strictly canonical 16 kHz mono PCM16 little-endian WAV (header validated byte-for-byte, `speech-to-text/src/wave.ts:9-23`; encoded client-side `client-ui-voice-input/src/client/audio.ts:13-27`).
- **Streaming:** none — one-shot request/response only; partial results do not exist.

Registration API — `speech-to-text/src/index.ts:63-71` (`ctx.speechToText.register(provider)`); config of the registry plugin: `defaultProvider` (volatile, required), `language` (volatile, default `'auto'`) — `src/index.ts:36-39`.

## Configurability & verdict

- **No endpoint/apiKey/model-name config exists.** `api-speech-to-text` Config = only `maxAudioBytes`/`maxDurationSeconds` (`src/index.ts:20-33`). SenseVoice provider Config = local paths/threads/timeouts only (`speech-to-text-sensevoice/src/config.ts:6-78`); its only URL-ish keys are `modelOrigins`/`modelOrigin` for downloading ONNX model weights from Hugging Face — not a transcription endpoint.
- **No OpenAI-compatible or cloud provider abstraction** beyond `SpeechProvider` itself; `location: 'cloud'` is an allowed metadata value (`types.ts:19`) that no shipped provider uses.
- `rg -il mimo` across `packages/` and `apps/`: **0 hits** — no integration point, no prior art for remote providers.
- **Verdict: cannot point at a custom URL as-is.** But the seam is ideal: transcription is explicitly a pluggable in-process interface, and the bundle's `cordis.patch.yml` shows exactly how a new provider enters composition.

## What a MiMo bridge adapter would need

A new plugin package `speech-to-text-mimo` (mirroring `speech-to-text-sensevoice`):

1. `apply(ctx, config)` that calls `ctx.speechToText.register({ info: { id, name, location: 'cloud', languages: ['auto','zh','en',...] }, transcribe })` — pattern at `speech-to-text-sensevoice/src/index.ts:27-34`. No `preparation` needed (cloud provider is immediately ready).
2. `transcribe`: POST the WAV bytes to the MiMo bridge (the bridge behind this environment's `mimo_asr` / mimo-v2.5-asr), map the returned text to `{ text, audioSeconds: audioSeconds computed from WAV length, inferenceSeconds: measured }`. Must honor `AbortSignal` and reject with `Error` on failure.
3. Config keys (following SenseVoice's Config style): `providerId`, `endpoint`, `apiKey?`, `model?`, `language default`, `timeoutMs`.
4. Bundle wiring: add the plugin (and, if desired, a `speech-to-text-mimo-bundle` or extend `voice-input-bundle/cordis.patch.yml`) with `defaultProvider: mimo`; selection is also user-switchable at runtime via `speechController.configure` (`speech-to-text/src/index.ts:134-142`).

An OpenAI-`/v1/audio/transcriptions`-compatible shim is **not** required — the contract is the TS interface, not an HTTP schema; any HTTP server the plugin can reach works.

## Open questions

- Which HTTP API does the local "mimo bridge" actually expose (path, auth, request format — raw wav bytes vs multipart vs base64 JSON, response JSON shape)? The `mimo_asr` tool description doesn't pin the wire format.
- Should the MiMo provider accept only the canonical 16 kHz mono WAV (registry guarantees it — `wave.ts`) or re-encode? The bridge likely accepts wav/mp3; passing WAV through unchanged is simplest.
- Latency/streaming expectations: the UI is strictly one-shot; long recordings wait for full inference (`maxDurationSeconds` 120 default).
- Should cloud providers require opt-in disclosure (`SpeechProviderInfo.location: 'cloud'` already exists for UI labeling)?
