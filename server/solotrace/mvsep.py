from __future__ import annotations

import math
import time
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
import librosa
import numpy as np
import soundfile as sf

from .audio import AudioProcessingError

ProgressCallback = Callable[[str], None]
CancelCheck = Callable[[], bool]

_ACTIVE_STATUSES = {"waiting", "processing", "distributing", "merging"}
_ALLOWED_DOWNLOAD_HOSTS = {
    "mvsep.com",
    "de.mvsep.com",
    "de2.mvsep.com",
    "hk.mvsep.com",
}
_MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024


class MVSepCancelled(AudioProcessingError):
    pass


class MVSepApi:
    """Small, testable client for one MVSep lead/rhythm separation job."""

    def __init__(
        self,
        *,
        api_token: str,
        base_url: str,
        poll_seconds: float,
        timeout_seconds: float,
        client: httpx.Client | None = None,
        sleeper: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.api_token = api_token
        self.base_url = base_url.rstrip("/")
        self.poll_seconds = poll_seconds
        self.timeout_seconds = timeout_seconds
        self._client = client
        self._sleeper = sleeper
        self._clock = clock

    @staticmethod
    def _payload(response: httpx.Response, fallback: str) -> dict[str, Any]:
        try:
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise AudioProcessingError(fallback) from error
        if not isinstance(payload, dict):
            raise AudioProcessingError(fallback)
        return payload

    @staticmethod
    def _message(payload: dict[str, Any], fallback: str) -> str:
        data = payload.get("data")
        message = data.get("message") if isinstance(data, dict) else None
        if not isinstance(message, str) or not message.strip():
            return fallback
        return message.strip()[:300]

    def _cancel(self, client: httpx.Client, job_hash: str) -> None:
        with suppress(httpx.HTTPError):
            client.post(
                f"{self.base_url}/separation/cancel",
                data={"api_token": self.api_token, "hash": job_hash},
            )

    def _download(
        self,
        client: httpx.Client,
        raw_url: str,
        output_path: Path,
    ) -> None:
        url = urljoin(f"{self.base_url}/", raw_url)
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in _ALLOWED_DOWNLOAD_HOSTS:
            raise AudioProcessingError("MVSep returned an unsafe download URL")
        size = 0
        try:
            with client.stream("GET", url) as response:
                response.raise_for_status()
                final = urlparse(str(response.url))
                if final.scheme != "https" or final.hostname not in _ALLOWED_DOWNLOAD_HOSTS:
                    raise AudioProcessingError("MVSep redirected to an unsafe download URL")
                content_length = response.headers.get("content-length")
                if content_length:
                    try:
                        declared_size = int(content_length)
                    except ValueError as error:
                        raise AudioProcessingError(
                            "MVSep returned an invalid download size"
                        ) from error
                    if declared_size > _MAX_DOWNLOAD_BYTES:
                        raise AudioProcessingError(
                            "MVSep lead stem is unexpectedly large"
                        )
                with output_path.open("wb") as output:
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > _MAX_DOWNLOAD_BYTES:
                            raise AudioProcessingError("MVSep lead stem is unexpectedly large")
                        output.write(chunk)
        except httpx.HTTPError as error:
            raise AudioProcessingError("Could not download MVSep lead stem") from error

    @staticmethod
    def _lead_url(payload: dict[str, Any]) -> str:
        data = payload.get("data")
        files = data.get("files") if isinstance(data, dict) else None
        if not isinstance(files, list):
            raise AudioProcessingError("MVSep returned no output files")
        for file in files:
            if not isinstance(file, dict):
                continue
            name = " ".join(
                str(file.get(field, ""))
                for field in ("type", "name", "download")
            ).lower().replace("_", "-")
            url = file.get("url")
            if "lead-guitar" in name and isinstance(url, str):
                return url
        for file in files:
            if not isinstance(file, dict):
                continue
            name = str(file.get("name", "")).lower()
            url = file.get("url")
            if "lead" in name and isinstance(url, str):
                return url
        raise AudioProcessingError("MVSep did not return a lead-guitar stem")

    def separate(
        self,
        input_path: Path,
        output_path: Path,
        *,
        progress: ProgressCallback,
        cancelled: CancelCheck,
    ) -> None:
        if cancelled():
            raise MVSepCancelled("Draft cancelled")
        owned_client = self._client is None
        client = self._client or httpx.Client(
            timeout=httpx.Timeout(connect=20, read=90, write=90, pool=20),
            follow_redirects=True,
        )
        job_hash = ""
        try:
            progress("Uploading selected audio to MVSep")
            try:
                with input_path.open("rb") as audio:
                    response = client.post(
                        f"{self.base_url}/separation/create",
                        data={
                            "api_token": self.api_token,
                            "sep_type": "101",
                            "add_opt1": "1",
                            "output_format": "1",
                            "is_demo": "0",
                        },
                        files={"audiofile": (input_path.name, audio, "audio/wav")},
                    )
            except httpx.HTTPError as error:
                raise AudioProcessingError("Could not submit audio to MVSep") from error
            payload = self._payload(response, "MVSep rejected the separation request")
            data = payload.get("data")
            if payload.get("success") is not True or not isinstance(data, dict):
                raise AudioProcessingError(
                    self._message(payload, "MVSep rejected the separation request")
                )
            job_hash = str(data.get("hash", ""))
            if not job_hash:
                raise AudioProcessingError("MVSep returned no job identifier")

            started = self._clock()
            while True:
                if cancelled():
                    self._cancel(client, job_hash)
                    raise MVSepCancelled("Draft cancelled")
                if self._clock() - started > self.timeout_seconds:
                    self._cancel(client, job_hash)
                    raise AudioProcessingError("MVSep separation took longer than 30 minutes")
                try:
                    response = client.get(
                        f"{self.base_url}/separation/get",
                        params={"hash": job_hash},
                    )
                except httpx.HTTPError as error:
                    raise AudioProcessingError("Could not check MVSep job status") from error
                payload = self._payload(response, "MVSep returned an unreadable job status")
                status = str(payload.get("status", "")).lower()
                if status == "done":
                    progress("Downloading lossless lead stem")
                    self._download(client, self._lead_url(payload), output_path)
                    return
                if status == "failed" or payload.get("success") is False:
                    raise AudioProcessingError(
                        self._message(payload, "MVSep could not separate this audio")
                    )
                if status not in _ACTIVE_STATUSES:
                    raise AudioProcessingError(f"Unexpected MVSep job status: {status or 'empty'}")
                data = payload.get("data")
                if status in {"waiting", "distributing"} and isinstance(data, dict):
                    order = data.get("current_order")
                    progress(
                        f"Waiting in MVSep queue · {order} ahead"
                        if isinstance(order, int)
                        else "Waiting in MVSep queue"
                    )
                else:
                    progress("MVSep is isolating lead guitar")
                self._sleeper(self.poll_seconds)
        finally:
            if owned_client:
                client.close()


def create_mvsep_stems(
    original_path: Path,
    lead_path: Path,
    backing_path: Path,
    start_s: float,
    end_s: float,
    workspace: Path,
    *,
    api_token: str,
    base_url: str,
    poll_seconds: float,
    timeout_seconds: float,
    progress: ProgressCallback,
    cancelled: CancelCheck,
) -> tuple[int, float]:
    info = sf.info(original_path)
    sample_rate = info.samplerate
    start = max(0, round(start_s * sample_rate))
    end = min(info.frames, round(end_s * sample_rate))
    if end - start < sample_rate // 5:
        raise AudioProcessingError("Selected passage is too short")

    passage_path = workspace / "mvsep-input.wav"
    with sf.SoundFile(original_path) as source:
        source.seek(start)
        passage = source.read(end - start, always_2d=True, dtype="float32")
    sf.write(passage_path, passage, sample_rate, subtype="PCM_16")

    estimate_path = workspace / "mvsep-lead.wav"
    MVSepApi(
        api_token=api_token,
        base_url=base_url,
        poll_seconds=poll_seconds,
        timeout_seconds=timeout_seconds,
    ).separate(
        passage_path,
        estimate_path,
        progress=progress,
        cancelled=cancelled,
    )

    try:
        estimate, estimate_rate = sf.read(
            estimate_path,
            always_2d=True,
            dtype="float32",
        )
    except (OSError, RuntimeError) as error:
        raise AudioProcessingError("MVSep returned unreadable lead audio") from error
    returned_duration = len(estimate) / estimate_rate
    expected_duration = (end - start) / sample_rate
    if abs(returned_duration - expected_duration) > max(0.25, expected_duration * 0.02):
        raise AudioProcessingError("MVSep returned lead audio with the wrong duration")
    if estimate_rate != sample_rate:
        estimate = np.column_stack(
            [
                librosa.resample(
                    estimate[:, channel],
                    orig_sr=estimate_rate,
                    target_sr=sample_rate,
                )
                for channel in range(estimate.shape[1])
            ]
        )
    if estimate.shape[1] == 1 and info.channels > 1:
        estimate = np.repeat(estimate, info.channels, axis=1)
    estimate = np.nan_to_num(estimate[: end - start, : info.channels])
    if len(estimate) < end - start:
        estimate = np.pad(estimate, ((0, end - start - len(estimate)), (0, 0)))

    is_full_song = start == 0 and end == info.frames
    fade = 0 if is_full_song else min(round(sample_rate * 0.12), len(estimate) // 2)
    if fade:
        curve = 0.5 - 0.5 * np.cos(np.linspace(0, math.pi, fade))
        estimate[:fade] *= curve[:, None]
        estimate[-fade:] *= curve[::-1, None]

    block_size = 65_536
    cursor = 0
    with (
        sf.SoundFile(original_path) as source,
        sf.SoundFile(
            lead_path,
            mode="w",
            samplerate=sample_rate,
            channels=info.channels,
            subtype="PCM_16",
        ) as lead_output,
        sf.SoundFile(
            backing_path,
            mode="w",
            samplerate=sample_rate,
            channels=info.channels,
            subtype="PCM_16",
        ) as backing_output,
    ):
        while True:
            if cancelled():
                raise MVSepCancelled("Draft cancelled")
            block = source.read(block_size, always_2d=True, dtype="float32")
            if len(block) == 0:
                break
            lead_block = np.zeros_like(block)
            overlap_start = max(cursor, start)
            overlap_end = min(cursor + len(block), end)
            if overlap_end > overlap_start:
                source_left = overlap_start - start
                source_right = overlap_end - start
                block_left = overlap_start - cursor
                block_right = overlap_end - cursor
                lead_block[block_left:block_right] = estimate[source_left:source_right]
            lead_output.write(np.clip(lead_block, -1, 1))
            backing_output.write(np.clip(block - lead_block, -1, 1))
            cursor += len(block)
    return sample_rate, info.frames / sample_rate
