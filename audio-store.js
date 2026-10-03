/**
 * dsh-mimo-agent-tools — audio directory store (ported from dsh-voice-mimo,
 * per docs/adr/0001 single-repo merge; issue #4).
 *
 * Layer-0 storage shared by the 🔊 read-aloud route, the mimo_tts store mode,
 * and the regenerate / archive-cleanup routes:
 *
 *   audioDir (default <dshHome>/cache/dsh-mimo-agent-tools/, Config audio.dir)
 *   ├── tmp/            temporary: 🔊 read-aloud; cleared on DSH startup —
 *   │                   play-once, discard
 *   ├── long/           long-term: stored mimo_tts artifacts; cleaned per
 *   │                   archived session + loose retention fallback
 *   └── manifest.json   append-only JSONL: {id, sessionId, callId, path,
 *                       createdAt, text, voice, model, style, sing}
 *
 * Deliberate deviation from the voice-mimo port: paths stay NATIVE (the
 * resolveDshHome result is already what node fs consumes here); the old
 * wslPathOf conversion belonged to the WSL-era host and is gone. The
 * `notify` manifest field (auto read-aloud) is retired with that feature.
 *
 * Pure functions on a `dir` argument (resolved per request from live
 * plugin Config), so every operation is trivially testable against a temp dir.
 */

