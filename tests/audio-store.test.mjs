// dsh-mimo-agent-tools — audio-store unit tests (ported from dsh-voice-mimo
// tests/audio-store.test.js, adapted for the merged package: #4).
//
// Deliberate deviation from the voice-mimo port: the audio store resolves to
// NATIVE Windows paths (resolveDshHome already returns one; the store is
// consumed by node fs directly, not by the shell pipeline). The old
// wslPathOf conversion lived in the WSL-era host and is gone.
//
// Pure file-system logic: audioDir resolution, tmp/long init, idempotent
// startup cleanup, JSONL manifest append/find, path confinement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import {
  MANIFEST_NAME,
  defaultAudioDir,
  resolveAudioDir,
  initAudioStore,
  cleanTmp,
  newAudioId,
  manifestAppend,
  manifestEntries,
  manifestFind,
  confinePath,
  entryAbsolutePath,
  tmpStats,
  wavDurationSeconds,
  planSpeechArtifact,
  cleanupSessionArtifacts,
  enforceLongRetention,
  longLiveEntries,
} from "../audio-store.js";

/** Build a minimal PCM WAV buffer: optional JUNK chunk, fmt (+ cbSize) + data. */
function buildWav({ channels = 1, sampleRate = 24000, bits = 16, dataBytes = 48000, fmtExtra = false, junkBeforeFmt = false } = {}) {
  const fmtSize = fmtExtra ? 18 : 16;
  const junkSize = junkBeforeFmt ? 12 : 0; // JUNK payload, word-aligned
  const fmtStart = 12 + (junkSize ? 8 + junkSize : 0);
  const dataStart = fmtStart + 8 + fmtSize; // both branches word-aligned
  const total = dataStart + 8 + dataBytes;
  const buf = Buffer.alloc(total);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(total - 8, 4);
  buf.write("WAVE", 8, "ascii");
  if (junkBeforeFmt) {
    buf.write("JUNK", 12, "ascii");
    buf.writeUInt32LE(junkSize, 16);
  }
  buf.write("fmt ", fmtStart, "ascii");
  buf.writeUInt32LE(fmtSize, fmtStart + 4);
  buf.writeUInt16LE(1, fmtStart + 8); // PCM
  buf.writeUInt16LE(channels, fmtStart + 10);
  buf.writeUInt32LE(sampleRate, fmtStart + 12);
  buf.writeUInt32LE(sampleRate * channels * (bits / 8), fmtStart + 16);
  buf.writeUInt16LE(channels * (bits / 8), fmtStart + 20);
  buf.writeUInt16LE(bits, fmtStart + 22);
  if (fmtExtra) buf.writeUInt16LE(0, fmtStart + 8 + fmtSize - 2); // cbSize
  buf.write("data", dataStart, "ascii");
  buf.writeUInt32LE(dataBytes, dataStart + 4);
  return buf;
}

async function tempAudioDir() {
  const root = await mkdtemp(join(tmpdir(), "mimo-agent-store-"));
  return join(root, "audio");
}

test("resolveAudioDir: default under dshHome/cache/dsh-mimo-agent-tools", () => {
  const out = resolveAudioDir({}, "C:\\Users\\u\\.dsh");
  assert.equal(out, join("C:\\Users\\u\\.dsh", "cache", "dsh-mimo-agent-tools"));
});

test("resolveAudioDir: empty/whitespace dir falls back to default", () => {
  const out = resolveAudioDir({ audio: { dir: "  " } }, "C:\\h\\.dsh");
  assert.equal(out, join("C:\\h\\.dsh", "cache", "dsh-mimo-agent-tools"));
});

test("resolveAudioDir: explicit dir wins, kept native (no WSL conversion)", () => {
  const out = resolveAudioDir({ audio: { dir: "C:\\data\\audio" } }, "C:\\h\\.dsh");
  assert.equal(out, "C:\\data\\audio");
  assert.ok(isAbsolute(out));
});

test("resolveAudioDir: relative dir resolves against dshHome", () => {
  const out = resolveAudioDir({ audio: { dir: "audio-store" } }, "C:\\h\\.dsh");
  assert.equal(resolve(out), resolve("C:\\h\\.dsh", "audio-store"));
});

test("initAudioStore: creates tmp/ + long/ idempotently", async () => {
  const dir = await tempAudioDir();
  await initAudioStore(dir);
  await initAudioStore(dir); // second call must not throw
  const entries = await readdir(dir);
  assert.ok(entries.includes("tmp"));
  assert.ok(entries.includes("long"));
});

