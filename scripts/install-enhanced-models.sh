#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export UV_CACHE_DIR="${UV_CACHE_DIR:-.uv-cache}"

uv venv --python 3.11 .workers/separate
uv pip install --python .workers/separate/bin/python \
  'demucs-mlx[convert]==1.4.4'

uv venv --python 3.11 .workers/transcribe
uv pip install --python .workers/transcribe/bin/python \
  basic-pitch==0.4.0 coremltools==9.0 setuptools==80.9.0

echo "Workers installed. htdemucs_6s downloads on first enhanced separation."
