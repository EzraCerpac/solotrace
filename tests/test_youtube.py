from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from solotrace.api import app
from solotrace.demo import DEMO_ID
from solotrace.youtube import (
    YouTubeDownload,
    YouTubeImportError,
    canonicalize_youtube_url,
    download_youtube_audio,
)


@pytest.mark.parametrize(
    ("url", "canonical"),
    [
        (
            "https://www.youtube.com/watch?v=YE7VzlLtp-4",
            "https://www.youtube.com/watch?v=YE7VzlLtp-4",
        ),
        (
            "https://music.youtube.com/watch?v=YE7VzlLtp-4&list=album",
            "https://www.youtube.com/watch?v=YE7VzlLtp-4",
        ),
        (
            "https://youtu.be/YE7VzlLtp-4?t=12",
            "https://www.youtube.com/watch?v=YE7VzlLtp-4",
        ),
        (
            "https://youtube.com/shorts/YE7VzlLtp-4",
            "https://www.youtube.com/watch?v=YE7VzlLtp-4",
        ),
        (
            "https://m.youtube.com/live/YE7VzlLtp-4?feature=share",
            "https://www.youtube.com/watch?v=YE7VzlLtp-4",
        ),
    ],
)
def test_youtube_video_urls_are_canonicalized(url: str, canonical: str) -> None:
    assert canonicalize_youtube_url(url) == canonical


@pytest.mark.parametrize(
    "url",
    [
        "http://youtube.com/watch?v=YE7VzlLtp-4",
        "https://youtube.com.evil.test/watch?v=YE7VzlLtp-4",
        "https://evil.test/youtube.com/watch?v=YE7VzlLtp-4",
        "https://user@youtube.com/watch?v=YE7VzlLtp-4",
        "https://youtube.com:443/watch?v=YE7VzlLtp-4",
        "https://youtube.com/playlist?list=PL123",
        "https://youtube.com/@channel",
        "https://youtube.com/results?search_query=solo",
        "https://youtube.com/watch?v=too-short",
        "https://youtu.be/YE7VzlLtp-4/extra",
        "https://youtube.com/watch?v=YE7VzlLtp-4&v=AAAAAAAAAAA",
    ],
)
def test_non_video_and_host_attack_urls_are_rejected(url: str) -> None:
    with pytest.raises(ValueError):
        canonicalize_youtube_url(url)


def test_downloader_is_isolated_and_maps_metadata(tmp_path, monkeypatch) -> None:
    yt_dlp = tmp_path / "yt-dlp"
    deno = tmp_path / "deno"
    yt_dlp.touch(mode=0o700)
    deno.touch(mode=0o700)
    captured: list[str] = []

    def fake_run(command, **kwargs):
        captured.extend(command)
        (tmp_path / "source.m4a").write_bytes(b"audio")
        (tmp_path / "source.info.json").write_text(
            json.dumps(
                {
                    "duration": 1799.5,
                    "title": "  Authorized solo  ",
                    "artist": "",
                    "creator": "  Creator name ",
                    "uploader": "Channel fallback",
                }
            ),
            encoding="utf-8",
        )
        assert kwargs["check"] is False
        assert kwargs["capture_output"] is True
        assert kwargs["text"] is True
        assert kwargs["timeout"] == 600
        assert kwargs["env"]["DENO_DIR"] == str(tmp_path / "deno-cache")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr("solotrace.youtube.youtube_tools", lambda: (yt_dlp, deno))
    monkeypatch.setattr("solotrace.youtube.subprocess.run", fake_run)

    result = download_youtube_audio(
        "https://youtu.be/YE7VzlLtp-4?list=PL123",
        tmp_path,
        cookie_browser="chrome",
        max_bytes=250 * 1024 * 1024,
    )

    assert result.title == "Authorized solo"
    assert result.artist == "Creator name"
    assert result.canonical_url == "https://www.youtube.com/watch?v=YE7VzlLtp-4"
    assert result.path == tmp_path / "source.m4a"
    assert captured[0] == str(yt_dlp)
    assert "--ignore-config" in captured
    assert "--no-plugin-dirs" in captured
    assert "--no-update" in captured
    assert "--no-remote-components" in captured
    assert "--no-playlist" in captured
    assert captured[captured.index("--cookies-from-browser") + 1] == "chrome"
    separator = captured.index("--")
    assert captured[separator + 1 :] == [result.canonical_url]


