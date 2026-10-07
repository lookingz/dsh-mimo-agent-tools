// dsh-mimo-agent-tools — host route logic tests (ported from
// dsh-voice-mimo tests/web.test.js, issue #4).
//
// performSpeak / performAudio are the core of POST /speak and
// GET /audio/<id>.wav: synthesized wav lands in audioDir/tmp (never long/),
// manifest entry is recorded, and the audio endpoint resolves it confined.
// The settings namespace is gone (plugin Config via getConfig instead).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  performSpeak, performAudio, parseAudioId, speakHttp, audioHttp, AudioLookupError,
  performRegenerate, regenerateHttp, performArchiveCleanup, archiveCleanupHttp,
  ROUTE_PREFIX,
} from "../web.js";
import { manifestFind, manifestEntries, tmpStats, initAudioStore, manifestAppend } from "../audio-store.js";

async function makeDeps() {
  const root = await mkdtemp(join(tmpdir(), "mimo-agent-web-"));
  const audioDir = join(root, "audio");
  const config = {
    provider: { baseUrl: "https://api.xiaomimimo.com/v1", credential: "XIAOMI_API_KEY" },
    voiceMap: { alloy: { type: "preset", voice: "冰糖" } },
    tts: { model: "mimo-v2.5-tts", format: "wav", timeoutMs: 60000, voice: "alloy", style: "温柔" },
    audio: { dir: audioDir, inlineThreshold: 30 },
  };
  const ctx = {
    get: (name) => (name === "credentials" ? { resolve: async () => ({ value: "test-key" }) } : undefined),
  };
  const getConfig = () => config;
  return { ctx, getConfig, config, audioDir, root };
}

function okFetch(audioBytes) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { audio: { data: Buffer.from(audioBytes).toString("base64") } } }] }),
  });
}