import { mkdir, readFile, appendFile, readdir, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export const MANIFEST_NAME = "manifest.json";
export const TMP_DIR = "tmp";
export const LONG_DIR = "long";

/** Default audioDir root: <dshHome>/cache/dsh-mimo-agent-tools. */
export function defaultAudioDir(dshHome) {
  return join(dshHome ?? "", "cache", "dsh-mimo-agent-tools");
}

/**
 * Resolve the audioDir from live plugin Config (`audio.dir`, empty = default).
 * Windows paths are kept native; a relative dir resolves against dshHome.
 */
export function resolveAudioDir(config, dshHome) {
  const dir = config?.audio?.dir;
  if (typeof dir === "string" && dir.trim().length > 0) {
    const trimmed = dir.trim();
    return resolve(dshHome ?? process.cwd(), trimmed);
  }
  return defaultAudioDir(dshHome ?? process.env.HOME ?? process.cwd());
}

/**
 * Ensure tmp/ + long/ exist under audioDir. Idempotent.
 * Returns the resolved audioDir.
 */
export async function initAudioStore(dir) {
  await mkdir(join(dir, TMP_DIR), { recursive: true });
  await mkdir(join(dir, LONG_DIR), { recursive: true });
  return dir;
}

/**
 * Remove every entry inside tmp/ (startup cleanup of the previous process's
 * leftovers). Idempotent: missing dir is fine, an empty tmp/ is a no-op.
 * Never touches anything outside audioDir/tmp.
 */
export async function cleanTmp(dir) {
  const tmp = join(dir, TMP_DIR);
  await mkdir(tmp, { recursive: true });
  const entries = await readdir(tmp);
  await Promise.all(entries.map((entry) => rm(join(tmp, entry), { recursive: true, force: true })));
}

/** Build a unique audio file name (used for tmp artifacts and ids). */
export function newAudioId() {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.wav`;
}

/**
 * Append one manifest entry (JSONL, append-only). `rel` is the path of the
 * artifact relative to audioDir (e.g. "tmp/m-xxx.wav"); `id` is the lookup
 * key used by GET /audio/<id>.
 *
 * `sing` records whether the artifact was synthesized as a song (bare
 * `(唱歌)` tag) so a later regenerate reproduces the same request faithfully.
 */
export async function manifestAppend(dir, { id, rel, sessionId = null, callId = null, text = "", voice = "", model = "", style = "", sing = false, createdAt }) {
  const entry = {
    id,
    sessionId,
    callId,
    path: rel,
    createdAt: createdAt || new Date().toISOString(),
    text,
    voice,
    model,
    style,
    sing: sing === true,
  };
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, MANIFEST_NAME), JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

/** Read all manifest entries (JSONL lines; corrupt lines are skipped). */
export async function manifestEntries(dir) {
  const file = join(dir, MANIFEST_NAME);
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      /* skip corrupt line */
    }
  }
  return entries;
}

/**
 * Find one manifest entry by id — the LATEST matching line wins. Regenerate
 * appends a fresh line under the same id (createdAt bump) without rewriting
 * the append-only JSONL, so lookups must prefer the newest record.
 */
export async function manifestFind(dir, id) {
  const entries = await manifestEntries(dir);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i] && entries[i].id === id) return entries[i];
  }
  return null;
}

/**
 * Confine a manifest `path` (relative to audioDir) inside audioDir: resolve
 * against dir and reject any traversal outside the subtree. Returns the
 * absolute path. Throws on escape or non-relative values.
 */
export function confinePath(dir, rel) {
  const resolvedDir = resolve(dir);
  const abs = resolve(resolvedDir, rel);
  const relCheck = relative(resolvedDir, abs);
  if (relCheck === "" || relCheck === ".." || relCheck.startsWith(".." + sep)) {
    throw new Error(`path escapes audioDir: ${rel}`);
  }
  return abs;
}

/** Absolute path of a manifest entry (confinement-checked). */
export function entryAbsolutePath(dir, entry) {
  if (!entry || typeof entry.path !== "string") throw new Error("manifest entry has no path");
  return confinePath(dir, entry.path);
}

/** stat() the tmp/ dir (for tests/diagnostics): {entries, bytes}. */
export async function tmpStats(dir) {
  const tmp = join(dir, TMP_DIR);
  let names = [];
  try {
    names = await readdir(tmp);
  } catch {
    return { entries: 0, bytes: 0 };
  }
  let bytes = 0;
  for (const name of names) {
    try {
      bytes += (await stat(join(tmp, name))).size;
    } catch {
      /* skip */
    }
  }
  return { entries: names.length, bytes };
}

/**
 * Parse the duration of a PCM WAV file from its header. Chunk-scanning: both
 * the `fmt ` and `data` chunks are located by walking RIFF chunks (encoders
 * may emit JUNK/LIST chunks anywhere), and the fmt fields are read at the fmt
 * chunk's own offsets. Returns seconds (fractional) or 0 when the buffer is
 * not a parseable PCM WAV.
 */
export function wavDurationSeconds(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return 0;
  const id = (offset) => buf.toString("ascii", offset, offset + 4);
  if (id(0) !== "RIFF" || id(8) !== "WAVE") return 0;
  let fmt = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = id(offset);
    const size = buf.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") {
      fmt = { offset, size };
    } else if (chunkId === "data") {
      data = { offset, size };
      break; // data is the last chunk we care about
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data || fmt.size < 16) return 0;
  const f = fmt.offset + 8;
  const audioFormat = buf.readUInt16LE(f);
  if (audioFormat !== 1 && audioFormat !== 0xfffe) return 0; // PCM (or WAVE_FORMAT_EXTENSIBLE)
  const channels = buf.readUInt16LE(f + 2);
  const sampleRate = buf.readUInt32LE(f + 4);
  const blockAlign = buf.readUInt16LE(f + 12);
  if (channels === 0 || sampleRate === 0 || blockAlign === 0) return 0;
  const dataBytes = Math.min(data.size, buf.length - data.offset - 8);
  return dataBytes / (sampleRate * blockAlign);
}

/**
 * Decide where a stored speech artifact lands + whether it gets a manifest
 * row. `outPath` (the caller-resolved destination when the user gave one) is
 * used as-is and never forced into audioDir; without it the artifact goes to
 * audioDir/long/<id> + manifest entry (playable/downloadable via /audio/<id>).
 */
export function planSpeechArtifact({ outPath, audioDir, id, text, voice, model, style = "", sing = false, sessionId = null, callId = null }) {
  if (outPath) {
    return { path: outPath, manifest: null };
  }
  const rel = `${LONG_DIR}/${id}`;
  return {
    path: join(audioDir, rel),
    manifest: {
      id,
      rel,
      // Only plain string ids may ride the manifest (a non-string value would
      // pollute archive/regenerate lookups).
      sessionId: typeof sessionId === "string" ? sessionId : null,
      callId: typeof callId === "string" ? callId : null,
      text,
      voice,
      model,
      style: typeof style === "string" ? style : "",
      sing: sing === true,
    },
  };
}

/**
 * Clean every long-term artifact of one session (archive cleanup): delete
 * the `long/` files whose manifest entry carries `sessionId`, and keep the
 * manifest lines — they are the parameter record (text/voice/model/style/
 * sing) a later "重新生成" needs. Tmp artifacts (🔊 read-aloud) are
 * session-less and untouched; session logs are never touched. Idempotent:
 * a missing file is skipped, a missing dir is a no-op.
 *
 * Returns { removed, entries } — how many files were deleted and how many
 * manifest entries referenced them.
 */
export async function cleanupSessionArtifacts(dir, sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return { removed: 0, entries: 0 };
  const entries = await manifestEntries(dir);
  const victims = entries.filter((entry) => (
    entry && entry.sessionId === sessionId &&
    typeof entry.path === "string" && entry.path.startsWith(LONG_DIR + "/")
  ));
  let removed = 0;
  for (const entry of victims) {
    const abs = confinePath(dir, entry.path);
    try {
      await rm(abs); // throws ENOENT when already gone — count real deletions only
      removed++;
    } catch {
      /* missing file is fine — already cleaned */
    }
  }
  return { removed, entries: victims.length };
}

/**
 * The live long-term inventory for retention: the LATEST manifest line per
 * long/ id (regenerate bumps createdAt by appending), plus whether the file
 * still exists on disk. Never touches tmp/.
 * Returns [{ id, createdAt, exists, path }] sorted by createdAt ascending.
 */
export async function longLiveEntries(dir) {
  const latest = new Map();
  for (const entry of await manifestEntries(dir)) {
    if (!entry || typeof entry.path !== "string" || !entry.path.startsWith(LONG_DIR + "/")) continue;
    // First seen wins the map slot only if absent; we want the LAST line per
    // id, so overwrite unconditionally (entries come in append order).
    latest.set(entry.id, entry);
  }
  const rows = [];
  for (const entry of latest.values()) {
    let exists = false;
    let abs = null;
    try {
      abs = confinePath(dir, entry.path);
      exists = (await stat(abs)).isFile();
    } catch {
      exists = false;
    }
    rows.push({ id: entry.id, createdAt: entry.createdAt, exists, path: abs });
  }
  rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return rows;
}

/**
 * Loose retention fallback: keep at most `count` live long/ artifacts and
 * none older than `days`. Runs after every long/ write and on host startup —
 * archive cleanup is the primary path, this only stops the disk growing
 * forever when the user never archives.
 *
 * Deletes files only (manifest lines stay as the regenerate parameter
 * record). Returns { removed }.
 */
export async function enforceLongRetention(dir, { count = 200, days = 30 } = {}) {
  const rows = await longLiveEntries(dir);
  const live = rows.filter((row) => row.exists);
  const cutoff = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
  const doomed = new Set();
  for (const row of live) {
    if (cutoff > 0) {
      const t = Date.parse(String(row.createdAt));
      if (Number.isFinite(t) && t < cutoff) doomed.add(row.id);
    }
  }
  const survivors = live.filter((row) => !doomed.has(row.id));
  const over = survivors.length - Math.max(1, count);
  for (let i = 0; i < over && i < survivors.length; i++) doomed.add(survivors[i].id);
  let removed = 0;
  for (const row of rows) {
    if (!doomed.has(row.id) || !row.path) continue;
    try {
      await rm(row.path, { force: true });
      removed++;
    } catch {
      /* already gone */
    }
  }
  return { removed };
}
