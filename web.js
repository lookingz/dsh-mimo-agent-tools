/**
 * dsh-mimo-agent-tools — host web routes (ported from dsh-voice-mimo lib/web.js,
 * per docs/adr/0001 single-repo merge; issue #4).
 *
 * Same-origin endpoints backing the browser UI (./client):
 *   POST /_dsh/mimo-agent-tools/speak             🔊 read-aloud synthesis
 *   GET|HEAD /_dsh/mimo-agent-tools/audio/<id>.wav  artifact streaming / probe
 *   POST /_dsh/mimo-agent-tools/regenerate        restore a cleaned artifact
 *   POST /_dsh/mimo-agent-tools/archive-cleanup   archived-session sweep
 *
 * Retired from the voice-mimo port: the settings route (plugin Config +
 * Plugins settings tab replaces it), the import route (🧠 UnderstandButton
 * dropped), the transcribe route (🎤 dropped), and the client log route.
 *
 * All synthesis goes through the shared ./mimo client (single MiMo transport).
 * Configuration comes from live plugin Config (getConfig) instead of the old
 * settings namespace. HTTP decision layers (…Http) stay separated from the
 * raw req/res handlers so the whole mapping is testable without a server.
 */
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import {
  cleanupSessionArtifacts,
  enforceLongRetention,
  entryAbsolutePath,
  initAudioStore,
  manifestAppend,
  manifestEntries,
  manifestFind,
  newAudioId,
  resolveAudioDir,
  wavDurationSeconds,
} from "./audio-store.js";
import { applyStyle, createMiMoClient, resolveTtsTarget, truncateTtsText, voiceTypeOf } from "./mimo.js";

export const ROUTE_PREFIX = "/_dsh/mimo-agent-tools";
export const SPEAK_ROUTE = `${ROUTE_PREFIX}/speak`;
export const REGENERATE_ROUTE = `${ROUTE_PREFIX}/regenerate`;
export const ARCHIVE_CLEANUP_ROUTE = `${ROUTE_PREFIX}/archive-cleanup`;
/** Prefix route: GET /_dsh/mimo-agent-tools/audio/<id>.wav streams a stored file. */
export const AUDIO_PREFIX = `${ROUTE_PREFIX}/audio`;

/** Defaults when Config carries empty strings (mirrors the Config schema). */
export const DEFAULT_READ_ALOUD_VOICE = "alloy";
export const DEFAULT_STYLE = "温柔";
const DEFAULT_PROVIDER = { baseUrl: "https://api.xiaomimimo.com/v1", credential: "XIAOMI_API_KEY" };

/** Audio ids are ours alone (newAudioId): alphanumeric + ._- + .wav. */
const AUDIO_ID_PATTERN = /^[A-Za-z0-9._-]+\.wav$/;

/** Largest accepted JSON body for /speak and /regenerate (text + envelope; small). */
const MAX_SPEAK_BODY_BYTES = 256 * 1024;

/** Error class distinguishing "missing audio" (404) from real failures (500). */
export class AudioLookupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Provider settings (live from plugin Config). */
function providerOf(getConfig) {
  const provider = getConfig()?.provider ?? {};
  return {
    baseUrl: provider.baseUrl || DEFAULT_PROVIDER.baseUrl,
    credential: provider.credential || DEFAULT_PROVIDER.credential,
  };
}

/** Resolve the MiMo API key from DSH Credentials (shared by speak + regenerate). */
async function resolveMimoKey(ctx, credential) {
  const credentials = ctx.get("credentials");
  if (credentials === undefined) throw new Error("credentials service is unavailable");
  const resolved = await credentials.resolve(credential || DEFAULT_PROVIDER.credential);
  if (resolved === undefined) {
    throw new Error(`credential ${credential || DEFAULT_PROVIDER.credential} is not configured; store it through DSH Credentials`);
  }
  return resolved.value;
}

/** Resolve the read-aloud style: explicit request wins, else Config, else default. */
function resolveStyle(tts, style) {
  if (typeof style === "string" && style.trim().length > 0) return style.trim();
  if (typeof tts?.style === "string" && tts.style.trim().length > 0) return tts.style.trim();
  return DEFAULT_STYLE;
}