test("cleanTmp: removes previous tmp contents, idempotent, never touches long/", async () => {
  const dir = await tempAudioDir();
  await initAudioStore(dir);
  await mkdir(join(dir, "tmp", "sub"), { recursive: true });
  await writeFile(join(dir, "tmp", "a.wav"), "aaa");
  await writeFile(join(dir, "tmp", "sub", "b.wav"), "bbb");
  await writeFile(join(dir, "long", "keep.wav"), "keep");
  await cleanTmp(dir);
  assert.deepEqual(await readdir(join(dir, "tmp")), []);
  assert.deepEqual(await readdir(join(dir, "long")), ["keep.wav"]);
  await cleanTmp(dir); // already clean → no-op
  assert.deepEqual(await readdir(join(dir, "tmp")), []);
});

test("newAudioId: unique, .wav, safe charset", () => {
  const a = newAudioId();
  const b = newAudioId();
  assert.notEqual(a, b);
  assert.match(a, /^m-[A-Za-z0-9-]+\.wav$/);
});

test("manifestAppend/Entries/Find: append-only JSONL round-trip", async () => {
  const dir = await tempAudioDir();
  await initAudioStore(dir);
  await manifestAppend(dir, { id: "m-1.wav", rel: "tmp/m-1.wav", text: "你好", voice: "alloy", model: "mimo-v2.5-tts" });
  await manifestAppend(dir, { id: "m-2.wav", rel: "long/m-2.wav", sessionId: "s1", callId: "c1", style: "温柔" });
  const entries = await manifestEntries(dir);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, "m-1.wav");
  assert.equal(entries[0].path, "tmp/m-1.wav");
  assert.equal(entries[0].createdAt.length > 0, true);
  assert.equal(entries[1].sessionId, "s1");
  assert.equal(entries[1].style, "温柔"); // style persists to the manifest (regenerate replay)
  const found = await manifestFind(dir, "m-2.wav");
  assert.equal(found.callId, "c1");
  assert.equal(await manifestFind(dir, "nope.wav"), null);
  // corrupt line is skipped, good lines survive
  const raw = await readFile(join(dir, MANIFEST_NAME), "utf8");
  await writeFile(join(dir, MANIFEST_NAME), raw + "{not json}\n");
  assert.equal((await manifestEntries(dir)).length, 2);
});

test("manifestEntries: missing manifest → empty", async () => {
  const dir = await tempAudioDir();
  assert.deepEqual(await manifestEntries(dir), []);
});

test("confinePath: rejects traversal outside audioDir", () => {
  const dir = resolve("C:\\data\\audio");
  assert.equal(confinePath(dir, "tmp/x.wav"), join(dir, "tmp", "x.wav"));
  assert.throws(() => confinePath(dir, "../evil.wav"));
  assert.throws(() => confinePath(dir, "tmp/../../evil.wav"));
  assert.throws(() => confinePath(dir, "C:\\etc\\passwd"));
  assert.throws(() => confinePath(dir, ""));
});

test("entryAbsolutePath: resolves manifest path confined", async () => {
  const dir = await tempAudioDir();
  await initAudioStore(dir);
  await writeFile(join(dir, "tmp", "m-9.wav"), "data");
  const entry = { id: "m-9.wav", path: "tmp/m-9.wav" };
  assert.equal(entryAbsolutePath(dir, entry), join(dir, "tmp", "m-9.wav"));
  assert.throws(() => entryAbsolutePath(dir, { path: "../escape.wav" }));
  assert.throws(() => entryAbsolutePath(dir, null));
});

test("tmpStats: counts entries and bytes", async () => {
  const dir = await tempAudioDir();
  await initAudioStore(dir);
  assert.deepEqual(await tmpStats(dir), { entries: 0, bytes: 0 });
  await writeFile(join(dir, "tmp", "a.wav"), "12345");
  const stats = await tmpStats(dir);
  assert.equal(stats.entries, 1);
  assert.equal(stats.bytes, 5);
});

test("defaultAudioDir: join under home", () => {
  assert.equal(defaultAudioDir("C:\\h\\.dsh"), join("C:\\h\\.dsh", "cache", "dsh-mimo-agent-tools"));
});

// ── wavDurationSeconds: WAV header parsing (from voice-mimo #3) ──

test("wavDurationSeconds: mono 24kHz 16-bit 1s", () => {
  assert.equal(wavDurationSeconds(buildWav({ dataBytes: 48000 })), 1);
});

test("wavDurationSeconds: stereo 48kHz 16-bit 1s", () => {
  assert.equal(wavDurationSeconds(buildWav({ channels: 2, sampleRate: 48000, dataBytes: 192000 })), 1);
});

test("wavDurationSeconds: 8-bit mono 8kHz 2s", () => {
  assert.equal(wavDurationSeconds(buildWav({ bits: 8, sampleRate: 8000, dataBytes: 16000 })), 2);
});

test("wavDurationSeconds: fmt with cbSize extension still parses", () => {
  assert.equal(wavDurationSeconds(buildWav({ fmtExtra: true, dataBytes: 48000 })), 1);
});

