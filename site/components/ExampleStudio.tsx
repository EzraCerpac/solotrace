"use client";

import {
  activeVersion,
  fingeringPreservesConnectedTechniques,
  isEditorProject,
  type EditorProject,
  type ExportFormat,
  type FingeringMode,
  type NoteEvent,
  type TabVersion,
} from "@solotrace/editor";
import {
  EditorClientHttpError,
  HostedEditorClient,
  hostedEditorClient,
} from "@/lib/client/editor-client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

type StemRole = "original" | "lead" | "backing";

type ExampleProject = EditorProject;

type SavedProjectQuota = {
  used: number;
  limit: number;
};

const STEMS: { role: StemRole; label: string; detail: string }[] = [
  { role: "original", label: "Full mix", detail: "Lead and backing together" },
  { role: "lead", label: "Lead", detail: "Hear the guitar line clearly" },
  { role: "backing", label: "Backing", detail: "Practice without the lead" },
];

const TECHNIQUES = ["bend", "vibrato", "slide", "hammer-on", "pull-off"];
const CONNECTED_TECHNIQUES = new Set(["slide", "hammer-on", "pull-off"]);
const EXPORTS: { format: ExportFormat; label: string }[] = [
  { format: "musicxml", label: "MusicXML" },
  { format: "midi", label: "MIDI" },
  { format: "ascii", label: "ASCII tab" },
  { format: "json", label: "Project JSON" },
];

const storageKey = (slug: string) => `solotrace:example-draft:${slug}:v1`;
const pendingSaveKey = (slug: string) => `solotrace:pending-save:${slug}:v1`;

function copyProject(project: ExampleProject): ExampleProject {
  return JSON.parse(JSON.stringify(project)) as ExampleProject;
}

type StorageRead = { ok: true; value: string | null } | { ok: false; value: null };

function readLocalStorage(key: string): StorageRead {
  try {
    return { ok: true, value: window.localStorage.getItem(key) };
  } catch {
    return { ok: false, value: null };
  }
}