/** Client for one request: shared ./mimo transport with injected fetch. */
async function mimoClient(ctx, getConfig, deps) {
  const provider = providerOf(getConfig);
  const apiKey = await resolveMimoKey(ctx, provider.credential);
  return createMiMoClient({ baseUrl: provider.baseUrl, apiKey, fetchImpl: deps.fetchImpl });
}

function configDefaults(getConfig) {
  const value = getConfig() ?? {};
  const tts = value.tts ?? {};
  const audio = value.audio ?? {};
  return {
    value,
    tts,
    audio,
    voiceMap: value.voiceMap ?? {},
    inlineThreshold: Number.isFinite(audio.inlineThreshold) && audio.inlineThreshold > 0 ? audio.inlineThreshold : 30,
  };
}

/**
 * 🔊 read-aloud: synthesize `text` via the shared ./mimo client into
 * audioDir/tmp, record the manifest entry, and return
 * { id, audioUrl, bytes, seconds, inline, voice, model, style }.
 *
 * Voice: optional explicit `voice`, else Config tts.voice (朗读音色), else
 * DEFAULT_READ_ALOUD_VOICE — resolved through the Config voice map. Style:
 * explicit `style`, else Config tts.style (朗读语气), else the shared
 * default, applied through the same mixed channel as mimo_tts. Style tags
 * are applied FIRST, then the final text is truncated (the (style) prefix
 * must never push the payload past the shared 2500-char limit).
 */
export async function performSpeak(ctx, getConfig, { text, voice, style } = {}, deps = {}) {
  const t = typeof text === "string" ? text.trim() : "";
  if (t.length === 0) throw new Error("text is required");
  const { value, tts, voiceMap } = configDefaults(getConfig);
  const dir = resolveAudioDir(value, deps.dshHome ?? resolveDshHome());
  await initAudioStore(dir);
  const client = await mimoClient(ctx, getConfig, deps);
  const voiceName = (typeof voice === "string" && voice.trim().length > 0 ? voice.trim() : tts.voice) || DEFAULT_READ_ALOUD_VOICE;
  const target = resolveTtsTarget(tts, voiceMap, voiceName);
  if (target.needsReference) {
    throw new Error(
      `朗读音色 "${voiceName}" 映射到 voiceclone 模型,需要参考音频;请在 Plugins 设置选择 preset/voicedesign 音色,或改用 mimo_voiceclone 工具带 reference 参数`,
    );
  }
  const styleName = resolveStyle(tts, style);
  const applied = applyStyle({
    style: styleName,
    sing: false,
    voiceType: target.voiceType,
    userContent: target.userContent,
    text: t,
  });
  const { text: textToSpeak, truncated } = truncateTtsText(applied.text);
  const { bytes } = await client.speakResolved({
    model: target.model,
    userContent: applied.userContent,
    text: textToSpeak,
    audio: target.audio,
    timeoutMs: tts.timeoutMs || 60000,
  });
  const id = newAudioId();
  const rel = `tmp/${id}`;
  await writeFile(join(dir, rel), bytes);
  await manifestAppend(dir, { id, rel, text: t, voice: voiceName, model: target.model, style: styleName });
  const audioUrl = `${AUDIO_PREFIX}/${id}`;
  const result = { id, audioUrl, bytes: bytes.length, voice: voiceName, model: target.model, style: styleName };
  if (truncated) result.truncated = true;
  const seconds = wavDurationSeconds(bytes);
  if (seconds > 0) result.seconds = Math.round(seconds * 10) / 10;
  result.inline = !(seconds > 0 && seconds > configDefaults(getConfig).inlineThreshold);
  return result;
}

/** Validate an audio id path segment; throws AudioLookupError on anything unexpected. */
export function parseAudioId(raw) {
  if (typeof raw !== "string" || !AUDIO_ID_PATTERN.test(raw)) {
    throw new AudioLookupError("invalid-id", "invalid audio id");
  }
  return raw;
}

/**
 * GET /audio/<id>.wav: resolve a manifest entry to a confined absolute path.
 * Returns { path, bytes } or throws:
 *   - AudioLookupError("not-found") → 404 — no manifest entry at all
 *   - AudioLookupError("cleaned")   → 410 Gone — entry exists (its parameters
 *     survive for regenerate) but the file was cleaned (archived session /
 *     retention). The client renders "已清理,可重新生成" off this signal.
 *   - anything else (real I/O failure) → 500.
 */
