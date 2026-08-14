#!/usr/bin/env python3
"""MiMo multimodal driver — file-based API relay.

Reads a request spec from a JSON file (argv[1]), reads any local media files
referenced in it, assembles the chat body, POSTs to the MiMo (Xiaomi) API, and
writes the raw response to argv[2].

Nothing large ever crosses stdout/stderr — all I/O is file based. This matters
because agent shells commonly cap captured stdout (e.g. DSH's bash seam caps
at 64KB), which would silently truncate multi-megabyte base64 payloads.

Usage:
    python3 mimo_driver.py <spec.json> <response.out>

Spec JSON shape:
{
  "model": "mimo-v2.5" | "mimo-v2.5-asr" | "mimo-v2.5-tts" | ...,
  "key": "api key",
  "url": "https://api.xiaomimimo.com/v1/chat/completions",
  "timeout": 90,
  "prompt": "user text prompt",
  "kind": "vision" | "audio" | "asr" | "chat",
  "language": "zh" | undefined,
  "files": [ {"kind": "image"|"audio", "mime": "image/png", "path": "/abs/path"} ],
  "urls": ["https://..."]            // for vision: public image URLs
}
"""
import json
import sys
import base64
import urllib.request
import urllib.error


def build_body(spec):
    model = spec["model"]
    kind = spec.get("kind", "chat")
    parts = []

    for f in spec.get("files", []):
        with open(f["path"], "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        uri = "data:%s;base64,%s" % (f["mime"], b64)
        if f["kind"] == "image":
            parts.append({"type": "image_url", "image_url": {"url": uri}})
        else:
            parts.append({"type": "input_audio", "input_audio": {"data": uri}})

    for u in spec.get("urls", []):
        parts.append({"type": "image_url", "image_url": {"url": u}})

    prompt = spec.get("prompt", "")
    if kind == "asr":
        if prompt:
            parts.append({"type": "text", "text": prompt})
        body = {"model": model, "messages": [{"role": "user", "content": parts}], "stream": False}
        lang = spec.get("language")
        if lang:
            body["asr_options"] = {"language": lang}
        return body
    if not prompt and kind == "chat":
        prompt = "Please respond."
    parts.append({"type": "text", "text": prompt})
    return {
        "model": model,
        "messages": [{"role": "user", "content": parts}],
        "stream": False,
        "max_completion_tokens": 2048,
        "thinking": {"type": "disabled"},
    }


def main():
    spec_path, out_path = sys.argv[1], sys.argv[2]
    with open(spec_path, "r", encoding="utf-8") as fh:
        spec = json.load(fh)
    body = build_body(spec)
    req = urllib.request.Request(
        spec["url"],
        data=json.dumps(body).encode(),
        headers={"api-key": spec["key"], "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=spec.get("timeout", 90)) as resp:
            data = resp.read()
        with open(out_path, "wb") as fh:
            fh.write(data)
        print("OK")
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", "replace")
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write("HTTP_ERR:" + err[:800])
        print("FAIL")
    except Exception as ex:  # noqa: BLE001
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write("NET_ERR:" + str(ex)[:300])
        print("FAIL")


if __name__ == "__main__":
    main()
