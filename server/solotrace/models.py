from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ProcessingEngine = Literal["preview", "mvsep"]
FingeringMode = Literal["balanced", "easiest", "position"]


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


class StrictModel(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")


class Confidence(StrictModel):
    pitch: float = Field(ge=0, le=1)
    onset: float = Field(ge=0, le=1)
    fingering: float = Field(ge=0, le=1)
    technique: float = Field(ge=0, le=1)

    @property
    def minimum(self) -> float:
        return min(self.pitch, self.onset, self.fingering, self.technique)


class Fingering(StrictModel):
    string: int = Field(ge=1, le=8)
    fret: int = Field(ge=0, le=36)
    label: str = ""
    cost: float = 0


class NoteEvent(StrictModel):
    id: str = Field(min_length=1, max_length=96)
    onset_frame: int = Field(ge=0)
    end_frame: int = Field(gt=0)
    audio_onset_s: float = Field(ge=0)
    audio_offset_s: float = Field(gt=0)
    score_tick: int = Field(ge=0)
    duration_ticks: int = Field(gt=0)
    midi_pitch: int = Field(ge=0, le=127)
    pitch_curve_cents: list[float] = Field(default_factory=list, max_length=512)
    string: int = Field(ge=1, le=8)
    fret: int = Field(ge=0, le=36)
    techniques: list[str] = Field(default_factory=list, max_length=16)
    confidence: Confidence
    alternatives: list[Fingering] = Field(default_factory=list, max_length=8)
    user_locked: bool = False
    reviewed: bool = False

    @model_validator(mode="after")
    def validate_ranges(self) -> NoteEvent:
        if self.end_frame <= self.onset_frame:
            raise ValueError("end_frame must be after onset_frame")
        if self.audio_offset_s <= self.audio_onset_s:
            raise ValueError("audio_offset_s must be after audio_onset_s")
        return self


class SyncAnchor(StrictModel):
    audio_frame: int = Field(ge=0)
    score_tick: int = Field(ge=0)


class TabDocument(StrictModel):
    sample_rate: int = Field(gt=0)
    ticks_per_quarter: int = Field(default=480, gt=0)
    tempo_bpm: float = Field(default=120, gt=20, le=400)
    time_signature: tuple[int, int] = (4, 4)
    tuning: list[int] = Field(default_factory=lambda: [40, 45, 50, 55, 59, 64])
    fret_count: int = Field(default=22, ge=12, le=36)
    sync_anchors: list[SyncAnchor] = Field(default_factory=list, max_length=5000)
    notes: list[NoteEvent] = Field(default_factory=list, max_length=10000)

    @field_validator("tuning")
    @classmethod
    def validate_tuning(cls, value: list[int]) -> list[int]:
        if not 4 <= len(value) <= 8:
            raise ValueError("tuning must contain 4 to 8 strings")
        if any(open_pitch < 0 or open_pitch > 127 for open_pitch in value):
            raise ValueError("open-string pitches must be valid MIDI notes")
        if any(value[index] >= value[index + 1] for index in range(len(value) - 1)):
            raise ValueError("tuning must run from lowest to highest pitch")
        return value

    @model_validator(mode="after")
    def validate_instrument_range(self) -> TabDocument:
        if max(self.tuning) + self.fret_count > 127:
            raise ValueError("tuning plus fret count exceeds the MIDI range")
        return self


class StageState(StrEnum):
    pending = "pending"
    running = "running"
    complete = "complete"
    failed = "failed"
    skipped = "skipped"


class PipelineStage(StrictModel):
    id: str
    label: str
    status: StageState = StageState.pending
    detail: str = ""


class RunState(StrEnum):
    idle = "idle"
    queued = "queued"
    running = "running"
    complete = "complete"
    failed = "failed"
    cancelled = "cancelled"


class ProcessingRun(StrictModel):
    id: str
    state: RunState = RunState.idle
    stages: list[PipelineStage] = Field(default_factory=list)
    message: str = ""
    error: str | None = None
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


class MediaAsset(StrictModel):
    role: Literal["original", "lead", "backing"]
    url: str
    filename: str
    duration_s: float = Field(gt=0)
    sample_rate: int = Field(gt=0)
    method: str


class Passage(StrictModel):
    name: str = "Solo 1"
    start_s: float = Field(ge=0)
    end_s: float = Field(gt=0)

    @model_validator(mode="after")
    def validate_range(self) -> Passage:
        if self.end_s <= self.start_s:
            raise ValueError("solo end must be after its start")
        return self


class TabVersion(StrictModel):
    id: str = Field(min_length=1, max_length=96)
    name: str = Field(min_length=1, max_length=80)
    source: str = Field(default="draft", max_length=120)
    fingering_mode: FingeringMode = "balanced"
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)
    tab: TabDocument


