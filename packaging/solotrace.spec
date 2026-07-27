from __future__ import annotations

import json
import os
import tomllib
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, copy_metadata

ROOT = Path.cwd()
PROJECT = tomllib.loads((ROOT / "pyproject.toml").read_text())
APP_VERSION = PROJECT["project"]["version"]
BUILD_METADATA = ROOT / "build" / "macos" / "solotrace-build.json"
BUILD_ID = str(json.loads(BUILD_METADATA.read_text())["buildId"])
SIGNING_IDENTITY = os.environ.get("SOLOTRACE_CODESIGN_IDENTITY", "-")


def is_test_artifact(value: str) -> bool:
    parts = value.replace("\\", "/").replace(".", "/").split("/")
    return any(
        part in {"test", "tests", "testing"} or part.startswith("test_")
        for part in parts
    )


datas = [
    (str(ROOT / "web" / "dist"), "solotrace/static"),
    (str(ROOT / "vendor" / "ffmpeg" / "bin"), "ffmpeg/bin"),
    (str(ROOT / "vendor" / "ffmpeg" / "LICENSE"), "licenses/ffmpeg"),
    (str(ROOT / "build" / "macos" / "licenses"), "licenses/python"),
    (str(ROOT / "docs" / "beta"), "Beta Guide"),
    (str(ROOT / "THIRD_PARTY_NOTICES.md"), "."),
    (str(ROOT / "PRIVATE_BETA_TERMS.md"), "."),
    (str(ROOT / "CHANGELOG.md"), "."),
    (
        str(ROOT / "server" / "solotrace" / "resources" / "chordmini"),
        "solotrace/resources/chordmini",
    ),
    (str(BUILD_METADATA), "."),
]
binaries = []
hiddenimports = [
    "solotrace.api",
    "solotrace.basic_pitch_worker",
    "solotrace.self_test",
    "onnxruntime",
]
for package in ("basic_pitch", "coremltools", "keyring", "webview"):
    package_datas, package_binaries, package_hiddenimports = collect_all(package)
    datas.extend(item for item in package_datas if not is_test_artifact(item[1]))
    binaries.extend(item for item in package_binaries if not is_test_artifact(item[1]))
    hiddenimports.extend(
        item for item in package_hiddenimports if not is_test_artifact(item)
    )
datas.extend(copy_metadata("solotrace"))

analysis = Analysis(
    [str(ROOT / "packaging" / "desktop_entry.py")],
    pathex=[str(ROOT / "server")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[str(ROOT / "packaging" / "runtime_build.py")],
    excludes=["demucs", "torch", "tensorflow"],
    noarchive=False,
)
pyz = PYZ(analysis.pure)
executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="SoloTrace",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    target_arch="arm64",
    codesign_identity=SIGNING_IDENTITY,
    entitlements_file=str(ROOT / "packaging" / "entitlements.plist"),
)
collection = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name="SoloTrace",
)
app = BUNDLE(
    collection,
    name="SoloTrace.app",
    icon=None,
    bundle_identifier="com.ezracerpac.solotrace",
    version=APP_VERSION,
    info_plist={
        "CFBundleDisplayName": "SoloTrace",
        "CFBundleShortVersionString": APP_VERSION,
        "CFBundleVersion": BUILD_ID,
        "LSMinimumSystemVersion": "14.0",
        "LSMultipleInstancesProhibited": True,
        "NSHighResolutionCapable": True,
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        "NSHumanReadableCopyright": "Copyright © 2026 Ezra Cerpac. All rights reserved.",
        "SoloTraceBuildID": BUILD_ID,
    },
)
