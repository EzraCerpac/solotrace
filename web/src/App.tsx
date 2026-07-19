import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api, ApiError } from './api'
import { Icon } from './components/Icon'
import { NoteInspector } from './components/NoteInspector'
import { PipelineStrip } from './components/PipelineStrip'
import { TabEditor } from './components/TabEditor'
import { Transport } from './components/Transport'
import { UploadDialog } from './components/UploadDialog'
import { Waveform } from './components/Waveform'
import { formatTime, minimumConfidence, pitchName } from './music'
import type {
  AssetRole,
  Capabilities,
  Fingering,
  FingeringMode,
  NoteEvent,
  Passage,
  Project,
} from './types'

function projectSubtitle(project: Project): string {
  return [project.artist, project.source_name].filter(Boolean).join(' · ')
}

function App() {
  const audioRef = useRef<HTMLAudioElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const savingRef = useRef(false)
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  const [loading, setLoading] = useState(true)
  const [track, setTrack] = useState<AssetRole>('original')
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [loop, setLoop] = useState(false)
  const [passage, setPassage] = useState<Passage | null>(null)
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [railOpen, setRailOpen] = useState(false)
  const [mobileLayout, setMobileLayout] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const loadInitial = useCallback(async () => {
    setLoading(true)
    try {
      const [nextProjects, nextCapabilities] = await Promise.all([
        api.listProjects(),
        api.capabilities(),
      ])
      setProjects(nextProjects)
      setCapabilities(nextCapabilities)
      const initial =
        nextProjects.find((candidate) => candidate.demo) ?? nextProjects.at(0) ?? null
      setProject(initial)
      setPassage(initial?.passage ?? null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'SoloTrace did not start')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadInitial()
  }, [loadInitial])

  useEffect(() => {
    const query = window.matchMedia('(max-width: 820px)')
    const update = () => setMobileLayout(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!project || !['queued', 'running'].includes(project.run.state)) return
    let cancelled = false
    let timeout = 0
    let retryDelay = 800
    const schedule = (delay: number) => {
      timeout = window.setTimeout(poll, delay)
    }
    const poll = async () => {
      try {
        const next = await api.getProject(project.id)
        if (cancelled) return
        retryDelay = 800
        setProject(next)
        setProjects((current) =>
          current.map((candidate) => (candidate.id === next.id ? next : candidate)),
        )
        if (['queued', 'running'].includes(next.run.state)) {
          schedule(800)
        } else {
          if (next.run.state === 'complete') setPassage(next.passage)
          setNotice(next.run.state === 'complete' ? 'Draft ready' : '')
        }
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError instanceof Error ? pollError.message : 'Progress check failed')
          retryDelay = Math.min(5_000, retryDelay * 1.7)
          schedule(retryDelay)
        }
      }
    }
    schedule(500)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [project?.id, project?.run.state])

  const assets = project?.assets ?? []
  const currentAsset =
    assets.find((asset) => asset.role === track) ??
    assets.find((asset) => asset.role === 'original') ??
    null

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentAsset) return
    const preserveTime = Math.min(currentTime, currentAsset.duration_s)
    audio.src = currentAsset.url
    audio.playbackRate = speed
    audio.preservesPitch = true
    const ready = () => {
      audio.currentTime = preserveTime
      if (playing) void audio.play()
    }
    audio.addEventListener('loadedmetadata', ready, { once: true })
    audio.load()
    return () => audio.removeEventListener('loadedmetadata', ready)
    // currentTime and playing are intentionally captured only when source changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentAsset?.url])

  useEffect(() => {
    const audio = audioElement
    if (!audio) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnded = () => setPlaying(false)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
    }
  }, [audioElement])

  useEffect(() => {
    if (!playing) return
    let animationFrame = 0
    const update = () => {
      const audio = audioRef.current
      if (!audio) return
      if (loop && passage && audio.currentTime >= passage.end_s) {
        audio.currentTime = passage.start_s
      }
      setCurrentTime(audio.currentTime)
      animationFrame = requestAnimationFrame(update)
    }
    animationFrame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(animationFrame)
  }, [loop, passage, playing])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) void audio.play()
    else audio.pause()
  }, [])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return
      const target = event.target as HTMLElement | null
      if (
        target?.matches('input, textarea, select, button') ||
        target?.isContentEditable
      ) {
        return
      }
      event.preventDefault()
      togglePlay()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [togglePlay])

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current
    if (!audio) return
    const next = Math.max(0, Math.min(audio.duration || Number.POSITIVE_INFINITY, seconds))
    audio.currentTime = next
    setCurrentTime(next)
  }, [])

  const bindAudio = useCallback((node: HTMLAudioElement | null) => {
    audioRef.current = node
    setAudioElement(node)
  }, [])

  const updatePassage = useCallback((next: Passage) => {
    setPassage(next)
  }, [])

  const selectedNote =
    project?.tab.notes.find((note) => note.id === selectedNoteId) ?? null
  const uncertainNotes = useMemo(
    () =>
      project?.tab.notes
        .filter((note) => minimumConfidence(note.confidence) < 0.72)
        .sort((left, right) => left.audio_onset_s - right.audio_onset_s) ?? [],
    [project],
  )

  const adoptProject = (next: Project, includePassage = true) => {
    setProject(next)
    if (includePassage) setPassage(next.passage)
    setProjects((current) => {
      const exists = current.some((candidate) => candidate.id === next.id)
      return exists
        ? current.map((candidate) => (candidate.id === next.id ? next : candidate))
        : [next, ...current]
    })
  }

  const saveNotes = async (notes: NoteEvent[], message: string) => {
    if (!project || savingRef.current) return
    const previous = project
    savingRef.current = true
    setSaving(true)
    setError('')
    setProject({ ...project, tab: { ...project.tab, notes } })
    try {
      const updated = await api.patchNotes(project.id, project.tab.revision, notes)
      adoptProject(updated)
      setNotice(message)
    } catch (saveError) {
      if (saveError instanceof ApiError && saveError.status === 409) {
        const fresh = await api.getProject(project.id)
        adoptProject(fresh)
        setError('A newer edit won. Reloaded latest notes; try your change again.')
      } else {
        setProject((current) => (current?.id === previous.id ? previous : current))
        setProjects((current) =>
          current.map((candidate) =>
            candidate.id === previous.id ? previous : candidate,
          ),
        )
        setError(saveError instanceof Error ? saveError.message : 'Could not save note')
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const changeFingering = (noteId: string, fingering: Fingering) => {
    if (!project || savingRef.current) return
    const notes = project.tab.notes.map((note) =>
      note.id === noteId
        ? {
            ...note,
            string: fingering.string,
            fret: fingering.fret,
            user_locked: true,
            confidence: { ...note.confidence, fingering: 1 },
          }
        : note,
    )
    void saveNotes(notes, `Moved note to string ${fingering.string}, fret ${fingering.fret}`)
  }

  const saveSelectedNote = (nextNote: NoteEvent) => {
    if (!project || savingRef.current) return
    const notes = project.tab.notes.map((note) => (note.id === nextNote.id ? nextNote : note))
    void saveNotes(notes, 'Note saved')
  }

  const createDraft = async () => {
    if (!project || !passage) return
    setError('')
    try {
      const next = await api.processProject(
        project.id,
        passage,
        project.tab.tuning,
        project.tab.fret_count,
        project.tab.revision,
      )
      adoptProject(next, false)
    } catch (draftError) {
      setError(draftError instanceof Error ? draftError.message : 'Could not create draft')
    }
  }

  const refinger = async (mode: FingeringMode) => {
    if (!project || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const next = await api.refinger(project.id, project.tab.revision, mode)
      adoptProject(next)
      setNotice(
        mode === 'easiest'
          ? 'Easiest fingering applied'
          : mode === 'position'
            ? 'Position-focused fingering applied'
            : 'Balanced fingering applied',
      )
    } catch (refingerError) {
      setError(refingerError instanceof Error ? refingerError.message : 'Could not refinger')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const chooseProject = (next: Project) => {
    audioRef.current?.pause()
    setProject(next)
    setPassage(next.passage)
    setTrack('original')
    setCurrentTime(0)
    setSelectedNoteId(null)
    setRailOpen(false)
    if (mobileLayout) {
      window.requestAnimationFrame(() => menuButtonRef.current?.focus())
    }
  }

  const switchTrack = (role: AssetRole) => {
    const audioTime = audioRef.current?.currentTime
    if (audioTime !== undefined && Number.isFinite(audioTime)) {
      setCurrentTime(audioTime)
    }
    setTrack(role)
  }

  if (loading) {
    return (
      <main className="startup">
        <div className="brand-mark" aria-hidden="true">
          ST
        </div>
        <p>Setting up the tracing table…</p>
      </main>
    )
  }

  if (!project || !passage) {
    return (
      <main className="startup error">
        <div className="brand-mark" aria-hidden="true">
          ST
        </div>
        <h1>SoloTrace could not open a project</h1>
        <p>{error || 'Restart the local service and try again.'}</p>
        <button className="button primary" type="button" onClick={() => void loadInitial()}>
          Try again
        </button>
      </main>
    )
  }

  return (
    <div className={`app-shell ${selectedNote ? 'has-inspector' : ''}`}>
      <audio ref={bindAudio} preload="metadata" />
      <header className="app-header">
        <button
          ref={menuButtonRef}
          type="button"
          className="icon-button mobile-menu"
          aria-label="Open project list"
          aria-expanded={railOpen}
          aria-controls="project-rail"
          onClick={() => setRailOpen((value) => !value)}
        >
          <Icon name="menu" />
        </button>
        <button
          type="button"
          className="wordmark"
          onClick={() => setRailOpen((value) => !value)}
          aria-label="SoloTrace project list"
        >
          SOLOTRACE
        </button>
        <div className="song-heading">
          <h1>{project.title}</h1>
          <span>{projectSubtitle(project)}</span>
        </div>
        <div className="save-state">
          <span className={saving ? 'saving' : ''} />
          {saving ? 'Saving' : `Revision ${project.tab.revision}`}
        </div>
        <details className="export-menu">
          <summary className="button secondary">
            <Icon name="download" />
            Export
            <Icon name="chevron" />
          </summary>
          <div>
            {[
              ['bundle', 'SoloTrace bundle', 'Project, tab, and audio'],
              ['musicxml', 'MusicXML', 'Tab and notation'],
              ['midi', 'MIDI', 'Quantized reference'],
              ['ascii', 'Text tab', 'Portable plain text'],
              ['json', 'Project JSON', 'Lossless tab data'],
            ].map(([format, label, detail]) => (
              <a key={format} href={`/api/projects/${project.id}/export/${format}`}>
                <span>{label}</span>
                <small>{detail}</small>
              </a>
            ))}
          </div>
        </details>
      </header>

      <div className="workspace">
        <aside
          id="project-rail"
          className={`project-rail ${railOpen ? 'open' : ''}`}
          aria-hidden={mobileLayout && !railOpen}
          inert={mobileLayout && !railOpen}
        >
          <button
            className="button choose-song"
            type="button"
            disabled={saving}
            onClick={() => setUploadOpen(true)}
          >
            <Icon name="folder" />
            Choose a song
          </button>
          <nav aria-label="Projects">
            <p className="rail-label">Songs</p>
            {projects.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                disabled={saving}
                className={candidate.id === project.id ? 'active' : ''}
                onClick={() => chooseProject(candidate)}
              >
                <span>{candidate.title}</span>
                <small>
                  {candidate.demo ? 'Playable demo' : formatTime(candidate.duration_s)}
                </small>
              </button>
            ))}
          </nav>
          <div className="rail-group">
            <p className="rail-label">Tuning</p>
            <strong>{project.tab.tuning.map(pitchName).join(' · ')}</strong>
            <span>{project.tab.fret_count} frets</span>
          </div>
          <div className="rail-group">
            <p className="rail-label">Draft style</p>
            <button
              type="button"
              className="rail-choice"
              disabled={saving || !project.tab.notes.length}
              onClick={() => void refinger('balanced')}
            >
              Balanced
            </button>
            <button
              type="button"
              className="rail-choice"
              disabled={saving || !project.tab.notes.length}
              onClick={() => void refinger('easiest')}
            >
              Easiest
            </button>
            <button
              type="button"
              className="rail-choice"
              disabled={saving || !project.tab.notes.length}
              onClick={() => void refinger('position')}
            >
              Stay in one position
            </button>
          </div>
          <div className="rail-provenance">
            <p className="rail-label">Draft source</p>
            <strong>
              {project.separation_scope === 'exact'
                ? 'Exact demo stems'
                : project.separation_scope === 'preview'
                  ? 'Local preview'
                  : 'Guitar separator'}
            </strong>
            <span>Audio stays local</span>
          </div>
        </aside>

        <main className="editor">
          <PipelineStrip run={project.run} />
          <section className="track-toolbar" aria-label="Audio source">
            <div className="track-switcher">
              {(
                [
                  ['original', 'Full mix'],
                  ['lead', 'Lead'],
                  ['backing', 'Backing'],
                ] as Array<[AssetRole, string]>
              ).map(([role, label]) => (
                <button
                  type="button"
                  key={role}
                  className={track === role ? 'active' : ''}
                  disabled={!assets.some((asset) => asset.role === role)}
                  onClick={() => switchTrack(role)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="review-tools">
              <button
                type="button"
                className="review-count"
                disabled={!uncertainNotes.length}
                onClick={() => {
                  const currentIndex = uncertainNotes.findIndex(
                    (note) => note.id === selectedNoteId,
                  )
                  const next = uncertainNotes[(currentIndex + 1) % uncertainNotes.length]
                  if (next) {
                    setSelectedNoteId(next.id)
                    seek(next.audio_onset_s)
                  }
                }}
              >
                <span>{uncertainNotes.length}</span>
                {uncertainNotes.length === 1 ? 'note needs review' : 'notes need review'}
                <Icon name="next" />
              </button>
            </div>
          </section>

          <div className="editor-canvas">
            <Waveform
              audio={audioElement}
              audioUrl={currentAsset?.url ?? ''}
              currentTime={currentTime}
              duration={project.duration_s}
              peaks={project.waveform_peaks}
              passage={passage}
              onPassageChange={updatePassage}
              onSeek={seek}
            />
            <div className="draft-action-row">
              <div>
                <span>
                  {formatTime(passage.start_s)}–{formatTime(passage.end_s)}
                </span>
                <small>{(passage.end_s - passage.start_s).toFixed(1)} second solo</small>
              </div>
              <button
                className="button primary"
                type="button"
                disabled={['queued', 'running'].includes(project.run.state)}
                onClick={() => void createDraft()}
              >
                <Icon name="spark" />
                {project.tab.notes.length ? 'Rebuild draft' : 'Create draft'}
              </button>
            </div>
            <TabEditor
              project={project}
              currentTime={currentTime}
              selectedNoteId={selectedNoteId}
              onSelectNote={setSelectedNoteId}
              onSeek={seek}
              onFingeringChange={changeFingering}
              disabled={saving}
            />
          </div>
        </main>

        {selectedNote && (
          <NoteInspector
            note={selectedNote}
            saving={saving}
            onClose={() => setSelectedNoteId(null)}
            onSave={saveSelectedNote}
            onAudition={(note) => {
              seek(Math.max(0, note.audio_onset_s - 0.35))
              void audioRef.current?.play()
            }}
          />
        )}
      </div>

      <Transport
        playing={playing}
        currentTime={currentTime}
        duration={project.duration_s}
        speed={speed}
        loop={loop}
        loopStart={passage.start_s}
        loopEnd={passage.end_s}
        onTogglePlay={togglePlay}
        onSeek={seek}
        onSpeed={(nextSpeed) => {
          setSpeed(nextSpeed)
          if (audioRef.current) {
            audioRef.current.playbackRate = nextSpeed
            audioRef.current.preservesPitch = true
          }
        }}
        onLoop={setLoop}
      />

      <UploadDialog
        open={uploadOpen}
        capabilities={capabilities}
        onClose={() => setUploadOpen(false)}
        onUpload={async (file, title, artist) => {
          const next = await api.createProject(file, title, artist)
          adoptProject(next)
          setTrack('original')
          setCurrentTime(0)
          return next
        }}
      />

      {(notice || error) && (
        <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
          {error ? <Icon name="warning" /> : <Icon name="check" />}
          <span>{error || notice}</span>
          <button
            className="icon-button"
            type="button"
            aria-label="Dismiss message"
            onClick={() => {
              setError('')
              setNotice('')
            }}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
    </div>
  )
}

export default App