/** n-second mono 24kHz PCM WAV so wavDurationSeconds returns a known value. */
function pcmWav(seconds = 1) {
  const dataBytes = 48000 * seconds;
  const buf = Buffer.alloc(12 + 8 + 16 + 8 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(24000, 24); buf.writeUInt32LE(48000, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

const oneSecondWav = () => pcmWav(1);

test("performSpeak: synthesizes into tmp/, returns audioUrl + seconds + inline flag, records manifest", async () => {
  const { ctx, getConfig, config, audioDir } = await makeDeps();
  const result = await performSpeak(ctx, getConfig, { text: " 你好世界 " }, { fetchImpl: okFetch(oneSecondWav()), dshHome: "C:\\h\\.dsh" });
  assert.equal(result.voice, "alloy");
  assert.equal(result.model, "mimo-v2.5-tts");
  assert.equal(result.seconds, 1);
  assert.equal(result.inline, true); // 1s <= inlineThreshold 30
  assert.match(result.audioUrl, new RegExp(`^${ROUTE_PREFIX}/audio/m-[A-Za-z0-9-]+\\.wav$`));
  const id = result.audioUrl.split("/").pop();
  // file is in tmp/ (read-aloud: play-once, discard), NOT long/
  assert.ok((await readFile(join(audioDir, "tmp", id))).length > 0);
  assert.deepEqual(await readdir(join(audioDir, "long")), []);
  const entry = await manifestFind(audioDir, id);
  assert.equal(entry.path, `tmp/${id}`);
  assert.equal(entry.text, "你好世界");
  assert.equal(entry.voice, "alloy");
  assert.equal(entry.model, "mimo-v2.5-tts");
  assert.ok(!("notify" in entry)); // auto read-aloud retired with the merge
  void config;
});

test("performSpeak: long speech over inlineThreshold → inline=false", async () => {
  const { ctx, getConfig, config } = await makeDeps();
  config.audio.inlineThreshold = 1;
  const result = await performSpeak(ctx, getConfig, { text: "hi" }, { fetchImpl: okFetch(pcmWav(2)), dshHome: "C:\\h\\.dsh" });
  assert.equal(result.seconds, 2);
  assert.equal(result.inline, false);
});

test("performSpeak: explicit voice override wins over config; config change applies live", async () => {
  const { ctx, getConfig, config } = await makeDeps();
  const a = await performSpeak(ctx, getConfig, { text: "hi" }, { fetchImpl: okFetch("x"), dshHome: "C:\\h\\.dsh" });
  assert.equal(a.voice, "alloy");
  const b = await performSpeak(ctx, getConfig, { text: "hi", voice: "fable" }, { fetchImpl: okFetch("x"), dshHome: "C:\\h\\.dsh" });
  assert.equal(b.voice, "fable");
  config.voiceMap.fable = { type: "voicedesign", voice: "温柔的女声" };
  config.tts.voice = "fable";
  const c = await performSpeak(ctx, getConfig, { text: "hi" }, { fetchImpl: okFetch("x"), dshHome: "C:\\h\\.dsh" });
  assert.equal(c.voice, "fable");
  assert.equal(c.model, "mimo-v2.5-tts-voicedesign");
});

test("performSpeak: empty text rejected", async () => {
  const { ctx, getConfig } = await makeDeps();
  await assert.rejects(performSpeak(ctx, getConfig, { text: "   " }, { fetchImpl: okFetch("x"), dshHome: "C:\\h\\.dsh" }), /text is required/);
});

test("performSpeak: voiceclone 朗读音色 without reference → friendly error", async () => {
  const { ctx, getConfig, config } = await makeDeps();
  config.voiceMap.echo = { type: "preset", voice: "苏打", model: "mimo-v2.5-tts-voiceclone" };
  config.tts.voice = "echo";
  await assert.rejects(
    performSpeak(ctx, getConfig, { text: "hi" }, { fetchImpl: okFetch("x"), dshHome: "C:\\h\\.dsh" }),
    /朗读音色 "echo" 映射到 voiceclone 模型/,
  );
});

test("performSpeak: MiMo HTTP error propagates with status", async () => {
  const { ctx, getConfig } = await makeDeps();
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => "boom" });
  await assert.rejects(performSpeak(ctx, getConfig, { text: "hi" }, { fetchImpl, dshHome: "C:\\h\\.dsh" }), /MiMo TTS HTTP 500: boom/);
});

test("performSpeak: missing credential → clear error", async () => {
  const { ctx, getConfig } = await makeDeps();
  ctx.get = () => undefined;
  await assert.rejects(performSpeak(ctx, getConfig, { text: "hi" }, { fetchImpl: okFetch("x"), dshHome: "C:\\h\\.dsh" }), /credentials service is unavailable/);
});

test("performAudio: resolves a synthesized id to the confined file", async () => {
  const { ctx, getConfig, audioDir } = await makeDeps();
  const { audioUrl } = await performSpeak(ctx, getConfig, { text: "hi" }, { fetchImpl: okFetch("WAVDATA"), dshHome: "C:\\h\\.dsh" });
  const id = audioUrl.split("/").pop();
  const out = await performAudio(ctx, getConfig, id);
  assert.equal(out.path, join(audioDir, "tmp", id));
  assert.equal(out.bytes, 7);
  assert.equal((await readFile(out.path, "utf8")), "WAVDATA");
});

test("performAudio: unknown id → not found", async () => {
  const { ctx, getConfig } = await makeDeps();
  await assert.rejects(performAudio(ctx, getConfig, "m-nope.wav"), /not found/);
});

test("performAudio: traversal id rejected by pattern", async () => {
  const { ctx, getConfig } = await makeDeps();
  for (const evil of ["../settings.yaml", "..%2F..%2Fetc%2Fpasswd", "m-1.wav/../../x", "a.wav?x=1"]) {
    await assert.rejects(performAudio(ctx, getConfig, evil), /invalid audio id/);
  }
});

test("parseAudioId: strict wav pattern", () => {
  assert.equal(parseAudioId("m-abc123.wav"), "m-abc123.wav");
  assert.throws(() => parseAudioId("m-1.mp3"));
  assert.throws(() => parseAudioId(""));
  assert.throws(() => parseAudioId(null));
});

test("speak leaves tmp countable via tmpStats", async () => {
  const { ctx, getConfig, audioDir } = await makeDeps();
  await performSpeak(ctx, getConfig, { text: "one" }, { fetchImpl: okFetch("x"), dshHome: "C:\\h\\.dsh" });
  const stats = await tmpStats(audioDir);
  assert.equal(stats.entries, 1);
  assert.equal(stats.bytes, 1);
});

// ── HTTP decision layer (speakHttp / audioHttp): status + JSON mapping ──

test("speakHttp: missing/empty text → 400 invalid-request", async () => {
  const { ctx, getConfig } = await makeDeps();
  for (const body of [null, {}, { text: "" }, { text: "   " }, { text: 42 }]) {
    const out = await speakHttp(ctx, getConfig, body, { fetchImpl: okFetch("x"), dshHome: "C:\\h\\.dsh" });
    assert.equal(out.status, 400);
    assert.equal(out.json.error.code, "invalid-request");
  }
});

test("speakHttp: success → 200 with audioUrl; MiMo failure → 500 speak-error", async () => {
  const { ctx, getConfig } = await makeDeps();
  const ok = await speakHttp(ctx, getConfig, { text: "你好" }, { fetchImpl: okFetch("WAV"), dshHome: "C:\\h\\.dsh" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.match(ok.json.value.audioUrl, new RegExp(`^${ROUTE_PREFIX}/audio/`));
  const fail = await speakHttp(ctx, getConfig, { text: "你好" }, {
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom" }),
    dshHome: "C:\\h\\.dsh",
  });
  assert.equal(fail.status, 500);
  assert.equal(fail.json.error.code, "speak-error");
  assert.match(fail.json.error.message, /MiMo TTS HTTP 500/);
});

test("audioHttp: unknown/invalid id → 404; cleaned (file gone) → 410; real fs failure → 500", async () => {
  const { ctx, getConfig, audioDir } = await makeDeps();
  const missing = await audioHttp(ctx, getConfig, "m-nope.wav");
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "audio-not-found");
  const evil = await audioHttp(ctx, getConfig, "../settings.yaml");
  assert.equal(evil.status, 404);
  const { audioUrl } = await performSpeak(ctx, getConfig, { text: "hi" }, { fetchImpl: okFetch("x"), dshHome: "C:\\h\\.dsh" });
  const id = audioUrl.split("/").pop();
  await rm(join(audioDir, "tmp", id));
  const cleaned = await audioHttp(ctx, getConfig, id);
  assert.equal(cleaned.status, 410);
  assert.equal(cleaned.json.error.code, "audio-cleaned");
  // manifest entry survives the cleanup (regenerate parameters intact)
  const entry = await manifestFind(audioDir, id);
  assert.equal(entry.text, "hi");
});

test("audioHttp: success → 200 with path + bytes", async () => {
  const { ctx, getConfig } = await makeDeps();
  const { audioUrl } = await performSpeak(ctx, getConfig, { text: "hi" }, { fetchImpl: okFetch("WAVDATA"), dshHome: "C:\\h\\.dsh" });
  const id = audioUrl.split("/").pop();
  const out = await audioHttp(ctx, getConfig, id);
  assert.equal(out.status, 200);
  assert.equal(out.bytes, 7);
  assert.equal((await readFile(out.path, "utf8")), "WAVDATA");
});

test("AudioLookupError: distinguish missing (404) from io (500)", () => {
  assert.ok(new AudioLookupError("not-found", "x") instanceof Error);
  assert.equal(new AudioLookupError("not-found", "x").code, "not-found");
});

test("audioHttp: long/ manifest artifact streams like tmp/", async () => {
  const { ctx, getConfig, audioDir } = await makeDeps();
  await initAudioStore(audioDir);
  const id = "m-long.wav";
  await mkdir(join(audioDir, "long"), { recursive: true });
  await writeFile(join(audioDir, "long", id), "LONGDATA");
  await manifestAppend(audioDir, { id, rel: `long/${id}`, sessionId: "s1", callId: "c1", text: "hi", voice: "alloy", model: "m" });
  const out = await audioHttp(ctx, getConfig, id);
  assert.equal(out.status, 200);
  assert.equal(out.bytes, 8);
  assert.equal(out.path, join(audioDir, "long", id));
  assert.equal((await readFile(out.path, "utf8")), "LONGDATA");
});

// ── 🔊 speak 路由应用 tts.style（混合机制，与 mimo_tts store 共用 ./mimo applyStyle）──

function capturingFetch(calls) {
  return async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { audio: { data: Buffer.from("x").toString("base64") } } }] }) };
  };
}

