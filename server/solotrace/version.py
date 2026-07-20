from __future__ import annotations

import os
import sys
from importlib.metadata import PackageNotFoundError, version

try:
    APP_VERSION = version("solotrace")
except PackageNotFoundError:
    APP_VERSION = "0.0.0"

BUILD_ID = os.environ.get("SOLOTRACE_BUILD_ID", "dev").strip() or "dev"
PACKAGED = bool(getattr(sys, "frozen", False))

