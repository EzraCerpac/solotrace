from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

YOUTUBE_MAX_DURATION_SECONDS = 30 * 60
YOUTUBE_DOWNLOAD_TIMEOUT_SECONDS = 10 * 60
YOUTUBE_MAX_URL_LENGTH = 2_048
YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
}
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
CookieBrowser = Literal["none", "chrome", "safari"]


class YouTubeImportError(RuntimeError):
    pass


@dataclass(frozen=True)
class YouTubeDownload:
    path: Path
    title: str
    artist: str
    canonical_url: str


def canonicalize_youtube_url(value: str) -> str:
    raw = value.strip()
    if not raw or len(raw) > YOUTUBE_MAX_URL_LENGTH:
        raise ValueError("Paste one valid YouTube video link")
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as error:
        raise ValueError("Paste one valid YouTube video link") from error
    hostname = (parsed.hostname or "").rstrip(".").casefold()
    if (
        parsed.scheme.casefold() != "https"
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
    ):
        raise ValueError("YouTube links must use normal HTTPS addresses")

    video_id: str | None = None
    parts = [part for part in parsed.path.split("/") if part]
    if hostname == "youtu.be":
        if len(parts) == 1:
            video_id = parts[0]
    elif hostname in YOUTUBE_HOSTS:
        if parsed.path.rstrip("/") == "/watch":
            candidates = parse_qs(parsed.query, keep_blank_values=True).get("v", [])
            if len(candidates) == 1:
                video_id = candidates[0]
        elif len(parts) == 2 and parts[0] in {"embed", "live", "shorts"}:
            video_id = parts[1]
    if video_id is None or not VIDEO_ID.fullmatch(video_id):
        raise ValueError("Paste a single YouTube video, Short, or live-video link")
    return urlunsplit(
        ("https", "www.youtube.com", "/watch", urlencode({"v": video_id}), "")
    )


def _configured_tool(variable: str, executable: str) -> Path | None:
    configured = os.environ.get(variable)
    if configured:
        path = Path(configured).expanduser()
        return path if path.is_file() and os.access(path, os.X_OK) else None
    discovered = shutil.which(executable)
    return Path(discovered) if discovered else None


def youtube_tools() -> tuple[Path | None, Path | None]:
    return (
        _configured_tool("SOLOTRACE_YTDLP", "yt-dlp"),
        _configured_tool("SOLOTRACE_DENO", "deno"),
    )


def installed_cookie_browsers(home: Path | None = None) -> list[str]:
    user_home = home or Path.home()
    browsers: list[str] = []
    if (user_home / "Library/Application Support/Google/Chrome").is_dir():
        browsers.append("chrome")
    if (user_home / "Library/Cookies/Cookies.binarycookies").is_file() or (
        Path("/System/Applications/Safari.app").is_dir()
        or Path("/Applications/Safari.app").is_dir()
    ):
        browsers.append("safari")
    return browsers


def youtube_capability() -> dict[str, object]:
    downloader, deno = youtube_tools()
    available = downloader is not None and deno is not None
    if downloader is None:
        disabled_reason = "YouTube importer is not included in this build."
    elif deno is None:
        disabled_reason = "YouTube JavaScript runtime is not included in this build."
    else:
        disabled_reason = ""
    return {
        "available": available,
        "cookieBrowsers": installed_cookie_browsers(),
        "maxDurationS": YOUTUBE_MAX_DURATION_SECONDS,
        "disabledReason": disabled_reason,
    }


def _safe_download_error(stderr: str, browser: CookieBrowser) -> YouTubeImportError:
    detail = stderr.casefold()
    if "duration <=" in detail or "longer than" in detail and "minute" in detail:
        return YouTubeImportError("YouTube video is longer than 30 minutes")
    if "max-filesize" in detail or "file is larger" in detail:
        return YouTubeImportError("YouTube audio is larger than the 250 MB import limit")
    if browser != "none" and any(
        marker in detail
        for marker in ("cookie", "keychain", "operation not permitted", "permission denied")
    ):
        label = "Chrome" if browser == "chrome" else "Safari"
        return YouTubeImportError(
            f"SoloTrace could not read {label} cookies. Try Anonymous, another browser, "
            "or allow access in macOS Privacy settings."
        )
    if any(
        marker in detail
        for marker in (
            "confirm your age",
            "content is not available",
            "drm",
            "login required",
            "members-only",
            "private video",
            "sign in",
            "video unavailable",
        )
        ):
        return YouTubeImportError(
            "YouTube did not provide accessible audio. Try a signed-in browser "
            "or import a local file."
        )
    return YouTubeImportError(
        "YouTube import failed. Check the link and connection, or import a local audio file."
    )