function writeLocalStorage(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeLocalStorage(key: string): boolean {
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function updateActiveVersion(
  project: ExampleProject,
  update: (version: TabVersion) => TabVersion,
): ExampleProject {
  const updatedAt = new Date().toISOString();
  return {
    ...project,
    revision: project.revision + 1,
    updated_at: updatedAt,
    versions: project.versions.map((version) =>
      version.id === project.active_version_id ? update(version) : version,
    ),
  };
}

function updateNote(
  project: ExampleProject,
  noteId: string,
  update: (note: NoteEvent) => NoteEvent,
): ExampleProject {
  return updateActiveVersion(project, (version) => ({
    ...version,
    updated_at: new Date().toISOString(),
    tab: {
      ...version.tab,
      notes: version.tab.notes.map((note) =>
        note.id === noteId ? update(note) : note,
      ),
    },
  }));
}

function techniqueMark(previous: NoteEvent | undefined, note: NoteEvent): string {
  const marks: string[] = [];
  if (note.techniques.includes("hammer-on")) marks.push("h");
  if (note.techniques.includes("pull-off")) marks.push("p");
  if (note.techniques.includes("bend")) marks.push("b↑");
  if (note.techniques.includes("vibrato")) marks.push("~");

  const explicitUp = note.techniques.includes("slide-up");
  const explicitDown = note.techniques.includes("slide-down");
  if (explicitUp) marks.push("↗");
  else if (explicitDown) marks.push("↘");
  else if (note.techniques.includes("slide")) {
    if (previous && note.midi_pitch < previous.midi_pitch) marks.push("↘");
    else if (previous && note.midi_pitch === previous.midi_pitch) marks.push("→");
    else marks.push("↗");
  }
  return marks.join(" ");
}

function techniqueDescription(previous: NoteEvent | undefined, note: NoteEvent): string {
  const names: string[] = [];
  if (note.techniques.includes("hammer-on")) names.push("hammer-on");
  if (note.techniques.includes("pull-off")) names.push("pull-off");
  if (note.techniques.includes("bend")) names.push("bend");
  if (note.techniques.includes("vibrato")) names.push("vibrato");

  if (note.techniques.includes("slide-up")) names.push("slide up");
  else if (note.techniques.includes("slide-down")) names.push("slide down");
  else if (note.techniques.includes("slide")) {
    if (previous && note.midi_pitch < previous.midi_pitch) names.push("slide down");
    else if (previous && note.midi_pitch === previous.midi_pitch) names.push("level slide");
    else names.push("slide up");
  }
  return names.join(", ");
}

function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${Math.floor(safe % 60).toString().padStart(2, "0")}`;
}

function downsamplePeaks(values: number[], limit = 320): number[] {
  if (values.length <= limit) return values;
  const bucketSize = values.length / limit;
  return Array.from({ length: limit }, (_, bucket) => {
    const start = Math.floor(bucket * bucketSize);
    const end = Math.max(start + 1, Math.floor((bucket + 1) * bucketSize));
    return values.slice(start, end).reduce((loudest, value) =>
      Math.abs(value) > Math.abs(loudest) ? value : loudest, 0);
  });
}

function humanMode(mode: FingeringMode): string {
  if (mode === "position") return "One position";
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function techniqueCanBeEnabled(
  notes: readonly NoteEvent[],
  noteIndex: number,
  technique: string,
): boolean {
  if (!CONNECTED_TECHNIQUES.has(technique)) return true;
  const note = notes[noteIndex];
  if (!note) return false;
  const candidateNotes = [...notes];
  candidateNotes[noteIndex] = {
    ...note,
    techniques: [
      ...note.techniques.filter((item) => !CONNECTED_TECHNIQUES.has(item)),
      technique,
    ],
  };
  return fingeringPreservesConnectedTechniques(candidateNotes, noteIndex, note);
}

export function TabCanvas({
  project,
  currentTime,
  selectedNoteId,
  onSelect,
  disabled = false,
}: {
  project: ExampleProject;
  currentTime: number;
  selectedNoteId: string | null;
  onSelect: (note: NoteEvent) => void;
  disabled?: boolean;
}) {
  const version = activeVersion(project);
  const notes = version.tab.notes;
  const stringCount = version.tab.tuning.length;
  const width = Math.max(920, notes.length * 58 + 140);
  const height = 98 + stringCount * 38;
  const startX = 76;
  const usableWidth = width - startX - 42;
  const maxTick = Math.max(
    version.tab.ticks_per_quarter * 4,
    ...notes.map((note) => note.score_tick + note.duration_ticks),
  );
  const xForTick = (tick: number) => startX + (tick / maxTick) * usableWidth;
  const yForString = (string: number) => 66 + (string - 1) * 38;
  const playheadX = startX + (currentTime / Math.max(project.duration_s, 0.01)) * usableWidth;

  return (
    <div className="example-studio__tab-scroll">
      <svg
        className="example-studio__tab"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="group"
        aria-label={`Editable tablature for ${project.title}. Each fret is an interactive note.`}
      >
        <title>{`Editable tablature for ${project.title}`}</title>
        <desc>
          Select a fret number to inspect or change its fingering. Technique marks
          appear above each note.
        </desc>
        {Array.from({ length: stringCount }, (_, index) => index + 1).map(
          (string) => (
            <g className="example-studio__string" key={string}>
              <text x={26} y={yForString(string) + 5}>
                {string}
              </text>
              <line
                x1={startX - 18}
                x2={width - 28}
                y1={yForString(string)}
                y2={yForString(string)}
              />
            </g>
          ),
        )}
        <line
          className="example-studio__playhead"
          x1={playheadX}
          x2={playheadX}
          y1={38}
          y2={yForString(stringCount) + 28}
        />
        {notes.map((note, index) => {
          const x = xForTick(note.score_tick);
          const y = yForString(note.string);
          const selected = note.id === selectedNoteId;
          const playing =
            currentTime >= note.audio_onset_s && currentTime < note.audio_offset_s;
          const mark = techniqueMark(notes[index - 1], note);
          const spokenTechnique = techniqueDescription(notes[index - 1], note);
          const confidence = Math.round(
            Math.min(
              note.confidence.pitch,
              note.confidence.onset,
              note.confidence.fingering,
              note.confidence.technique,
            ) * 100,
          );
          return (
            <g
              className={[
                "example-studio__note",
                selected ? "is-selected" : "",
                playing ? "is-playing" : "",
                confidence < 72 && !note.reviewed ? "needs-review" : "",
              ].join(" ")}
              key={note.id}
              role="button"
              tabIndex={disabled ? -1 : 0}
              aria-disabled={disabled || undefined}
              aria-label={`String ${note.string}, fret ${note.fret}, ${confidence}% confidence${spokenTechnique ? `, ${spokenTechnique}` : ""}`}
              onClick={() => {
                if (!disabled) onSelect(note);
              }}
              onKeyDown={(event: KeyboardEvent<SVGGElement>) => {
                if (!disabled && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  onSelect(note);
                }
              }}
            >
              {mark ? (
                <text className="example-studio__technique" x={x} y={y - 22} textAnchor="middle">
                  {mark}
                </text>
              ) : null}
              <rect x={x - 13} y={y - 14} width={28} height={28} rx={6} />
              <text x={x + 1} y={y + 5} textAnchor="middle">
                {note.fret}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export type ExampleStudioProps = {
  slug: string;
};

export function ExampleStudio({ slug }: ExampleStudioProps) {
  const [baseProject, setBaseProject] = useState<ExampleProject | null>(null);
  const [project, setProject] = useState<ExampleProject | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [stem, setStem] = useState<StemRole>("original");
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [quota, setQuota] = useState<SavedProjectQuota | null>(null);
  const [message, setMessage] = useState<string>("");
  const [hydrated, setHydrated] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const audioRef = useRef<HTMLAudioElement>(null);
  const resumeAfterStemChange = useRef(false);
  const pendingSeek = useRef(0);
  const attemptedPendingSave = useRef(false);
  const storageWarningShown = useRef(false);

  const reportStorageUnavailable = useCallback(() => {
    setStorageAvailable(false);
    if (storageWarningShown.current) return;
    storageWarningShown.current = true;
    setMessage("Device storage is unavailable. Edits will last only until this page closes.");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const storedDraft = readLocalStorage(storageKey(slug));
    if (!storedDraft.ok) queueMicrotask(reportStorageUnavailable);
    const immutableClient = new HostedEditorClient({ storage: null });

    void Promise.all([
      immutableClient.loadProject({ origin: "example", slug }),
      hostedEditorClient.loadProject({ origin: "example", slug }),
      fetch(`/examples/${encodeURIComponent(slug)}/peaks.json`, {
        cache: "force-cache",
        signal: controller.signal,
      }).then((response) => (response.ok ? response.json() : [])) as Promise<unknown>,
    ])
      .then(async ([immutable, loaded, rawPeaks]) => {
        if (cancelled) return;
        if (!isEditorProject(immutable) || immutable.example_slug !== slug) {
          throw new Error("Example project data is not valid.");
        }
        let editable = loaded;
        if (!isEditorProject(editable) || editable.example_slug !== slug) {
          editable = await hostedEditorClient.resetExample(slug);
          setMessage("An invalid device draft was cleared. The original example is ready.");
        } else if (storedDraft.value) {
          try {
            const parsed: unknown = JSON.parse(storedDraft.value);
            if (!isEditorProject(parsed) || parsed.example_slug !== slug) {
              setMessage("An invalid device draft was cleared. The original example is ready.");
            }
          } catch {
            setMessage("An unreadable device draft was cleared. The original example is ready.");
          }
        }
        if (cancelled) return;
        setBaseProject(copyProject(immutable));
        setProject(copyProject(editable));
        setPeaks(
          Array.isArray(rawPeaks)
            ? rawPeaks.filter((peak): peak is number => typeof peak === "number")
            : immutable.waveform_peaks,
        );
        setSelectedNoteId(activeVersion(editable).tab.notes[0]?.id ?? null);
        setHydrated(true);
      })
      .catch((error: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : "Could not load this example.");
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reportStorageUnavailable, slug]);

  useEffect(() => {
    if (!hydrated || !project || !baseProject) return;
    if (JSON.stringify(project) === JSON.stringify(baseProject)) {
      if (!removeLocalStorage(storageKey(slug))) {
        queueMicrotask(reportStorageUnavailable);
      }
      return;
    }
    void hostedEditorClient.saveProject({ project }).then(() => {
      const persisted = readLocalStorage(storageKey(slug));
      if (!persisted.ok || !persisted.value) reportStorageUnavailable();
    });
  }, [baseProject, hydrated, project, reportStorageUnavailable, slug]);

  useEffect(() => {
    if (!hydrated) return;
    const controller = new AbortController();
    void fetch("/api/saved-projects", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { quota?: SavedProjectQuota };
        if (payload.quota) setQuota(payload.quota);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [hydrated]);

  const version = useMemo(() => (project ? activeVersion(project) : null), [project]);
  const edited = useMemo(
    () => Boolean(project && baseProject && JSON.stringify(project) !== JSON.stringify(baseProject)),
    [baseProject, project],
  );
  const selectedNote = useMemo(
    () => version?.tab.notes.find((note) => note.id === selectedNoteId) ?? null,
    [selectedNoteId, version],
  );
  const selectedNoteIndex = useMemo(
    () => version?.tab.notes.findIndex((note) => note.id === selectedNoteId) ?? -1,
    [selectedNoteId, version],
  );
  const playableFingerings = useMemo(
    () =>
      selectedNote && version && selectedNoteIndex >= 0
        ? selectedNote.alternatives.filter((fingering) =>
            fingeringPreservesConnectedTechniques(
              version.tab.notes,
              selectedNoteIndex,
              fingering,
            ),
          )
        : [],
    [selectedNote, selectedNoteIndex, version],
  );

  const stemUrl = useMemo(() => {
    const asset = project?.assets?.find((candidate) => candidate.role === stem);
    return asset?.url ?? `/examples/${encodeURIComponent(slug)}/${stem}.wav`;
  }, [project, slug, stem]);

  const chooseStem = (nextStem: StemRole) => {
    const audio = audioRef.current;
    pendingSeek.current = audio?.currentTime ?? currentTime;
    resumeAfterStemChange.current = !audio?.paused;
    setStem(nextStem);
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      try {
        await audio.play();
      } catch {
        setMessage("Playback could not start. Try pressing play again.");
      }
    } else {
      audio.pause();
    }
  };

  const seek = (time: number) => {
    const bounded = Math.min(Math.max(time, 0), project?.duration_s ?? time);
    setCurrentTime(bounded);
    if (audioRef.current) audioRef.current.currentTime = bounded;
  };

  const selectNote = (note: NoteEvent) => {
    setSelectedNoteId(note.id);
    seek(note.audio_onset_s);
  };

  const mutateSelected = (update: (note: NoteEvent) => NoteEvent) => {
    if (!project || !selectedNoteId) return;
    setProject(updateNote(project, selectedNoteId, update));
  };

  const runRefinger = async (mode: FingeringMode) => {
    if (!project) return;
    try {
      await hostedEditorClient.saveProject({ project });
      const next = await hostedEditorClient.refingerProject({
        projectId: project.id,
        expectedRevision: project.revision,
        sourceVersionId: project.active_version_id,
        mode,
        name: humanMode(mode),
      });
      setProject(next);
      setSelectedNoteId(activeVersion(next).tab.notes[0]?.id ?? null);
      setMessage(`${humanMode(mode)} fingering added as a new version.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not refinger this version.");
    }
  };

  const activateVersion = async (versionId: string) => {
    if (!project || versionId === project.active_version_id) return;
    try {
      await hostedEditorClient.saveProject({ project });
      const next = await hostedEditorClient.applyVersionAction({
        projectId: project.id,
        expectedRevision: project.revision,
        action: { type: "activate", versionId },
      });
      setProject(next);
      setSelectedNoteId(activeVersion(next).tab.notes[0]?.id ?? null);
      setMessage(`Switched to ${activeVersion(next).name}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not switch versions.");
    }
  };

  const resetProject = async () => {
    if (!baseProject) return;
    if (edited && !window.confirm("Reset every device-local edit for this example?")) return;
    try {
      const reset = await hostedEditorClient.resetExample(slug);
      setProject(copyProject(reset));
      setSelectedNoteId(activeVersion(reset).tab.notes[0]?.id ?? null);
      if (!removeLocalStorage(pendingSaveKey(slug))) reportStorageUnavailable();
      setMessage("Example reset to its original version.");
    } catch (error) {
      setProject(copyProject(baseProject));
      setSelectedNoteId(activeVersion(baseProject).tab.notes[0]?.id ?? null);
      setMessage(error instanceof Error ? error.message : "Example reset for this tab only.");
    }
  };

  const downloadExport = async (format: ExportFormat) => {
    if (!project) return;
    try {
      const artifact = await hostedEditorClient.exportProject({ project, format });
      const bytes = new Uint8Array(artifact.bytes);
      const blob = new Blob([bytes], { type: artifact.mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = artifact.filename;
      link.click();
      URL.revokeObjectURL(url);
      setMessage(`${artifact.filename} downloaded.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export could not be created.");
    }
  };

  const saveCopy = useCallback(
    async (afterSignIn = false) => {
      if (!project || saveState === "saving") return;
      const draftPersisted = writeLocalStorage(
        storageKey(slug),
        JSON.stringify(project),
      );
      if (!draftPersisted) reportStorageUnavailable();
      setSaveState("saving");
      setMessage("Saving a private copy…");
      try {
        await hostedEditorClient.saveProject({ project });
        const saved = await hostedEditorClient.saveProject({ project, asCopy: true });
        if (!removeLocalStorage(pendingSaveKey(slug))) reportStorageUnavailable();
        setSaveState("saved");
        setMessage("Private copy saved. Opening it now…");
        window.location.assign(`/projects/${encodeURIComponent(saved.id)}`);
      } catch (error) {
        if (error instanceof EditorClientHttpError && error.status === 401) {
          const pendingPersisted = writeLocalStorage(pendingSaveKey(slug), "1");
          setSaveState("idle");
          if (!draftPersisted || !pendingPersisted) {
            reportStorageUnavailable();
            setMessage(
              "Sign-in cannot safely resume without device storage. Allow site storage, reload, and try again.",
            );
            return;
          }
          if (afterSignIn) {
            setMessage("Sign-in did not finish. Your edits are still saved on this device.");
            return;
          }
          const returnTo = `${window.location.pathname}?save_copy=1`;
          window.location.assign(
            `/signin-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`,
          );
          return;
        }
        if (error instanceof EditorClientHttpError && error.code === "saved_project_limit") {
          setSaveState("error");
          setMessage("You already have three saved copies. Delete one in your library first.");
          return;
        }
        if (error instanceof EditorClientHttpError && error.code === "document_too_large") {
          setSaveState("error");
          setMessage("This edited copy is too large to save. Reset it and try again.");
          return;
        }
        setSaveState("error");
        setMessage(error instanceof Error ? error.message : "Could not save this copy.");
      }
    },
    [project, reportStorageUnavailable, saveState, slug],
  );

  useEffect(() => {
    if (!hydrated || !project || attemptedPendingSave.current) return;
    const params = new URLSearchParams(window.location.search);
    const pendingSave = readLocalStorage(pendingSaveKey(slug));
    if (!pendingSave.ok) {
      queueMicrotask(reportStorageUnavailable);
      return;
    }
    if (
      params.get("save_copy") === "1" &&
      pendingSave.value === "1"
    ) {
      attemptedPendingSave.current = true;
      queueMicrotask(() => void saveCopy(true));
    }
  }, [hydrated, project, reportStorageUnavailable, saveCopy, slug]);

  if (loadError) {
    return (
      <main id="main-content" tabIndex={-1} className="example-studio example-studio--error" aria-labelledby="studio-error-title">
        <p className="eyebrow">Example unavailable</p>
        <h1 id="studio-error-title">This session could not be opened.</h1>
        <p>{loadError}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Try again
        </button>
      </main>
    );
  }

  if (!project || !baseProject || !version) {
    return (
      <main id="main-content" tabIndex={-1} className="example-studio example-studio--loading" aria-live="polite">
        <p className="eyebrow">Loading example</p>
        <h1>Setting up a local working copy…</h1>
        <p>No account, key, upload, or processing job is needed.</p>
      </main>
    );
  }

  const waveform = downsamplePeaks(
    peaks.length > 0 ? peaks : Array.from({ length: 96 }, () => 0.16),
  );
  const waveformWidth = 960;
  const progressX = (currentTime / Math.max(project.duration_s, 0.01)) * waveformWidth;
  const libraryFull = Boolean(quota && quota.used >= quota.limit);
  const saveLabel =
    saveState === "saving" ? "Saving…" : libraryFull ? "Library full" : "Save a copy";

  return (
    <main id="main-content" tabIndex={-1} className="example-studio">
      <header className="example-studio__header">
        <div>
          <p className="eyebrow">Browser-local example · CC0 synthetic audio</p>
          <h1>{project.title}</h1>
          <p>
            {project.artist ? `${project.artist} · ` : ""}
            {version.tab.tempo_bpm} BPM · {version.tab.time_signature.join("/")} · edits stay on this device
          </p>
        </div>
        <div className="example-studio__header-actions">
          <button
            type="button"
            className="button button--quiet"
            onClick={() => void resetProject()}
          >
            Reset
          </button>
          <div className="example-studio__save-action">
            <button
              type="button"
              className="button button--primary"
              disabled={saveState === "saving" || libraryFull}
              onClick={() => void saveCopy(false)}
            >
              {saveLabel}
            </button>
            <small>
              {quota
                ? `${quota.used} of ${quota.limit} private copies used`
                : storageAvailable
                  ? "Up to 3 private copies"
                  : "Sign-in resume needs device storage"}
            </small>
          </div>
        </div>
      </header>

      <p
        className="example-studio__status"
        data-visible={message ? "true" : "false"}
        role="status"
        aria-live="polite"
      >
        {message}
      </p>

      <section className="example-studio__transport" aria-labelledby="listen-heading">
        <div className="example-studio__section-heading">
          <div>
            <p className="eyebrow">Listen</p>
            <h2 id="listen-heading">Hear every layer</h2>
          </div>
          <p className="example-studio__time" aria-live="off">
            {formatClock(currentTime)} / {formatClock(project.duration_s)}
          </p>
        </div>

        <audio
          ref={audioRef}
          src={stemUrl}
          preload="metadata"
          loop={loop}
          onLoadedMetadata={(event) => {
            event.currentTarget.currentTime = Math.min(
              pendingSeek.current,
              event.currentTarget.duration || project.duration_s,
            );
            event.currentTarget.playbackRate = speed;
            if (resumeAfterStemChange.current) {
              resumeAfterStemChange.current = false;
              void event.currentTarget.play().catch(() => {
                setMessage("Layer changed. Press play to continue.");
              });
            }
          }}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />

        <div
          className="example-studio__waveform"
          aria-hidden="true"
          onClick={(event: MouseEvent<HTMLDivElement>) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            seek(((event.clientX - bounds.left) / bounds.width) * project.duration_s);
          }}
        >
          <svg viewBox={`0 0 ${waveformWidth} 100`} role="presentation" aria-hidden="true">
            {waveform.map((peak, index) => {
              const x = (index / waveform.length) * waveformWidth;
              const magnitude = Math.max(3, Math.min(46, Math.abs(peak) * 46));
              return (
                <line
                  key={`${index}-${peak}`}
                  x1={x}
                  x2={x}
                  y1={50 - magnitude}
                  y2={50 + magnitude}
                />
              );
            })}
            <line
              className="example-studio__waveform-progress"
              x1={progressX}
              x2={progressX}
              y1={0}
              y2={100}
            />
          </svg>
        </div>
        <label className="example-studio__seek-control">
          <span className="sr-only">Playback position</span>
          <input
            type="range"
            min={0}
            max={project.duration_s}
            step={0.01}
            value={Math.min(currentTime, project.duration_s)}
            onChange={(event) => seek(Number(event.target.value))}
          />
        </label>

        <div className="example-studio__transport-controls">
          <button type="button" className="button button--transport" onClick={() => void togglePlayback()}>
            {playing ? "Pause" : "Play"}
          </button>
          <fieldset className="example-studio__stem-picker">
            <legend>Audio layer</legend>
            {STEMS.map((option) => (
              <button
                type="button"
                key={option.role}
                className={stem === option.role ? "is-active" : ""}
                aria-pressed={stem === option.role}
                onClick={() => chooseStem(option.role)}
              >
                <span>{option.label}</span>
                <small>{option.detail}</small>
              </button>
            ))}
          </fieldset>
          <label className="example-studio__compact-control">
            <span>Speed</span>
            <select
              value={speed}
              onChange={(event) => {
                const next = Number(event.target.value);
                setSpeed(next);
                if (audioRef.current) audioRef.current.playbackRate = next;
              }}
            >
              <option value={0.5}>50%</option>
              <option value={0.75}>75%</option>
              <option value={1}>100%</option>
              <option value={1.25}>125%</option>
            </select>
          </label>
          <label className="example-studio__check-control">
            <input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />
            <span>Loop</span>
          </label>
        </div>
      </section>

      <section className="example-studio__editor" aria-labelledby="tab-heading">
        <div className="example-studio__section-heading">
          <div>
            <p className="eyebrow">Trace</p>
            <h2 id="tab-heading">Edit the playable tab</h2>
          </div>
          <p>Select a note, then choose another legal position.</p>
        </div>
        <TabCanvas
          project={project}
          currentTime={currentTime}
          selectedNoteId={selectedNoteId}
          onSelect={selectNote}
        />

        <div className="example-studio__edit-grid">
          <aside className="example-studio__versions" aria-labelledby="versions-heading">
            <h3 id="versions-heading">Versions</h3>
            <div className="example-studio__version-list">
              {project.versions.map((candidate) => (
                <button
                  type="button"
                  key={candidate.id}
                  className={candidate.id === project.active_version_id ? "is-active" : ""}
                  aria-pressed={candidate.id === project.active_version_id}
                  onClick={() => void activateVersion(candidate.id)}
                >
                  <span>{candidate.name}</span>
                  <small>{humanMode(candidate.fingering_mode)}</small>
                </button>
              ))}
            </div>
            <h3>Refinger as</h3>
            <div className="example-studio__refinger-actions">
              {(["balanced", "easiest", "position"] as FingeringMode[]).map((mode) => (
                <button type="button" key={mode} onClick={() => void runRefinger(mode)}>
                  {humanMode(mode)}
                </button>
              ))}
            </div>
            <p className="example-studio__hint">Refingering adds a version. Your current one remains available.</p>
          </aside>

          <aside className="example-studio__inspector" aria-labelledby="inspector-heading">
            <h3 id="inspector-heading">Selected note</h3>
            {selectedNote ? (
              <>
                <dl className="example-studio__note-facts">
                  <div><dt>Pitch</dt><dd>MIDI {selectedNote.midi_pitch}</dd></div>
                  <div><dt>Time</dt><dd>{selectedNote.audio_onset_s.toFixed(2)} s</dd></div>
                  <div><dt>Current</dt><dd>String {selectedNote.string}, fret {selectedNote.fret}</dd></div>
                </dl>
                <fieldset className="example-studio__fingerings">
                  <legend>Legal positions</legend>
                  {playableFingerings.map((fingering) => (
                    <button
                      type="button"
                      key={`${fingering.string}-${fingering.fret}`}
                      className={
                        fingering.string === selectedNote.string && fingering.fret === selectedNote.fret
                          ? "is-active"
                          : ""
                      }
                      aria-pressed={
                        fingering.string === selectedNote.string && fingering.fret === selectedNote.fret
                      }
                      onClick={() =>
                        mutateSelected((note) => ({
                          ...note,
                          string: fingering.string,
                          fret: fingering.fret,
                          user_locked: true,
                          confidence: { ...note.confidence, fingering: 1 },
                        }))
                      }
                    >
                      <span>S{fingering.string}</span>
                      <strong>{fingering.fret}</strong>
                    </button>
                  ))}
                </fieldset>
                <fieldset className="example-studio__techniques" aria-describedby="example-technique-help">
                  <legend>Technique</legend>
                  {TECHNIQUES.map((technique) => (
                    <label key={technique}>
                      <input
                        type="checkbox"
                        checked={selectedNote.techniques.includes(technique)}
                        disabled={
                          !selectedNote.techniques.includes(technique) &&
                          !techniqueCanBeEnabled(version.tab.notes, selectedNoteIndex, technique)
                        }
                        onChange={(event) =>
                          mutateSelected((note) => ({
                            ...note,
                            techniques: event.target.checked
                              ? [
                                  ...note.techniques.filter(
                                    (item) =>
                                      !CONNECTED_TECHNIQUES.has(technique) ||
                                      !CONNECTED_TECHNIQUES.has(item),
                                  ),
                                  technique,
                                ]
                              : note.techniques.filter((item) => item !== technique),
                          }))
                        }
                      />
                      <span>{technique}</span>
                    </label>
                  ))}
                </fieldset>
                <p className="example-studio__hint" id="example-technique-help">
                  Slides, hammer-ons, and pull-offs need compatible notes on the same string.
                </p>
                <label className="example-studio__check-control">
                  <input
                    type="checkbox"
                    checked={selectedNote.reviewed}
                    onChange={(event) =>
                      mutateSelected((note) => ({ ...note, reviewed: event.target.checked }))
                    }
                  />
                  <span>Reviewed</span>
                </label>
              </>
            ) : (
              <p>Select a fret number in the tab to inspect it.</p>
            )}
          </aside>
        </div>
      </section>

      <section className="example-studio__finish" aria-labelledby="finish-heading">
        <div>
          <p className="eyebrow">Take it with you</p>
          <h2 id="finish-heading">Export without an account</h2>
          <p>Downloads are generated in your browser. Saving a private copy needs ChatGPT sign-in.</p>
        </div>
        <div className="example-studio__export-actions">
          {EXPORTS.map((item) => (
            <button type="button" key={item.format} onClick={() => void downloadExport(item.format)}>
              {item.label}
            </button>
          ))}
        </div>
      </section>

    </main>
  );
}

export default ExampleStudio;