export async function performAudio(ctx, getConfig, rawId, deps = {}) {
  const id = parseAudioId(rawId);
  const value = getConfig() ?? {};
  const dir = resolveAudioDir(value, deps.dshHome ?? resolveDshHome());
  const entry = await manifestFind(dir, id);
  if (!entry) throw new AudioLookupError("not-found", `audio ${id} not found`);
  const path = entryAbsolutePath(dir, entry);
  const { stat } = await import("node:fs/promises");
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new AudioLookupError("cleaned", `audio ${id} was cleaned; regenerate it`);
    }
    throw error; // real fs failures → 500
  }
  if (!info.isFile()) throw new AudioLookupError("cleaned", `audio ${id} was cleaned; regenerate it`);
  return { path, bytes: info.size };
}

/**
 * HTTP decision layer for POST /speak: { status, json } on every path;
 * status 200/400/500.
 */
export async function speakHttp(ctx, getConfig, body, deps = {}) {
  const text = body && typeof body.text === "string" ? body.text.trim() : "";
  if (text.length === 0) {
    return { status: 400, json: { ok: false, error: { code: "invalid-request", message: "text is required" } } };
  }
  try {
    const result = await performSpeak(ctx, getConfig, { text, voice: body.voice, style: body.style }, deps);
    return { status: 200, json: { ok: true, value: result } };
  } catch (error) {
    return { status: 500, json: { ok: false, error: { code: "speak-error", message: errorMessage(error) } } };
  }
}

/**
 * HTTP decision layer for GET /audio/<id>: 200 with { path, bytes } (caller
 * streams), 404 (no manifest entry / invalid id) or 410 (entry survived but
 * the file was cleaned) / 500 (real failure) with JSON.
 */
export async function audioHttp(ctx, getConfig, rawId, deps = {}) {
  try {
    const { path, bytes } = await performAudio(ctx, getConfig, rawId, deps);
    return { status: 200, path, bytes };
  } catch (error) {
    if (error instanceof AudioLookupError) {
      if (error.code === "cleaned") {
        return { status: 410, json: { ok: false, error: { code: "audio-cleaned", message: error.message } } };
      }
      return { status: 404, json: { ok: false, error: { code: "audio-not-found", message: error.message } } };
    }
    return { status: 500, json: { ok: false, error: { code: "audio-error", message: errorMessage(error) } } };
  }
}

/**
 * POST /regenerate {sessionId, callId}: restore a cleaned long/ artifact
 * from its manifest parameter record. Re-synthesizes via the shared ./mimo
 * client with the stored {text, voice, model, style, sing}, writes back under
 * the SAME id (the message strip's audioUrl stays valid — no client URL
 * swap), and appends a fresh manifest line so the loose retention sees the
 * new createdAt. The original manifest line stays as history; lookups prefer
 * the latest line per id.
 *
 * Throws: AudioLookupError("invalid-request") on bad params,
 * AudioLookupError("not-found") when no long/ entry matches the pair, plain
 * Error on synthesis/voice problems (→ 500).
 */