class Project(StrictModel):
    id: str
    title: str
    artist: str = ""
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)
    revision: int = Field(default=1, ge=1)
    duration_s: float = Field(gt=0)
    passage: Passage
    assets: list[MediaAsset]
    versions: list[TabVersion] = Field(min_length=1, max_length=100)
    active_version_id: str
    run: ProcessingRun
    source_name: str
    demo: bool = False
    trashed_at: str | None = None
    separation_scope: Literal["solo-guitar", "all-guitar", "preview", "exact"] = "preview"
    waveform_peaks: list[float] = Field(default_factory=list, max_length=5000)
    provenance: list[str] = Field(default_factory=list, max_length=64)

    @model_validator(mode="before")
    @classmethod
    def migrate_single_tab(cls, value: Any) -> Any:
        if not isinstance(value, dict) or "versions" in value:
            return value
        legacy = dict(value)
        raw_tab = legacy.pop("tab", None)
        if raw_tab is None:
            return value
        tab = dict(raw_tab)
        revision = int(tab.pop("revision", legacy.get("revision", 1)))
        created_at = str(legacy.get("created_at") or now_iso())
        updated_at = str(legacy.get("updated_at") or created_at)
        demo = bool(legacy.get("demo"))
        version_id = "version-demo" if demo else "version-original"
        legacy["revision"] = revision
        legacy["active_version_id"] = version_id
        legacy["versions"] = [
            {
                "id": version_id,
                "name": "Demo tab" if demo else "Original draft",
                "source": "demo" if demo else "legacy",
                "fingering_mode": "balanced",
                "created_at": created_at,
                "updated_at": updated_at,
                "tab": tab,
            }
        ]
        return legacy

    @model_validator(mode="after")
    def validate_versions(self) -> Project:
        version_ids = [version.id for version in self.versions]
        if len(version_ids) != len(set(version_ids)):
            raise ValueError("tab version ids must be unique")
        if self.active_version_id not in version_ids:
            raise ValueError("active tab version does not exist")
        return self

    @property
    def active_version(self) -> TabVersion:
        return next(
            version for version in self.versions if version.id == self.active_version_id
        )

    @property
    def tab(self) -> TabDocument:
        return self.active_version.tab

    def replace_active_tab(self, tab: TabDocument) -> Project:
        updated_at = now_iso()
        versions = [
            version.model_copy(update={"tab": tab, "updated_at": updated_at})
            if version.id == self.active_version_id
            else version
            for version in self.versions
        ]
        return self.model_copy(update={"versions": versions})

    def asset(self, role: str) -> MediaAsset | None:
        return next((asset for asset in self.assets if asset.role == role), None)


class TabVersionSummary(StrictModel):
    id: str
    name: str
    source: str
    fingering_mode: FingeringMode
    created_at: str
    updated_at: str
    note_count: int = Field(ge=0)
    needs_review_count: int = Field(ge=0)


class ProjectSummary(StrictModel):
    id: str
    title: str
    artist: str
    updated_at: str
    revision: int
    duration_s: float
    source_name: str
    demo: bool
    trashed_at: str | None
    active_version_id: str
    active_version_name: str
    note_count: int = Field(ge=0)
    needs_review_count: int = Field(ge=0)


class ProjectView(StrictModel):
    id: str
    title: str
    artist: str
    created_at: str
    updated_at: str
    revision: int
    duration_s: float
    passage: Passage
    assets: list[MediaAsset]
    tab: TabDocument
    versions: list[TabVersionSummary]
    active_version_id: str
    run: ProcessingRun
    source_name: str
    demo: bool
    trashed_at: str | None
    separation_scope: Literal["solo-guitar", "all-guitar", "preview", "exact"]
    waveform_peaks: list[float]
    provenance: list[str]


class ProcessRequest(StrictModel):
    start_s: float = Field(ge=0)
    end_s: float = Field(gt=0)
    tuning: list[int] = Field(default_factory=lambda: [40, 45, 50, 55, 59, 64])
    fret_count: int = Field(default=22, ge=12, le=36)
    expected_revision: int = Field(ge=1)
    engine: ProcessingEngine = "preview"
    cloud_consent: bool = False

    @model_validator(mode="after")
    def validate_range(self) -> ProcessRequest:
        if self.end_s <= self.start_s:
            raise ValueError("passage end must be after its start")
        maximum = 600 if self.engine == "mvsep" else 180
        if self.end_s - self.start_s > maximum:
            minutes = maximum // 60
            raise ValueError(f"Selected passage must be no longer than {minutes} minutes")
        if self.engine == "mvsep" and not self.cloud_consent:
            raise ValueError("Confirm MVSep cloud processing before creating this draft")
        if max(self.tuning) + self.fret_count > 127:
            raise ValueError("tuning plus fret count exceeds the MIDI range")
        return self

    @field_validator("tuning")
    @classmethod
    def validate_tuning(cls, value: list[int]) -> list[int]:
        return TabDocument.validate_tuning(value)


class RefingerRequest(StrictModel):
    mode: FingeringMode = "balanced"
    expected_revision: int = Field(ge=1)


class ProjectMutationRequest(StrictModel):
    expected_revision: int = Field(ge=1)


class ProjectRenameRequest(ProjectMutationRequest):
    title: str = Field(min_length=1, max_length=120)
    artist: str = Field(default="", max_length=120)


class WorkspacePatch(ProjectMutationRequest):
    passage: Passage


class VersionCreateRequest(ProjectMutationRequest):
    source_version_id: str = Field(min_length=1, max_length=96)
    name: str | None = Field(default=None, min_length=1, max_length=80)
    mode: FingeringMode | None = None


class VersionRenameRequest(ProjectMutationRequest):
    name: str = Field(min_length=1, max_length=80)


class MVSepTokenRequest(StrictModel):
    api_token: str = Field(min_length=20, max_length=256, pattern=r"^[A-Za-z0-9_-]+$")


class TabPatch(StrictModel):
    expected_revision: int = Field(ge=1)
    notes: Annotated[list[NoteEvent], Field(max_length=10000)]


class HealthResponse(StrictModel):
    status: Literal["ok"] = "ok"
    ffmpeg: bool
    separator: str
    transcriber: str
    demo_project_id: str