test("performSpeak: preset voice applies Config tts.style into the user message", async () => {
  const { ctx, getConfig, config } = await makeDeps();
  config.tts.style = "沉稳庄重";
  const calls = [];
  await performSpeak(ctx, getConfig, { text: "任务完成" }, { fetchImpl: capturingFetch(calls), dshHome: "C:\\h\\.dsh" });
  const payload = calls[0];
  assert.equal(payload.messages[0].content, "沉稳庄重"); // preset → natural-language user message
  assert.equal(payload.messages[1].content, "任务完成");
});

test("performSpeak: explicit request style overrides Config", async () => {
  const { ctx, getConfig } = await makeDeps();
  const calls = [];
  await performSpeak(ctx, getConfig, { text: "hi", style: "轻快" }, { fetchImpl: capturingFetch(calls), dshHome: "C:\\h\\.dsh" });
  assert.equal(calls[0].messages[0].content, "轻快");
});

test("performSpeak: voicedesign voice → (style) tag prefix, voice description kept in user message", async () => {
  const { ctx, getConfig, config } = await makeDeps();
  config.voiceMap.fable = { type: "voicedesign", voice: "温柔治愈系女声" };
  const calls = [];
  await performSpeak(ctx, getConfig, { text: "晚安", voice: "fable" }, { fetchImpl: capturingFetch(calls), dshHome: "C:\\h\\.dsh" });
  const payload = calls[0];
  assert.equal(payload.messages[0].content, "温柔治愈系女声"); // description preserved
  assert.equal(payload.messages[1].content, "(温柔)晚安"); // style as tag prefix (config default 温柔)
});

