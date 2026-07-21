"use client";

import {
  activeVersion,
  createRefingeredVersion,
  fingeringPreservesConnectedTechniques,
  type EditorProject,
  type ExportFormat,
  type FingeringMode,
  type NoteEvent,
  type TabVersion,
} from "@solotrace/editor";
import {
  EditorClientHttpError,
  hostedEditorClient,
} from "@/lib/client/editor-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TabCanvas } from "./ExampleStudio";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type SavedProjectStudioProps = {
  id: string;
};

type StemRole = "original" | "lead" | "backing";

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

function humanMode(mode: FingeringMode): string {
  if (mode === "position") return "One position";
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function projectSignature(title: string, project: EditorProject): string {
  return JSON.stringify({ title: title.trim(), document: project });
}

function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${Math.floor(safe % 60).toString().padStart(2, "0")}`;
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

function updateActiveVersion(
  project: EditorProject,
  update: (version: TabVersion) => TabVersion,
): EditorProject {
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
  project: EditorProject,
  noteId: string,
  update: (note: NoteEvent) => NoteEvent,
): EditorProject {
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

export function SavedProjectStudio({ id }: SavedProjectStudioProps) {
  const router = useRouter();
  const [project, setProject] = useState<EditorProject | null>(null);
  const [savedRevision, setSavedRevision] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [savedSignature, setSavedSignature] = useState("");
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [stem, setStem] = useState<StemRole>("original");
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const resumeAfterStemChange = useRef(false);
  const pendingSeek = useRef(0);
  const loadSequence = useRef(0);
  const confirmedNavigation = useRef(false);

  const loadProject = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError(null);
    setConflictRevision(null);
    try {
      const editable = await hostedEditorClient.loadProject({
        origin: "saved-example",
        id,
      });
      if (loadSequence.current !== sequence) return;
      setProject(editable);
      setSavedRevision(editable.revision);
      setTitle(editable.title);
      setSavedSignature(projectSignature(editable.title, editable));
      setSelectedNoteId(activeVersion(editable).tab.notes[0]?.id ?? null);
      audioRef.current?.pause();
      if (audioRef.current) audioRef.current.currentTime = 0;
      pendingSeek.current = 0;
      resumeAfterStemChange.current = false;
      setCurrentTime(0);
      setMessage("");
    } catch (error) {
      if (loadSequence.current !== sequence) return;
      if (error instanceof EditorClientHttpError && error.status === 404) {
        setLoadError("This saved copy does not exist, or it belongs to another account.");
      } else {
        setLoadError(error instanceof Error ? error.message : "Could not load this saved copy.");
      }
    } finally {
      if (loadSequence.current === sequence) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    queueMicrotask(() => void loadProject());
    return () => {
      loadSequence.current += 1;
    };
  }, [loadProject]);

  const dirty = useMemo(
    () => Boolean(project && projectSignature(title, project) !== savedSignature),
    [project, savedSignature, title],
  );

  useEffect(() => {
    if (!dirty) return;
    confirmedNavigation.current = false;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (confirmedNavigation.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const warnAnchorNavigation = (event: globalThis.MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.hasAttribute("download") ||
        anchor.target === "_blank"
      ) {
        return;
      }

      const destination = new URL(anchor.href, window.location.href);
      const current = new URL(window.location.href);
      if (
        destination.origin !== current.origin ||
        (destination.pathname === current.pathname && destination.search === current.search)
      ) {
        return;
      }
      if (!window.confirm("Leave this page and discard your unsaved SoloTrace changes?")) {
        event.preventDefault();
        event.stopPropagation();
      } else {
        confirmedNavigation.current = true;
        window.setTimeout(() => {
          confirmedNavigation.current = false;
        }, 0);
      }
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    document.addEventListener("click", warnAnchorNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      document.removeEventListener("click", warnAnchorNavigation, true);
    };
  }, [dirty]);

  const version = useMemo(() => (project ? activeVersion(project) : null), [project]);
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
    const asset = project?.assets.find((candidate) => candidate.role === stem);
    if (asset?.url) return asset.url;
    if (!project?.example_slug) return "";
    return `/examples/${encodeURIComponent(project.example_slug)}/${stem}.wav`;
  }, [project, stem]);

  const save = async () => {
    if (savedRevision === null || !project || saving || deleting) return;
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      setMessage("Give this copy a title before saving.");
      return;
    }
    const document: EditorProject = {
      ...project,
      title: normalizedTitle,
      origin: "saved-example",
    };
    setSaving(true);
    setConflictRevision(null);
    setMessage("Saving changes…");
    try {
      const savedDocument = await hostedEditorClient.saveProject({
        project: document,
        expectedRevision: savedRevision,
      });
      setProject(savedDocument);
      setSavedRevision(savedDocument.revision);
      setTitle(savedDocument.title);
      setSavedSignature(projectSignature(savedDocument.title, savedDocument));
      setMessage(`Saved revision ${savedDocument.revision}.`);
    } catch (error) {
      if (
        error instanceof EditorClientHttpError &&
        error.status === 409 &&
        error.code === "revision_conflict"
      ) {
        setConflictRevision(error.currentRevision ?? savedRevision + 1);
        setMessage("This copy changed in another tab. Reload the newest copy before editing further.");
      } else {
        setMessage(error instanceof Error ? error.message : "Could not save these changes.");
      }
    } finally {
      setSaving(false);
    }
  };

  const deleteCopy = async () => {
    if (!project || deleting || saving) return;
    const confirmed = window.confirm(
      `Permanently delete “${project.title}”? The public example remains available, but this saved copy cannot be recovered.`,
    );
    if (!confirmed) return;
    setDeleting(true);
    setMessage("Deleting this copy…");
    try {
      const response = await fetch(`/api/saved-projects/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 404) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Could not delete this saved copy.");
      }
      router.push("/library");
      router.refresh();
    } catch (error) {
      setDeleting(false);
      setMessage(error instanceof Error ? error.message : "Could not delete this saved copy.");
    }
  };

  const runRefinger = (mode: FingeringMode) => {
    if (!project || conflictRevision !== null || saving || deleting) return;
    try {
      const now = new Date().toISOString();
      const next = createRefingeredVersion(project, {
        sourceVersionId: project.active_version_id,
        mode,
        versionId: `saved-${mode}-revision-${project.revision + 1}`,
        name: humanMode(mode),
        createdAt: now,
      });
      setProject(next);
      setSelectedNoteId(activeVersion(next).tab.notes[0]?.id ?? null);
      setMessage(`${humanMode(mode)} fingering added. Save to keep it.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not refinger this version.");
    }
  };

  const chooseStem = (nextStem: StemRole) => {
    const audio = audioRef.current;
    pendingSeek.current = audio?.currentTime ?? currentTime;
    resumeAfterStemChange.current = Boolean(audio && !audio.paused);
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

  const downloadExport = async (format: ExportFormat) => {
    if (!project) return;
    try {
      const artifact = await hostedEditorClient.exportProject({
        project: { ...project, title: title.trim() || project.title },
        format,
      });
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

  if (loading) {
    return (
      <main id="main-content" tabIndex={-1} className="example-studio example-studio--loading" aria-live="polite">
        <p className="eyebrow">Private copy</p>
        <h1>Loading your project…</h1>
      </main>
    );
  }

  if (loadError || savedRevision === null || !project || !version) {
    return (
      <main id="main-content" tabIndex={-1} className="example-studio example-studio--error">
        <p className="eyebrow">Saved copy unavailable</p>
        <h1>Project could not be opened.</h1>
        <p>{loadError ?? "The project document is invalid."}</p>
        <div className="example-studio__header-actions">
          <Link className="button" href="/library">Back to library</Link>
          <button className="button button--quiet" type="button" onClick={() => void loadProject()}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  const editorDisabled = conflictRevision !== null || saving || deleting;

  return (
    <main id="main-content" tabIndex={-1} className="example-studio">
      <header className="example-studio__header">
        <div>
          <p className="eyebrow">Private saved example · revision {savedRevision}</p>
          <h1 className="sr-only">{title.trim() || "Untitled saved project"}</h1>
          <label className="saved-project-studio__title-label" htmlFor="saved-project-title">
            Project title
          </label>
          <input
            className="saved-project-studio__title-input"
            id="saved-project-title"
            type="text"
            maxLength={120}
            value={title}
            disabled={editorDisabled}
            onChange={(event) => {
              setTitle(event.target.value);
              setProject((current) => current ? { ...current, title: event.target.value } : current);
            }}
          />
          <p>
            Based on {project.example_slug?.replaceAll("-", " ") ?? "public example"} · {dirty ? "unsaved changes" : "all changes saved"}
          </p>
        </div>
        <div className="example-studio__header-actions">
          <Link className="button button--quiet" href="/library">Library</Link>
          <button
            className="button button--primary"
            type="button"
            disabled={!dirty || editorDisabled}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
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

      {conflictRevision !== null ? (
        <section className="example-studio__finish" aria-labelledby="conflict-heading">
          <div>
            <p className="eyebrow">Revision conflict</p>
            <h2 id="conflict-heading">A newer copy is waiting</h2>
            <p>
              The server is at revision {conflictRevision}. Reloading discards this tab’s unsaved changes.
            </p>
          </div>
          <button className="button button--primary" type="button" onClick={() => void loadProject()}>
            Reload newest copy
          </button>
        </section>
      ) : null}

      <section className="example-studio__transport" aria-labelledby="saved-listen-heading">
        <div className="example-studio__section-heading">
          <div>
            <p className="eyebrow">Listen</p>
            <h2 id="saved-listen-heading">Practice this saved copy</h2>
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

        <label className="example-studio__compact-control">
          <span>Playback position</span>
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
          <button
            type="button"
            className="button button--transport"
            onClick={() => void togglePlayback()}
          >
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
            <input
              type="checkbox"
              checked={loop}
              onChange={(event) => setLoop(event.target.checked)}
            />
            <span>Loop</span>
          </label>
        </div>
      </section>

      <section className="example-studio__editor" aria-labelledby="saved-tab-heading">
        <div className="example-studio__section-heading">
          <div>
            <p className="eyebrow">Trace</p>
            <h2 id="saved-tab-heading">Versions and fingering</h2>
          </div>
          <p>Select a note to lock a legal position, or generate a new fingering version.</p>
        </div>

        <TabCanvas
          project={project}
          currentTime={currentTime}
          selectedNoteId={selectedNoteId}
          disabled={editorDisabled}
          onSelect={(note) => {
            setSelectedNoteId(note.id);
            seek(note.audio_onset_s);
          }}
        />

        <div className="example-studio__edit-grid">
          <aside className="example-studio__versions" aria-labelledby="saved-versions-heading">
            <h3 id="saved-versions-heading">Versions</h3>
            <div className="example-studio__version-list">
              {project.versions.map((candidate) => (
                <button
                  type="button"
                  key={candidate.id}
                  className={candidate.id === project.active_version_id ? "is-active" : ""}
                  aria-pressed={candidate.id === project.active_version_id}
                  disabled={editorDisabled}
                  onClick={() => {
                    const now = new Date().toISOString();
                    setProject({
                      ...project,
                      revision: project.revision + 1,
                      updated_at: now,
                      active_version_id: candidate.id,
                    });
                    setSelectedNoteId(candidate.tab.notes[0]?.id ?? null);
                  }}
                >
                  <span>{candidate.name}</span>
                  <small>{humanMode(candidate.fingering_mode)}</small>
                </button>
              ))}
            </div>
            <h3>Refinger as</h3>
            <div className="example-studio__refinger-actions">
              {(["balanced", "easiest", "position"] as FingeringMode[]).map((mode) => (
                <button type="button" key={mode} disabled={editorDisabled} onClick={() => runRefinger(mode)}>
                  {humanMode(mode)}
                </button>
              ))}
            </div>
            <p className="example-studio__hint">New versions stay local to this page until you save.</p>
          </aside>

          <aside className="example-studio__inspector" aria-labelledby="saved-inspector-heading">
            <h3 id="saved-inspector-heading">Selected note</h3>
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
                      disabled={editorDisabled}
                      onClick={() =>
                        setProject(updateNote(project, selectedNote.id, (note) => ({
                          ...note,
                          string: fingering.string,
                          fret: fingering.fret,
                          user_locked: true,
                          confidence: { ...note.confidence, fingering: 1 },
                        })))
                      }
                    >
                      <span>S{fingering.string}</span>
                      <strong>{fingering.fret}</strong>
                    </button>
                  ))}
                </fieldset>
                <fieldset className="example-studio__techniques" aria-describedby="saved-technique-help">
                  <legend>Technique</legend>
                  {TECHNIQUES.map((technique) => (
                    <label key={technique}>
                      <input
                        type="checkbox"
                        checked={selectedNote.techniques.includes(technique)}
                        disabled={
                          editorDisabled ||
                          (!selectedNote.techniques.includes(technique) &&
                            !techniqueCanBeEnabled(
                              version.tab.notes,
                              selectedNoteIndex,
                              technique,
                            ))
                        }
                        onChange={(event) =>
                          setProject(updateNote(project, selectedNote.id, (note) => ({
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
                          })))
                        }
                      />
                      <span>{technique}</span>
                    </label>
                  ))}
                </fieldset>
                <p className="example-studio__hint" id="saved-technique-help">
                  Slides, hammer-ons, and pull-offs need compatible notes on the same string.
                </p>
                <label className="example-studio__check-control">
                  <input
                    type="checkbox"
                    checked={selectedNote.reviewed}
                    disabled={editorDisabled}
                    onChange={(event) =>
                      setProject(updateNote(project, selectedNote.id, (note) => ({
                        ...note,
                        reviewed: event.target.checked,
                      })))
                    }
                  />
                  <span>Reviewed</span>
                </label>
              </>
            ) : (
              <p>Select a note above to edit its fingering.</p>
            )}
          </aside>
        </div>
      </section>

      <section className="example-studio__finish" aria-labelledby="saved-export-heading">
        <div>
          <p className="eyebrow">Take it with you</p>
          <h2 id="saved-export-heading">Export this working version</h2>
          <p>
            Exports include unsaved edits. The immutable public example stays available separately.
          </p>
          {project.example_slug ? (
            <Link className="text-link" href={`/try/${encodeURIComponent(project.example_slug)}`}>
              Open public example
            </Link>
          ) : null}
        </div>
        <div className="example-studio__export-actions">
          {EXPORTS.map((item) => (
            <button type="button" key={item.format} onClick={() => void downloadExport(item.format)}>
              {item.label}
            </button>
          ))}
        </div>
      </section>

      <section className="example-studio__finish" aria-labelledby="delete-copy-heading">
        <div>
          <p className="eyebrow">Permanent action</p>
          <h2 id="delete-copy-heading">Delete this saved copy</h2>
          <p>The public example stays available. This private copy cannot be recovered.</p>
        </div>
        <button className="button button--quiet" type="button" disabled={editorDisabled} onClick={() => void deleteCopy()}>
          {deleting ? "Deleting…" : "Delete permanently"}
        </button>
      </section>

    </main>
  );
}

export default SavedProjectStudio;
