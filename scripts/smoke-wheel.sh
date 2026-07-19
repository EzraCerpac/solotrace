#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/solotrace-wheel.XXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM

cd "$project_root"
export UV_CACHE_DIR="$project_root/.uv-cache"
pnpm --dir web build
uv build --wheel --out-dir "$scratch/dist"
uv venv "$scratch/venv" --python 3.11
uv pip install \
  --python "$scratch/venv/bin/python" \
  "$scratch"/dist/solotrace-*.whl \
  'httpx>=0.28.1,<0.29'

SOLOTRACE_DATA_DIR="$scratch/data" "$scratch/venv/bin/python" -c '
import re

from fastapi.testclient import TestClient
from solotrace.api import app

with TestClient(app) as client:
    response = client.get("/")
    response.raise_for_status()
    assert "SoloTrace" in response.text
    script_path = re.search(r"<script[^>]+src=\"([^\"]+)\"", response.text)
    assert script_path is not None
    script = client.get(script_path.group(1))
    script.raise_for_status()
    assert "javascript" in script.headers["content-type"]

print("installed wheel serves bundled SoloTrace UI")
'