export async function performRegenerate(ctx, getConfig, { sessionId, callId } = {}, deps = {}) {
  if (typeof sessionId !== "string" || sessionId.length === 0 || typeof callId !== "string" || callId.length === 0) {
    throw new AudioLookupError("invalid-request", "sessionId and callId are required");
  }
  const { value, tts, voiceMap, audio } = configDefaults(getConfig);
  const dir = resolveAudioDir(value, deps.dshHome ?? resolveDshHome());
  const entries = await manifestEntries(dir);
  let entry = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.sessionId === sessionId && e.callId === callId &&
        typeof e.path === "string" && e.path.startsWith("long/")) {
      entry = e;
      break;
    }
  }
  if (!entry) {
    throw new AudioLookupError("not-found", `no archived speech artifact for session ${sessionId} call ${callId}`);
  }
  const voiceName = (typeof entry.voice === "string" && entry.voice.trim()) ? entry.voice.trim() : DEFAULT_READ_ALOUD_VOICE;
  // Rebuild the request shape from today's voice map, then OVERRIDE the model
  // with the manifest-recorded one: the manifest records the model that
  // actually spoke, so regenerate replays it verbatim (a Config model change
  // must not silently retune the replay). Recorded style/text/sing ride
  // as-is. Voiceclone artifacts cannot regenerate — the reference audio was
  // never stored.
  const target = resolveTtsTarget(tts, voiceMap, voiceName);
  const model = (typeof entry.model === "string" && entry.model.trim()) ? entry.model.trim() : target.model;
  const channel = voiceTypeOf(model);
  if (channel === "voiceclone") {
    throw new Error(
      `voice "${voiceName}" maps to the voiceclone model, which needs the original reference audio; regenerate is unavailable for it`,
    );
  }
  const client = await mimoClient(ctx, getConfig, deps);
  // The manifest holds the RESOLVED style (resolveStyle ran at synthesis
  // time), so regenerate reproduces the exact request rather than re-reading
  // today's config.
  const styleName = (typeof entry.style === "string" && entry.style.trim()) ? entry.style.trim() : DEFAULT_STYLE;
  const applied = applyStyle({
    style: styleName,
    sing: entry.sing === true,
    voiceType: channel,
    userContent: target.userContent,
    text: entry.text ?? "",
  });
  const { text: textToSpeak, truncated } = truncateTtsText(applied.text);
  const { bytes } = await client.speakResolved({
    model,
    userContent: applied.userContent,
    text: textToSpeak,
    audio: target.audio,
    timeoutMs: tts.timeoutMs || 60000,
  });
  const id = entry.id;
  await initAudioStore(dir);
  await writeFile(join(dir, entry.path), bytes);
  await manifestAppend(dir, {
    id,
    rel: entry.path,
    sessionId,
    callId,
    text: entry.text ?? "",
    voice: voiceName,
    model,
    style: styleName,
    sing: entry.sing === true,
  });
  const result = { id, audioUrl: `${AUDIO_PREFIX}/${id}`, bytes: bytes.length, voice: voiceName, model, style: styleName, regenerated: true };
  if (truncated) result.truncated = true;
  // Keep the loose retention bound honest after restoring an artifact.
  await enforceLongRetention(dir, { count: audio.longRetainCount ?? 200, days: audio.longRetainDays ?? 30 });
  return result;
}

/** HTTP decision layer for POST /regenerate. */
export async function regenerateHttp(ctx, getConfig, body, deps = {}) {
  try {
    const result = await performRegenerate(ctx, getConfig, { sessionId: body?.sessionId, callId: body?.callId }, deps);
    return { status: 200, json: { ok: true, value: result } };
  } catch (error) {
    if (error instanceof AudioLookupError && error.code === "invalid-request") {
      return { status: 400, json: { ok: false, error: { code: "invalid-request", message: error.message } } };
    }
    if (error instanceof AudioLookupError && error.code === "not-found") {
      return { status: 404, json: { ok: false, error: { code: "artifact-not-found", message: error.message } } };
    }
    return { status: 500, json: { ok: false, error: { code: "regenerate-error", message: errorMessage(error) } } };
  }
}

/**
 * POST /archive-cleanup {sessionIds}: the host half of the archived-sessions
 * event. The `host/archived-sessions-changed` frame only flows to the client
 * runtime (api-proxy pushes it to client mux queues, not the host cordis
 * bus), so the client half diffs the full archivedSessionIds set and drives
 * this route; the host also sweeps ctx.workspaceRegistry archived ids at
 * startup as a robustness fallback. Cleans each session's long/ audio only —
 * manifest lines stay (regenerate params), session logs are never touched.
 */
export async function performArchiveCleanup(ctx, getConfig, sessionIds) {
  const list = Array.isArray(sessionIds) ? sessionIds.filter((id) => typeof id === "string" && id.length > 0) : [];
  const value = getConfig() ?? {};
  const dir = resolveAudioDir(value);
  const cleaned = [];
  for (const sessionId of list) {
    const outcome = await cleanupSessionArtifacts(dir, sessionId);
    cleaned.push({ sessionId, removed: outcome.removed });
  }
  return { cleaned };
}

/** HTTP decision layer for POST /archive-cleanup. */
export async function archiveCleanupHttp(ctx, getConfig, body) {
  if (!body || !Array.isArray(body.sessionIds)) {
    return { status: 400, json: { ok: false, error: { code: "invalid-request", message: "sessionIds array is required" } } };
  }
  try {
    const result = await performArchiveCleanup(ctx, getConfig, body.sessionIds);
    return { status: 200, json: { ok: true, value: result } };
  } catch (error) {
    return { status: 500, json: { ok: false, error: { code: "archive-cleanup-error", message: errorMessage(error) } } };
  }
}

