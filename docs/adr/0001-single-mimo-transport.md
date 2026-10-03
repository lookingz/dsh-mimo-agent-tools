# Single MiMo transport: agent-tools owns the API surface, voice-mimo becomes a pure UI consumer

dsh-voice-mimo and dsh-mimo-agent-tools both called the Xiaomi MiMo API with
their own transports: the agent tools through the python driver
(driver/mimo_driver.py), the voice tools through direct HTTPS to MiMo's
chat/completions private audio shape. Model migrations (e.g. the
mimo-v2.5 → V2.6 voice_understand default, due 2026-10-21) had to be done
twice. We merge: agent-tools is the only repo that speaks to MiMo;
voice-mimo keeps the browser UI and imports the client from agent-tools.

The decisive facts: the two tool sets were functional duplicates
(voice_transcribe/voice_speak/voice_understand ≈ mimo_asr/mimo_tts/mimo_audio);
the 🔊 read-aloud UI needs a TTS call but not its own transport; and the
browser 🎤 mic (Web Speech API) plus the understand-audio button are retired —
the mic duplicated agent-tools' official speechToText seam provider
(./speech), and audio analysis is already an agent task (mimo_audio), not a
composer button.

**Considered Options**

- A (chosen): voice tools are absorbed into agent-tools; voice-mimo slims to pure UI
  (🔊 read-aloud + speech strips + audio-store) depending on the
  dsh-mimo-agent-tools package. One MiMo transport; migrations land once.
- B: merge everything into one repo — rejected: agent-tools is host-only;
  absorbing react/client-inject web UI would wreck the package's granularity.
- C: keep both repos, just delete duplicate tools — rejected: two transports
  remain, every model migration still lands twice.

**Consequences**

- agent-tools exports a reusable (ctx-light) MiMo TTS/ASR client.
- Single repo (human decision 2026-10-03, revising the initial two-repo split):
  the browser UI moves into this package as a `./client` entry with
  `dsh.client` injection; the dsh-voice-mimo repo is retired and archived.
  The 🔊 read-aloud button and the in-conversation speech strips live here
  (read-aloud was broken at decision time — fix lands with the merge); the
  🎤 MicButton, the UnderstandButton, and the voice_* tools are dropped.
- Auto read-aloud (notify when the human is away from the loop) was planned
  but never used in practice — retired with this decision; re-addable if the
  away-notification scenario materializes.
- Settings: the vision-toolkit-style custom Settings page and the
  settings-compat shim are retired; configuration (voice map, voice, style)
  moves to the plugin Config surfaced through the alpha.1 Plugins settings
  tab (settings.plugins.tab, SettingsForms projection).
- Cost accepted: this package now carries both a host face and a react/client
  face — one package, two shapes; the maintenance win (one repo, one MiMo
  transport) outweighs the granularity loss for a two-person-scale surface.