test("performSpeak: over-long read-aloud text is truncated and flagged", async () => {
  const { ctx, getConfig } = await makeDeps();
  const calls = [];
  const longText = "字".repeat(2600);
  const out = await performSpeak(ctx, getConfig, { text: longText }, { fetchImpl: capturingFetch(calls), dshHome: "C:\\h\\.dsh" });
  assert.equal(out.truncated, true);
  assert.equal(Array.from(calls[0].messages[1].content).length, 2500);
});

test("performSpeak: manifest entry records the applied style", async () => {
  const { ctx, getConfig, config, audioDir } = await makeDeps();
  config.tts.style = "活泼";
  const { audioUrl } = await performSpeak(ctx, getConfig, { text: "hi" }, { fetchImpl: capturingFetch([]), dshHome: "C:\\h\\.dsh" });
  const id = audioUrl.split("/").pop();
  const entry = await manifestFind(audioDir, id);
  assert.equal(entry.style, "活泼");
});

// ── archive cleanup + regenerate ──

test("performArchiveCleanup: removes each listed session's long/ audio, leaves manifest + others", async () => {
  const { ctx, getConfig, audioDir } = await makeDeps();
  await initAudioStore(audioDir);
  await mkdir(join(audioDir, "long"), { recursive: true });
  await writeFile(join(audioDir, "long", "m-s1.wav"), "S1");
  await manifestAppend(audioDir, { id: "m-s1.wav", rel: "long/m-s1.wav", sessionId: "s1", callId: "c1", text: "one" });
  await writeFile(join(audioDir, "long", "m-s2.wav"), "S2");
  await manifestAppend(audioDir, { id: "m-s2.wav", rel: "long/m-s2.wav", sessionId: "s2", callId: "c2", text: "two" });
  const result = await performArchiveCleanup(ctx, getConfig, ["s1", "nope"]);
  assert.deepEqual(result.cleaned, [
    { sessionId: "s1", removed: 1 },
    { sessionId: "nope", removed: 0 },
  ]);
  await assert.rejects(readFile(join(audioDir, "long", "m-s1.wav")));
  assert.equal(await readFile(join(audioDir, "long", "m-s2.wav"), "utf8"), "S2");
  // manifest survives (regenerate params intact)
  assert.equal((await manifestFind(audioDir, "m-s1.wav")).text, "one");
});

test("archiveCleanupHttp: non-array body → 400; success → 200 with per-session counts", async () => {
  const { ctx, getConfig } = await makeDeps();
  const bad = await archiveCleanupHttp(ctx, getConfig, {});
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "invalid-request");
  const ok = await archiveCleanupHttp(ctx, getConfig, { sessionIds: [] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.value.cleaned, []);
});

