#!/usr/bin/env bash
set -euo pipefail

MODEL="${HERMES_OLLAMA_MODEL:-gemma3:latest}"
URL="${HERMES_OLLAMA_URL:-http://127.0.0.1:11434/api/generate}"

if [ "$#" -gt 0 ]; then
  PROMPT_B64="$(printf '%s' "$*" | base64 | tr -d '\n')"
else
  PROMPT_B64="$(base64 | tr -d '\n')"
fi

python3 - "$MODEL" "$URL" "$PROMPT_B64" <<'PY'
import base64
import json
import sys
import urllib.error
import urllib.request

model, url, prompt_b64 = sys.argv[1:4]
prompt = base64.b64decode(prompt_b64.encode("utf-8")).decode("utf-8")

payload = {
    "model": model,
    "stream": False,
    "system": (
        "You are Hermes Agent CLI running on the Eburon VPS. "
        "Act as an autonomous engineering agent. Return direct, useful execution output."
    ),
    "prompt": prompt,
}

request = urllib.request.Request(
    url,
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST",
)

try:
    with urllib.request.urlopen(request, timeout=180) as response:
        data = json.loads(response.read().decode("utf-8"))
        print(data.get("response", "").strip())
except urllib.error.HTTPError as exc:
    sys.stderr.write(exc.read().decode("utf-8", errors="replace"))
    sys.exit(1)
except Exception as exc:
    sys.stderr.write(str(exc))
    sys.exit(1)
PY