test("wavDurationSeconds: JUNK chunk before fmt is scanned past", () => {
  assert.equal(wavDurationSeconds(buildWav({ junkBeforeFmt: true, dataBytes: 48000 })), 1);
});

test("wavDurationSeconds: non-PCM audioFormat (e.g. IEEE float 3) → 0", () => {
  const buf = buildWav({ dataBytes: 48000 });
  buf.writeUInt16LE(3, 20); // audioFormat = IEEE float
  assert.equal(wavDurationSeconds(buf), 0);
});

test("wavDurationSeconds: truncated / non-WAV / too short → 0", () => {
  assert.equal(wavDurationSeconds(Buffer.alloc(10)), 0);
  assert.equal(wavDurationSeconds(Buffer.from("not a wav file at all")), 0);
  const junk = buildWav({ dataBytes: 48000 });
  junk.write("XXXX", 0, "ascii"); // corrupt RIFF magic
  assert.equal(wavDurationSeconds(junk), 0);
  assert.equal(wavDurationSeconds(null), 0);
  assert.equal(wavDurationSeconds(Buffer.alloc(0)), 0);
});

// ── planSpeechArtifact: long/ + manifest vs explicit outPath ──

test("planSpeechArtifact: no outPath → long/ + manifest entry", () => {
  const plan = planSpeechArtifact({
    outPath: null,
    audioDir: "C:\\data\\audio",
    id: "m-x.wav",
    text: "你好",
    voice: "alloy",
    model: "mimo-v2.5-tts",
    style: "温柔",
    sing: true,
    sessionId: "s1",
    callId: "c1",
  });
  assert.equal(plan.path, join("C:\\data\\audio", "long", "m-x.wav"));
  assert.deepEqual(plan.manifest, {
    id: "m-x.wav",
    rel: "long/m-x.wav",
    sessionId: "s1",
    callId: "c1",
    text: "你好",
    voice: "alloy",
    model: "mimo-v2.5-tts",
    style: "温柔",
    sing: true,
  });
});

test("planSpeechArtifact: explicit outPath → caller path, no manifest", () => {
  const plan = planSpeechArtifact({
    outPath: "C:\\Users\\me\\out.wav",
    audioDir: "C:\\data\\audio",
    id: "m-x.wav",
    text: "hi",
    voice: "alloy",
    model: "mimo-v2.5-tts",
    sessionId: "s1",
    callId: "c1",
  });
  assert.equal(plan.path, "C:\\Users\\me\\out.wav");
  assert.equal(plan.manifest, null);
});

test("planSpeechArtifact: non-string sessionId/callId are coerced to null (regression)", () => {
  const plan = planSpeechArtifact({
    outPath: null,
    audioDir: "C:\\data\\audio",
    id: "m-x.wav",
    text: "t",
    voice: "v",
    model: "m",
    sessionId: { some: "object" }, // what exec.agent.session used to be
    callId: 42,
  });
  assert.equal(plan.manifest.sessionId, null);
  assert.equal(plan.manifest.callId, null);
});

// ── archive cleanup + loose retention (voice-mimo #5 semantics) ──

test("cleanupSessionArtifacts: deletes the session's long/ files, keeps manifest lines, never touches others", async () => {
  const dir = await tempAudioDir();
  await initAudioStore(dir);
  // s1 has two artifacts, s2 one, plus a tmp 🔊 artifact with no session.
  await writeFile(join(dir, "long", "m-a.wav"), "AAA");
  await manifestAppend(dir, { id: "m-a.wav", rel: "long/m-a.wav", sessionId: "s1", callId: "c1", text: "a" });
  await writeFile(join(dir, "long", "m-b.wav"), "BBB");
  await manifestAppend(dir, { id: "m-b.wav", rel: "long/m-b.wav", sessionId: "s1", callId: "c2", text: "b" });
  await writeFile(join(dir, "long", "m-c.wav"), "CCC");
  await manifestAppend(dir, { id: "m-c.wav", rel: "long/m-c.wav", sessionId: "s2", callId: "c3", text: "c" });
  await writeFile(join(dir, "tmp", "m-t.wav"), "TTT");
  await manifestAppend(dir, { id: "m-t.wav", rel: "tmp/m-t.wav", text: "t" });

  const out = await cleanupSessionArtifacts(dir, "s1");
  assert.deepEqual(out, { removed: 2, entries: 2 });
  // s1's files gone, others untouched
  await assert.rejects(readFile(join(dir, "long", "m-a.wav")));
  await assert.rejects(readFile(join(dir, "long", "m-b.wav")));
  assert.equal(await readFile(join(dir, "long", "m-c.wav"), "utf8"), "CCC");
  assert.equal(await readFile(join(dir, "tmp", "m-t.wav"), "utf8"), "TTT");
  // manifest lines survive (regenerate parameter record)
  assert.equal((await manifestFind(dir, "m-a.wav")).text, "a");
  assert.equal((await manifestFind(dir, "m-c.wav")).text, "c");
  // idempotent
  assert.deepEqual(await cleanupSessionArtifacts(dir, "s1"), { removed: 0, entries: 2 });
  // non-string / empty session ids are no-ops
  assert.deepEqual(await cleanupSessionArtifacts(dir, ""), { removed: 0, entries: 0 });
});