def test_downloader_timeout_and_raw_errors_are_safe(tmp_path, monkeypatch) -> None:
    tool = tmp_path / "tool"
    tool.touch(mode=0o700)
    monkeypatch.setattr("solotrace.youtube.youtube_tools", lambda: (tool, tool))

    def time_out(command, **kwargs):
        raise subprocess.TimeoutExpired(command, kwargs["timeout"])

    monkeypatch.setattr("solotrace.youtube.subprocess.run", time_out)
    with pytest.raises(YouTubeImportError, match="10 minutes") as timeout_error:
        download_youtube_audio(
            "https://youtu.be/YE7VzlLtp-4",
            tmp_path,
            cookie_browser="none",
            max_bytes=100,
        )
    assert "YE7VzlLtp-4" not in str(timeout_error.value)

    monkeypatch.setattr(
        "solotrace.youtube.subprocess.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args[0], 1, "", "secret raw downloader output https://youtu.be/YE7VzlLtp-4"
        ),
    )
    with pytest.raises(YouTubeImportError) as failure:
        download_youtube_audio(
            "https://youtu.be/YE7VzlLtp-4",
            tmp_path,
            cookie_browser="none",
            max_bytes=100,
        )
    assert "secret raw downloader output" not in str(failure.value)
    assert "YE7VzlLtp-4" not in str(failure.value)


def test_youtube_api_requires_rights_and_returns_stored_source(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(
        "solotrace.api.youtube_capability",
        lambda: {
            "available": True,
            "cookieBrowsers": ["chrome"],
            "maxDurationS": 1800,
            "disabledReason": "",
        },
    )
    calls: list[dict[str, object]] = []

    def fake_download(url: str, destination: Path, **kwargs) -> YouTubeDownload:
        calls.append({"url": url, **kwargs})
        audio = destination / "source.m4a"
        audio.write_bytes(b"audio")
        return YouTubeDownload(
            path=audio,
            title="Imported from YouTube",
            artist="Authorized artist",
            canonical_url="https://www.youtube.com/watch?v=YE7VzlLtp-4",
        )

    def fake_create(**kwargs):
        calls.append(kwargs)
        project = kwargs["store"].get(DEMO_ID)
        assert project is not None
        return project.model_copy(
            update={
                "id": kwargs["project_id"],
                "title": kwargs["title"],
                "artist": kwargs["artist"],
                "source_name": kwargs["source_name"],
                "youtube_url": kwargs["youtube_url"],
                "demo": False,
            }
        )

    monkeypatch.setattr("solotrace.api.download_youtube_audio", fake_download)
    monkeypatch.setattr("solotrace.api._create_project_from_audio", fake_create)

    with TestClient(app) as client:
        denied = client.post(
            "/api/projects/youtube",
            json={
                "url": "https://youtu.be/YE7VzlLtp-4",
                "cookie_browser": "none",
                "rights_confirmed": False,
            },
        )
        imported = client.post(
            "/api/projects/youtube",
            json={
                "url": "https://youtu.be/YE7VzlLtp-4",
                "cookie_browser": "chrome",
                "rights_confirmed": True,
            },
        )

    assert denied.status_code == 422
    assert imported.status_code == 201
    assert imported.json()["title"] == "Imported from YouTube"
    assert imported.json()["artist"] == "Authorized artist"
    assert imported.json()["youtube_url"] == (
        "https://www.youtube.com/watch?v=YE7VzlLtp-4"
    )
    assert calls[0]["cookie_browser"] == "chrome"
    assert calls[1]["source_name"] == "YouTube"


def test_youtube_api_reports_missing_tools_without_downloading(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SOLOTRACE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(
        "solotrace.api.youtube_capability",
        lambda: {
            "available": False,
            "cookieBrowsers": [],
            "maxDurationS": 1800,
            "disabledReason": "YouTube importer is not included in this build.",
        },
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/projects/youtube",
            json={
                "url": "https://youtu.be/YE7VzlLtp-4",
                "cookie_browser": "none",
                "rights_confirmed": True,
            },
        )
    assert response.status_code == 503
    assert response.json()["detail"] == "YouTube importer is not included in this build."
