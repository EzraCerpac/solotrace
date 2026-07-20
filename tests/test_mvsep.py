from __future__ import annotations

import io

import httpx
import numpy as np
import pytest
import soundfile as sf
from solotrace.audio import AudioProcessingError
from solotrace.mvsep import MVSepApi, MVSepCancelled


def _wave_bytes() -> bytes:
    output = io.BytesIO()
    sf.write(output, np.zeros((4_410, 2), dtype=np.float32), 44_100, format="WAV")
    return output.getvalue()


def test_mvsep_client_submits_one_stage_and_downloads_lead(tmp_path) -> None:
    polls = 0
    wave = _wave_bytes()
    (tmp_path / "input.wav").write_bytes(wave)

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal polls
        if request.url.path == "/api/separation/create":
            body = request.read()
            assert b'name="sep_type"\r\n\r\n101' in body
            assert b'name="add_opt1"\r\n\r\n1' in body
            assert b'name="output_format"\r\n\r\n1' in body
            return httpx.Response(
                200,
                json={"success": True, "data": {"hash": "job-123"}},
            )
        if request.url.path == "/api/separation/get":
            polls += 1
            if polls == 1:
                return httpx.Response(
                    200,
                    json={
                        "success": True,
                        "status": "waiting",
                        "data": {"current_order": 2, "message": "Waiting"},
                    },
                )
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "status": "done",
                    "data": {
                        "files": [
                            {
                                "type": "Lead-guitar",
                                "download": "input_lead-guitar.wav",
                                "url": "https://de.mvsep.com/download/lead.wav",
                            },
                            {
                                "type": "Rhythm-guitar",
                                "download": "input_rhythm-guitar.wav",
                                "url": "https://de.mvsep.com/download/rhythm.wav",
                            },
                        ]
                    },
                },
            )
        if request.url.path == "/download/lead.wav":
            return httpx.Response(200, content=wave)
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    progress: list[str] = []
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        MVSepApi(
            api_token="secret",
            base_url="https://de.mvsep.com/api",
            poll_seconds=0,
            timeout_seconds=60,
            client=client,
            sleeper=lambda _: None,
        ).separate(
            tmp_path / "input.wav",
            tmp_path / "lead.wav",
            progress=progress.append,
            cancelled=lambda: False,
        )

    assert sf.info(tmp_path / "lead.wav").samplerate == 44_100
    assert progress == [
        "Uploading selected audio to MVSep",
        "Waiting in MVSep queue · 2 ahead",
        "Downloading lossless lead stem",
    ]


def test_mvsep_client_cancels_remote_job(tmp_path) -> None:
    wave = _wave_bytes()
    input_path = tmp_path / "input.wav"
    input_path.write_bytes(wave)
    cancelled_remote = False
    checks = iter([False, False, True])

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal cancelled_remote
        if request.url.path == "/api/separation/create":
            request.read()
            return httpx.Response(
                200,
                json={"success": True, "data": {"hash": "job-123"}},
            )
        if request.url.path == "/api/separation/get":
            return httpx.Response(
                200,
                json={"success": True, "status": "processing", "data": {}},
            )
        if request.url.path == "/api/separation/cancel":
            cancelled_remote = True
            return httpx.Response(200, json={"success": True})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    with (
        httpx.Client(transport=httpx.MockTransport(handler)) as client,
        pytest.raises(MVSepCancelled, match="Draft cancelled"),
    ):
        MVSepApi(
            api_token="secret",
            base_url="https://de.mvsep.com/api",
            poll_seconds=0,
            timeout_seconds=60,
            client=client,
            sleeper=lambda _: None,
        ).separate(
            input_path,
            tmp_path / "lead.wav",
            progress=lambda _: None,
            cancelled=lambda: next(checks, True),
        )

    assert cancelled_remote is True


def test_mvsep_rejects_final_redirect_outside_allowlist(tmp_path) -> None:
    wave = _wave_bytes()
    input_path = tmp_path / "input.wav"
    input_path.write_bytes(wave)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/separation/create":
            request.read()
            return httpx.Response(
                200,
                json={"success": True, "data": {"hash": "job-123"}},
            )
        if request.url.path == "/api/separation/get":
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "status": "done",
                    "data": {
                        "files": [
                            {
                                "type": "Lead-guitar",
                                "url": "https://de.mvsep.com/download/lead.wav",
                            }
                        ]
                    },
                },
            )
        if request.url.host == "de.mvsep.com":
            return httpx.Response(
                302,
                headers={"location": "https://attacker.invalid/lead.wav"},
            )
        if request.url.host == "attacker.invalid":
            return httpx.Response(200, content=wave)
        raise AssertionError(f"Unexpected request: {request.url}")

    output = tmp_path / "lead.wav"
    with (
        httpx.Client(
            transport=httpx.MockTransport(handler),
            follow_redirects=True,
        ) as client,
        pytest.raises(AudioProcessingError, match="unsafe download"),
    ):
        MVSepApi(
            api_token="secret",
            base_url="https://de.mvsep.com/api",
            poll_seconds=0,
            timeout_seconds=60,
            client=client,
        ).separate(
            input_path,
            output,
            progress=lambda _: None,
            cancelled=lambda: False,
        )
    assert not output.exists()


def test_mvsep_download_honors_cancellation_and_removes_partial_file(tmp_path) -> None:
    wave = _wave_bytes()
    input_path = tmp_path / "input.wav"
    input_path.write_bytes(wave)
    checks = iter([False, False, True])

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/separation/create":
            request.read()
            return httpx.Response(
                200,
                json={"success": True, "data": {"hash": "job-123"}},
            )
        if request.url.path == "/api/separation/get":
            return httpx.Response(
                200,
                json={
                    "success": True,
                    "status": "done",
                    "data": {
                        "files": [
                            {
                                "type": "Lead-guitar",
                                "url": "https://de.mvsep.com/download/lead.wav",
                            }
                        ]
                    },
                },
            )
        if request.url.path == "/download/lead.wav":
            return httpx.Response(200, content=wave)
        raise AssertionError(f"Unexpected request: {request.url}")

    output = tmp_path / "lead.wav"
    with (
        httpx.Client(transport=httpx.MockTransport(handler)) as client,
        pytest.raises(MVSepCancelled, match="Draft cancelled"),
    ):
        MVSepApi(
            api_token="secret",
            base_url="https://de.mvsep.com/api",
            poll_seconds=0,
            timeout_seconds=60,
            client=client,
        ).separate(
            input_path,
            output,
            progress=lambda _: None,
            cancelled=lambda: next(checks, True),
        )
    assert not output.exists()