test("manifestFind: latest line wins for a duplicated id (regenerate append)", async () => {
  const dir = await tempAudioDir();
  await manifestAppend(dir, { id: "m-x.wav", rel: "long/m-x.wav", sessionId: "s1", callId: "c1", text: "first", createdAt: "2020-01-01T00:00:00.000Z" });
  await manifestAppend(dir, { id: "m-x.wav", rel: "long/m-x.wav", sessionId: "s1", callId: "c1", text: "first", createdAt: "2026-01-01T00:00:00.000Z" });
  const entry = await manifestFind(dir, "m-x.wav");
  assert.equal(entry.createdAt, "2026-01-01T00:00:00.000Z");
});

test("enforceLongRetention: prunes oldest beyond count, keeps newest, manifest survives", async () => {
  const dir = await tempAudioDir();
  await initAudioStore(dir);
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  for (let i = 1; i <= 5; i++) {
    const id = `m-${i}.wav`;
    await writeFile(join(dir, "long", id), `F${i}`);
    await manifestAppend(dir, {
      id, rel: `long/${id}`, sessionId: "s1", callId: `c${i}`, text: `t${i}`,
      createdAt: new Date(base + i * 60_000).toISOString(),
    });
  }
  const out = await enforceLongRetention(dir, { count: 3, days: 0 });
  assert.equal(out.removed, 2); // oldest two (m-1, m-2) pruned
  await assert.rejects(readFile(join(dir, "long", "m-1.wav")));
  await assert.rejects(readFile(join(dir, "long", "m-2.wav")));
  assert.equal(await readFile(join(dir, "long", "m-3.wav"), "utf8"), "F3");
  assert.equal(await readFile(join(dir, "long", "m-5.wav"), "utf8"), "F5");
  // manifest lines all survive
  assert.equal((await manifestEntries(dir)).length, 5);
});

test("enforceLongRetention: prunes older than days; skips already-missing files", async () => {
  const dir = await tempAudioDir();
  await initAudioStore(dir);
  const now = Date.now();
  await writeFile(join(dir, "long", "m-old.wav"), "OLD");
  await manifestAppend(dir, { id: "m-old.wav", rel: "long/m-old.wav", sessionId: "s1", callId: "c1", text: "old", createdAt: new Date(now - 40 * 24 * 3600 * 1000).toISOString() });
  await writeFile(join(dir, "long", "m-new.wav"), "NEW");
  await manifestAppend(dir, { id: "m-new.wav", rel: "long/m-new.wav", sessionId: "s1", callId: "c2", text: "new", createdAt: new Date(now - 1000).toISOString() });
  // a manifest line whose file was already archived-cleaned — nothing to do
  await manifestAppend(dir, { id: "m-gone.wav", rel: "long/m-gone.wav", sessionId: "s1", callId: "c3", text: "gone", createdAt: new Date(now - 1000).toISOString() });

  const out = await enforceLongRetention(dir, { count: 200, days: 30 });
  assert.equal(out.removed, 1); // only m-old (missing files aren't counted)
  await assert.rejects(readFile(join(dir, "long", "m-old.wav")));
  assert.equal(await readFile(join(dir, "long", "m-new.wav"), "utf8"), "NEW");
});

test("enforceLongRetention: regenerate-append bumps createdAt so a restored file is not immediately pruned", async () => {
  const dir = await tempAudioDir();
  await initAudioStore(dir);
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  await writeFile(join(dir, "long", "m-x.wav"), "V1");
  await manifestAppend(dir, { id: "m-x.wav", rel: "long/m-x.wav", sessionId: "s1", callId: "c1", text: "t", createdAt: old });
  // simulate regenerate: same id, fresh createdAt line
  await writeFile(join(dir, "long", "m-x.wav"), "V2");
  await manifestAppend(dir, { id: "m-x.wav", rel: "long/m-x.wav", sessionId: "s1", callId: "c1", text: "t" });
  // retention sees the LATEST createdAt per id (longLiveEntries) → survives
  const live = await longLiveEntries(dir);
  assert.equal(live.length, 1);
  assert.notEqual(live[0].createdAt, old);
  const out = await enforceLongRetention(dir, { count: 200, days: 30 });
  assert.equal(out.removed, 0);
  assert.equal(await readFile(join(dir, "long", "m-x.wav"), "utf8"), "V2");
});