def download_youtube_audio(
    url: str,
    destination: Path,
    *,
    cookie_browser: CookieBrowser,
    max_bytes: int,
    timeout_seconds: int = YOUTUBE_DOWNLOAD_TIMEOUT_SECONDS,
) -> YouTubeDownload:
    canonical_url = canonicalize_youtube_url(url)
    downloader, deno = youtube_tools()
    if downloader is None or deno is None:
        raise YouTubeImportError("YouTube importer is unavailable in this build")
    destination.mkdir(parents=True, exist_ok=True)
    output = destination / "source.%(ext)s"
    command = [
        str(downloader),
        "--ignore-config",
        "--no-config-locations",
        "--no-plugin-dirs",
        "--no-update",
        "--no-remote-components",
        "--no-js-runtimes",
        "--js-runtimes",
        f"deno:{deno}",
        "--no-playlist",
        "--max-downloads",
        "1",
        "--no-cache-dir",
        "--no-write-comments",
        "--no-write-playlist-metafiles",
        "--write-info-json",
        "--clean-info-json",
        "--no-mtime",
        "--retries",
        "2",
        "--fragment-retries",
        "2",
        "--socket-timeout",
        "30",
        "--match-filters",
        f"duration <= {YOUTUBE_MAX_DURATION_SECONDS}",
        "--max-filesize",
        str(max_bytes),
        "--format",
        "m4a/bestaudio/best",
        "--output",
        str(output),
        "--quiet",
        "--no-warnings",
    ]
    if cookie_browser != "none":
        command.extend(["--cookies-from-browser", cookie_browser])
    command.extend(["--", canonical_url])
    try:
        environment = os.environ.copy()
        environment["DENO_DIR"] = str(destination / "deno-cache")
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env=environment,
        )
    except subprocess.TimeoutExpired as error:
        raise YouTubeImportError(
            "YouTube download took longer than 10 minutes. Try again or import a local file."
        ) from error
    except OSError as error:
        raise YouTubeImportError("YouTube importer could not start") from error
    if result.returncode != 0:
        raise _safe_download_error(result.stderr, cookie_browser)

    info_files = list(destination.glob("source.info.json"))
    audio_files = [
        path
        for path in destination.glob("source.*")
        if path.name != "source.info.json" and not path.name.endswith(".part")
    ]
    if len(info_files) != 1 or len(audio_files) != 1:
        raise YouTubeImportError("YouTube did not return one readable audio track")
    audio_path = audio_files[0]
    if audio_path.is_symlink() or not audio_path.is_file():
        raise YouTubeImportError("YouTube returned an unsafe audio file")
    if audio_path.stat().st_size <= 0:
        raise YouTubeImportError("YouTube returned an empty audio file")
    if audio_path.stat().st_size > max_bytes:
        raise YouTubeImportError("YouTube audio is larger than the 250 MB import limit")
    try:
        metadata = json.loads(info_files[0].read_text(encoding="utf-8"))
        duration = float(metadata["duration"])
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise YouTubeImportError("YouTube returned unreadable video information") from error
    if not 0.2 <= duration <= YOUTUBE_MAX_DURATION_SECONDS:
        raise YouTubeImportError("YouTube video must be between 0.2 seconds and 30 minutes")
    title = str(metadata.get("title") or "YouTube song").strip()[:120] or "YouTube song"
    artist = next(
        (
            str(metadata.get(field)).strip()
            for field in ("artist", "creator", "uploader", "channel")
            if metadata.get(field) and str(metadata.get(field)).strip()
        ),
        "",
    )[:120]
    return YouTubeDownload(
        path=audio_path,
        title=title,
        artist=artist,
        canonical_url=canonical_url,
    )
