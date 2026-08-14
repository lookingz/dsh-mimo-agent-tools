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
| `MIMO_DRIVER` | path to `driver/mimo_driver.py` | `/usr/local/lib/mimo-agent-tools/driver/mimo_driver.py` |
| `MIMO_TMP` | temp dir for spec/response files | `/tmp` |

Install the driver at the default path (or point `MIMO_DRIVER` at it):

```bash
sudo mkdir -p /usr/local/lib/mimo-agent-tools/driver
sudo cp driver/mimo_driver.py /usr/local/lib/mimo-agent-tools/driver/
```

## Why a python driver?

Multimodal payloads are multi-megabyte base64 strings. Agent shells commonly
cap captured stdout (DSH's bash seam caps at 64KB), which silently truncates
large payloads. The driver therefore does ALL file reading, body assembly and
HTTP POSTing inside one python3 process, using spec/response files on disk —
nothing large ever crosses the shell.

## Install (DSH)

This is a Cordis Host plugin. In a DSH session, define it with the Cordis
toolset (or mount it in an agent preset composition), passing `src/index.js`
as the host half, with `XIAOMI_API_KEY` exported in the DSH environment.

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
