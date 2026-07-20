from __future__ import annotations

import json
import os
import sys
from pathlib import Path

resources = Path(getattr(sys, "_MEIPASS", Path.cwd()))
metadata = json.loads((resources / "solotrace-build.json").read_text())
os.environ.setdefault("SOLOTRACE_BUILD_ID", str(metadata["buildId"]))