/** Read one JSON body with a size cap. */
async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error("payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Respond JSON with status. */
function respond(res, value, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

/**
 * Attach the speak + audio + regenerate + archive-cleanup routes whenever a
 * webServer is present. getConfig is the live plugin Config getter wired up
 * by index.js (apply receives the config and re-reads it per request).
 */
export function installMimoWeb(ctx, getConfig) {
  // A host without the webServer seam (tests, headless drivers) simply gets
  // no routes — the tools keep working.
  if (typeof ctx.inject !== "function") return
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => {
      const speakDispose = webCtx.webServer.register({
        kind: "exact",
        path: SPEAK_ROUTE,
        handler: async (req, res) => {
          if (req.method !== "POST") {
            respond(res, { ok: false, error: { code: "method-not-allowed", message: "Use POST" } }, 405);
            return;
          }
          let body;
          try {
            body = JSON.parse(await readBody(req, MAX_SPEAK_BODY_BYTES) || "{}");
          } catch (error) {
            respond(res, { ok: false, error: { code: "invalid-request", message: errorMessage(error) } }, 400);
            return;
          }
          const { status, json } = await speakHttp(ctx, getConfig, body);
          respond(res, json, status);
        },
      });
      const audioDispose = webCtx.webServer.register({
        kind: "prefix",
        path: AUDIO_PREFIX,
        handler: async (req, res) => {
          // HEAD is the client's cleaned-state probe (410 Gone = 已清理).
          if (req.method !== "GET" && req.method !== "HEAD") {
            respond(res, { ok: false, error: { code: "method-not-allowed", message: "Use GET or HEAD" } }, 405);
            return;
          }
          const rawPath = new URL(req.url ?? "/", "http://x").pathname;
          const rawId = rawPath.slice(AUDIO_PREFIX.length).replace(/^\/+/, "");
          const outcome = await audioHttp(ctx, getConfig, rawId);
          if (outcome.status !== 200) {
            respond(res, outcome.json, outcome.status);
            return;
          }
          res.writeHead(200, {
            "Content-Type": rawId.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "audio/wav",
            "Content-Length": String(outcome.bytes),
            "Cache-Control": "no-store",
          });
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          const stream = createReadStream(outcome.path);
          stream.on("error", (error) => {
            // File vanished between stat() and read (e.g. tmp cleanup): abort
            // the response instead of crashing the host.
            ctx.logger?.warn?.(`[dsh-mimo-agent-tools] audio stream error: ${errorMessage(error)}`);
            res.destroy();
          });
          stream.pipe(res);
        },
      });
      const regenerateDispose = webCtx.webServer.register({
        kind: "exact",
        path: REGENERATE_ROUTE,
        handler: async (req, res) => {
          if (req.method !== "POST") {
            respond(res, { ok: false, error: { code: "method-not-allowed", message: "Use POST" } }, 405);
            return;
          }
          let body;
          try {
            body = JSON.parse(await readBody(req, MAX_SPEAK_BODY_BYTES) || "{}");
          } catch (error) {
            respond(res, { ok: false, error: { code: "invalid-request", message: errorMessage(error) } }, 400);
            return;
          }
          const { status, json } = await regenerateHttp(ctx, getConfig, body);
          respond(res, json, status);
        },
      });
      const archiveCleanupDispose = webCtx.webServer.register({
        kind: "exact",
        path: ARCHIVE_CLEANUP_ROUTE,
        handler: async (req, res) => {
          if (req.method !== "POST") {
            respond(res, { ok: false, error: { code: "method-not-allowed", message: "Use POST" } }, 405);
            return;
          }
          let body;
          try {
            body = JSON.parse(await readBody(req, MAX_SPEAK_BODY_BYTES) || "{}");
          } catch (error) {
            respond(res, { ok: false, error: { code: "invalid-request", message: errorMessage(error) } }, 400);
            return;
          }
          const { status, json } = await archiveCleanupHttp(ctx, getConfig, body);
          respond(res, json, status);
        },
      });
      return () => {
        speakDispose();
        audioDispose();
        regenerateDispose();
        archiveCleanupDispose();
      };
    }, "dsh-mimo-agent-tools: speak + audio + regenerate + archive-cleanup routes");
  });
}

