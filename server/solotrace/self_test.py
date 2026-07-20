from __future__ import annotations

import io
import zipfile

from fastapi.testclient import TestClient

from .audio import ffmpeg_available
from .config import Settings
from .demo import DEMO_ID


def run() -> None:
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import Model

    settings = Settings.load()
    assert settings.packaged
    assert settings.web_dist.joinpath("index.html").is_file()
    assert ffmpeg_available()
    Model(ICASSP_2022_MODEL_PATH)

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
