# mimo-agent-tools

DSH (DeepSeek Harness) Cordis plugin that turns the **Xiaomi MiMo API** into
model tools for an agent: web search, image/audio/video understanding,
speech-to-text, and text-to-speech.

Backed by the OpenAI-compatible endpoint `https://api.xiaomimimo.com/v1`.

## Tools

| Tool | Model | Purpose |
|---|---|---|
| `mimo_search` | mimo-v2.5-pro | Web search via the native `web_search` tool, returns answer + cited sources |
| `mimo_vision` | mimo-v2.5 | Image understanding — local files (auto base64) or public URLs, multi-image |
| `mimo_audio` | mimo-v2.5 | Audio understanding / transcription (wav/mp3/flac/ogg/m4a) |
| `mimo_video` | mimo-v2.5 | Video understanding from a public URL (mp4/webm/mov) |
| `mimo_asr` | mimo-v2.5-asr | Speech-to-text with optional language hint |
| `mimo_tts` | mimo-v2.5-tts / -voicedesign | Text-to-speech to a `.wav` file — preset voices or free-form voice design |
| `mimo_voiceclone` | mimo-v2.5-tts-voiceclone | Voice cloning — reference clip + text → speech in that voice |

## audio-tools skill

The plugin registers an `audio-tools` skill that guides when to use the four
audio tools (`mimo_asr`, `mimo_tts`, `mimo_voiceclone`, `mimo_audio`). The
tools themselves are always registered — they are lightweight pure-API calls —
so the skill only teaches usage, it does not gate the tools.

## Requirements

- A [MiMo API key](https://mimo.mi.com) — the `web_search` tool requires the
  connected-search plugin enabled in the MiMo console.
- `python3` on the host (used by `driver/mimo_driver.py`).
- DSH host with the `shell` and `sandboxPolicy` services.

## Configuration

The API key is resolved at tool-call time from the **DSH credentials
service** first (key name `XIAOMI_API_KEY` — the web Models page writes keys
there), falling back to the environment. **Nothing is hardcoded**:

| Source | Key | Priority |
|---|---|---|
| DSH credentials service (`~/.dsh/.credentials.yaml`, web Models page) | `XIAOMI_API_KEY` | 1 |
| Environment | `XIAOMI_API_KEY` or `MIMO_API_KEY` | 2 |

Other options (environment, read at apply time):

| Env var | Purpose | Default |
|---|---|---|
| `MIMO_DRIVER` | path to `driver/mimo_driver.py` | `~/.local/lib/mimo-agent-tools/driver/mimo_driver.py` |
| `MIMO_TMP` | temp dir for spec/response files | `/tmp` |

Install the driver at the default path (or point `MIMO_DRIVER` at it):

```bash
mkdir -p ~/.local/lib/mimo-agent-tools/driver
cp driver/mimo_driver.py ~/.local/lib/mimo-agent-tools/driver/
```

## Why a python driver?

Multimodal payloads are multi-megabyte base64 strings. Agent shells commonly
cap captured stdout (DSH's bash seam caps at 64KB), which silently truncates
large payloads. The driver therefore does ALL file reading, body assembly and
HTTP POSTing inside one python3 process, using spec/response files on disk —
nothing large ever crosses the shell.

## Install (DSH bundle)

Standard DSH bundle — install with the official plugin command (auto-inits
the profile, pnpm-installs, and appends the bundle layer per
`dsh.bundle.patch`):

```bash
# From a local checkout, or via git/npm:
dsh plugin --profile web add /path/to/dsh-mimo-agent-tools
# or: dsh plugin --profile web add github:you/dsh-mimo-agent-tools

# Install the python driver to the default path (MIMO_DRIVER points at it):
mkdir -p ~/.local/lib/mimo-agent-tools/driver
cp driver/mimo_driver.py ~/.local/lib/mimo-agent-tools/driver/

# Restart dsh web; the tools mount automatically.
```

Dependencies are declared as `peerDependencies` (ecosystem convention —
`@deepseek-ai/dsh-tools` is already loaded in the DSH process, so nothing is
duplicated). `dsh plugin add` installs the bundle into the profile's
node_modules where peer deps resolve against the running harness.


## Notes on the MiMo API (from the official docs)

- TTS target text goes in the **assistant** message; the voice description
  (voicedesign model) goes in the **user** message.
- `mimo-v2.5-tts-voicedesign` does **not** accept an `audio.voice` field — it
  uses `optimize_text_preview` instead.
- ASR (`mimo-v2.5-asr`) must **not** receive a `thinking` field.
- Web search costs per keyword round (`max_keyword`, default 3) — see MiMo
  pricing.

## License

MIT
