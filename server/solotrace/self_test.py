from __future__ import annotations

import io
import json
import subprocess
import tempfile
import zipfile

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

from .audio import ffmpeg_available
from .config import Settings
from .demo import DEMO_ID


def run() -> None:
    settings = Settings.load()
    assert settings.packaged
    assert settings.web_dist.joinpath("index.html").is_file()
    assert ffmpeg_available()
    from .youtube import youtube_tools

    ytdlp, deno = youtube_tools()
    assert ytdlp is not None and deno is not None
    subprocess.run([str(ytdlp), "--version"], check=True, capture_output=True, timeout=30)
    subprocess.run([str(deno), "--version"], check=True, capture_output=True, timeout=30)
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=settings.data_dir) as temporary:
        workspace = settings.data_dir.joinpath(temporary)
        tone_path = workspace / "a4.wav"
        notes_path = workspace / "notes.json"
        sample_rate = 22_050
        time = np.arange(sample_rate * 2, dtype=np.float32) / sample_rate
        sf.write(tone_path, 0.25 * np.sin(2 * np.pi * 440 * time), sample_rate)
        subprocess.run(
            [
                *settings.basic_pitch_command,
                str(settings.basic_pitch_worker),
                str(tone_path),
                str(notes_path),
                "--minimum-frequency",
                "80",
                "--maximum-frequency",
                "1400",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=180,
        )
        notes = json.loads(notes_path.read_text())
        assert any(note["pitch"] == 69 for note in notes)

    from .chords import _session, recognition_capability

    assert recognition_capability()["available"]
    assert _session().get_inputs()[0].shape[-2:] == [108, 144]

    from .api import app

    with TestClient(app) as client:
        assert client.get("/").status_code == 200
        project = client.get(f"/api/projects/{DEMO_ID}").json()
        assert project["tab"]["notes"]
        assert client.get(f"/media/{DEMO_ID}/backing.wav").content
        bundle = client.get(f"/api/projects/{DEMO_ID}/export/bundle")
        bundle.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(bundle.content)) as archive:
            assert any(name.endswith("/project.json") for name in archive.namelist())
        diagnostics = client.get("/api/diagnostics/export")
        diagnostics.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(diagnostics.content)) as archive:
            assert "diagnostic.json" in archive.namelist()