test("performRegenerate: re-synthesizes a cleaned long/ artifact under the same id, restores playability", async () => {
  const { ctx, getConfig, audioDir } = await makeDeps();
  await initAudioStore(audioDir);
  await mkdir(join(audioDir, "long"), { recursive: true });
  // a long/ artifact that was cleaned (file gone, manifest kept)
  await manifestAppend(audioDir, {
    id: "m-clean.wav", rel: "long/m-clean.wav", sessionId: "s9", callId: "c9",
    text: "欢迎回来", voice: "alloy", model: "mimo-v2.5-tts", style: "温柔",
  });
  // cleaned → 410 before regenerate
  assert.equal((await audioHttp(ctx, getConfig, "m-clean.wav")).status, 410);

  const calls = [];
  const result = await performRegenerate(ctx, getConfig, { sessionId: "s9", callId: "c9" }, { fetchImpl: capturingFetch(calls), dshHome: "C:\\h\\.dsh" });
  assert.equal(result.id, "m-clean.wav"); // SAME id — strip URL stays valid
  assert.equal(result.regenerated, true);
  assert.equal(result.audioUrl, `${ROUTE_PREFIX}/audio/m-clean.wav`);
  assert.equal(result.bytes, 1);
  // request reproduced from the manifest record (style rides the user message)
  assert.equal(calls[0].messages[0].content, "温柔");
  assert.equal(calls[0].messages[1].content, "欢迎回来");
  // file restored under long/, playable again
  assert.equal(await readFile(join(audioDir, "long", "m-clean.wav"), "utf8"), "x");
  assert.equal((await audioHttp(ctx, getConfig, "m-clean.wav")).status, 200);
  // manifest gained a regenerate line (createdAt bump) — latest wins
  const all = await manifestEntries(audioDir);
  assert.equal(all.filter((e) => e.id === "m-clean.wav").length, 2);
});

test("performRegenerate: unknown (sessionId, callId) pair → not-found; missing params → invalid-request", async () => {
  const { ctx, getConfig } = await makeDeps();
  await assert.rejects(
    performRegenerate(ctx, getConfig, { sessionId: "nope", callId: "nope" }, { fetchImpl: okFetch("x"), dshHome: "C:\\h\\.dsh" }),
    (e) => e instanceof AudioLookupError && e.code === "not-found",
  );
  await assert.rejects(
    performRegenerate(ctx, getConfig, { sessionId: "s", callId: "" }, { fetchImpl: okFetch("x"), dshHome: "C:\\h\\.dsh" }),
    (e) => e instanceof AudioLookupError && e.code === "invalid-request",
  );
});

test("performRegenerate: entry without a voice field falls back to the read-aloud default", async () => {
  const { ctx, getConfig, audioDir } = await makeDeps();
  await initAudioStore(audioDir);
  await mkdir(join(audioDir, "long"), { recursive: true });
  await manifestAppend(audioDir, { id: "m-novoice.wav", rel: "long/m-novoice.wav", sessionId: "s1", callId: "c1", text: "hi", model: "mimo-v2.5-tts" });
  const calls = [];
  const result = await performRegenerate(ctx, getConfig, { sessionId: "s1", callId: "c1" }, { fetchImpl: capturingFetch(calls), dshHome: "C:\\h\\.dsh" });
  assert.equal(result.voice, "alloy"); // config tts.voice default, not undefined
  assert.equal(calls[0].messages[0].content, "温柔"); // config tts.style default also applies
});

test("regenerateHttp: status mapping — 400 invalid / 404 not-found / 200 ok / 500 synthesis failure", async () => {
  const { ctx, getConfig, audioDir } = await makeDeps();
  await initAudioStore(audioDir);
  await mkdir(join(audioDir, "long"), { recursive: true });
  await manifestAppend(audioDir, { id: "m-r.wav", rel: "long/m-r.wav", sessionId: "s1", callId: "c1", text: "hi", voice: "alloy", model: "mimo-v2.5-tts", style: "温柔" });

  const invalid = await regenerateHttp(ctx, getConfig, { sessionId: "" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, "invalid-request");
  const missing = await regenerateHttp(ctx, getConfig, { sessionId: "x", callId: "y" });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "artifact-not-found");
  const ok = await regenerateHttp(ctx, getConfig, { sessionId: "s1", callId: "c1" }, { fetchImpl: okFetch("W"), dshHome: "C:\\h\\.dsh" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.value.id, "m-r.wav");
  const fail = await regenerateHttp(ctx, getConfig, { sessionId: "s1", callId: "c1" }, {
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom" }),
    dshHome: "C:\\h\\.dsh",
  });
  assert.equal(fail.status, 500);
  assert.equal(fail.json.error.code, "regenerate-error");
});
