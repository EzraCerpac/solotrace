import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  deleteChordToUnknown,
  emptyChordTrack,
  mergeChord,
  moveChordBoundary,
  normalizeChordTrack,
  replaceChordSymbol,
  setChordReviewed,
  splitChord,
} from '@solotrace/editor'
import { api, ApiError } from './api'
import { desktopEditorClient, toDesktopProject } from './editor-client'
import { Icon } from './components/Icon'
import { MVSepDialog } from './components/MVSepDialog'
import { ChordInspector } from './components/ChordInspector'
import { NoteInspector } from './components/NoteInspector'
import { PipelineStrip } from './components/PipelineStrip'
import { ProjectDialog } from './components/ProjectDialog'
import { PlayTab } from './components/PlayTab'
import { TabEditor } from './components/TabEditor'
import { Transport } from './components/Transport'
import { UploadDialog } from './components/UploadDialog'
import { VersionDialog } from './components/VersionDialog'
import { Waveform } from './components/Waveform'
import { formatTime, pitchName } from './music'
import { audioFrameToScoreTick } from './music'
import { reviewItemsForProject, type ReviewItem } from './review'
import { legalFingerings, soundingTuning, availableFretCount } from '@solotrace/editor'
import type {
  AssetRole,
  Capabilities,
  ChordEvent,
  ChordTrack,
  DraftEngine,
  DraftScope,
  Fingering,
  FingeringMode,
  NoteEvent,
  Passage,
  Project,
  ProjectSummary,
  TabVersionSummary,
} from './types'

const LAST_PROJECT_KEY = 'solotrace.lastProject'

async function loadDesktopProject(projectId: string): Promise<Project> {
  const editorProject = await desktopEditorClient.loadProject({
    origin: 'local',
    id: projectId,
  })
  return toDesktopProject(editorProject)
}

function projectSubtitle(project: Project): string {
  return [project.artist, project.source_name].filter(Boolean).join(' · ')
}

function summaryFromProject(project: Project): ProjectSummary {
  const active = project.versions.find(
    (version) => version.id === project.active_version_id,
  )
  return {
    id: project.id,
    title: project.title,
    artist: project.artist,
    updated_at: project.updated_at,
    revision: project.revision,
    duration_s: project.duration_s,
    source_name: project.source_name,
    demo: project.demo,
    trashed_at: project.trashed_at,
    active_version_id: project.active_version_id,
    active_version_name: active?.name ?? 'Tab',
    note_count: active?.note_count ?? project.tab.notes.length,
    needs_review_count: active?.needs_review_count ?? 0,
    chord_count: active?.chord_count ?? project.tab.chords.events.length,
    chord_needs_review_count:
      active?.chord_needs_review_count ??
      project.tab.chords.events.filter((chord) => !chord.reviewed).length,
  }
}

interface WorkspacePreferences {
  track: AssetRole
  speed: number
  loop: boolean
  draftScope: DraftScope
}

interface InstrumentProfile {
  tuning: number[]
  capoFret: number
  fretCount: number
  preferredFret: number | null
}

type ReviewHistoryEntry =
  | {
      kind: 'notes'
      before: NoteEvent[]
      after: NoteEvent[]
    }
  | {
      kind: 'chords'
      before: ChordTrack
      after: ChordTrack
    }

interface ReviewReturnState {
  track: AssetRole
  loop: boolean
}

function preferenceKey(projectId: string): string {
  return `solotrace.workspace.${projectId}`
}

function readPreferences(projectId: string): WorkspacePreferences | null {
  try {
    const value = window.localStorage.getItem(preferenceKey(projectId))
    return value ? (JSON.parse(value) as WorkspacePreferences) : null
  } catch {
    return null
  }
}

function App() {
  const audioRef = useRef<HTMLAudioElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const bundleInputRef = useRef<HTMLInputElement>(null)
  const savingRef = useRef(false)
  const reviewUndoRef = useRef<ReviewHistoryEntry[]>([])
  const reviewRedoRef = useRef<ReviewHistoryEntry[]>([])
  const reviewReturnRef = useRef<ReviewReturnState | null>(null)
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [trashedProjects, setTrashedProjects] = useState<ProjectSummary[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  const [draftScope, setDraftScope] = useState<DraftScope>('whole')
  const [draftEngine, setDraftEngine] = useState<DraftEngine>('preview')
  const [cloudConsent, setCloudConsent] = useState(false)
  const [loading, setLoading] = useState(true)
  const [track, setTrack] = useState<AssetRole>('original')
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [loop, setLoop] = useState(false)
  const [passage, setPassage] = useState<Passage | null>(null)
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const [selectedChordId, setSelectedChordId] = useState<string | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [mvsepOpen, setMvsepOpen] = useState(false)
  const [versionOpen, setVersionOpen] = useState(false)
  const [projectDialogProject, setProjectDialogProject] =
    useState<ProjectSummary | null>(null)
  const [railOpen, setRailOpen] = useState(false)
  const [mobileLayout, setMobileLayout] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [viewMode, setViewMode] = useState<'edit' | 'play'>('edit')
  const [fullscreen, setFullscreen] = useState(false)
  const [reviewMode, setReviewMode] = useState(false)
  const [instrumentProfile, setInstrumentProfile] = useState<InstrumentProfile>({
    tuning: [40, 45, 50, 55, 59, 64],
    capoFret: 0,
    fretCount: 22,
    preferredFret: null,
  })

  const loadInitial = useCallback(async () => {
    setLoading(true)
    try {
      const [library, nextCapabilities] = await Promise.all([
        api.listProjects(true),
        api.capabilities(),
      ])
      const activeProjects = library.filter((candidate) => !candidate.trashed_at)
      setProjects(activeProjects)
      setTrashedProjects(library.filter((candidate) => candidate.trashed_at))
      setCapabilities(nextCapabilities)
      let lastProjectId: string | null = null
      try {
        lastProjectId = window.localStorage.getItem(LAST_PROJECT_KEY)
      } catch {
        // Persistence is best-effort when browser storage is disabled.
      }
      const initialSummary =
        activeProjects.find((candidate) => candidate.id === lastProjectId) ??
        activeProjects.find((candidate) => !candidate.demo) ??
        activeProjects.at(0) ??
        null
      const initial = initialSummary
        ? await loadDesktopProject(initialSummary.id)
        : null
      setProject(initial)
      setPassage(initial?.passage ?? null)
      if (initial) {
        const preferences = readPreferences(initial.id)
        setTrack(preferences?.track ?? 'original')
        setSpeed(preferences?.speed ?? 1)
        setLoop(preferences?.loop ?? false)
        setDraftScope(preferences?.draftScope ?? 'whole')
        window.localStorage.setItem(LAST_PROJECT_KEY, initial.id)
      }
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
    setSelectedNoteId(null)
    setSelectedChordId(null)
    setReviewMode(false)
    reviewReturnRef.current = null
  }, [project?.active_version_id, project?.id])

  useEffect(() => {
    const query = window.matchMedia('(max-width: 820px)')
    const update = () => setMobileLayout(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const update = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', update)
    update()
    return () => document.removeEventListener('fullscreenchange', update)
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
        if (!savingRef.current) {
          setProject((current) =>
            current && current.id === next.id && current.revision > next.revision
              ? current
              : next,
          )
        }
        setProjects((current) =>
          current.map((candidate) =>
            candidate.id === next.id ? summaryFromProject(next) : candidate,
          ),
        )
        if (['queued', 'running'].includes(next.run.state)) {
          schedule(800)
        } else {
          if (next.run.state === 'complete') setPassage(next.passage)
          setCloudConsent(false)
          setNotice(
            next.run.state === 'complete'
              ? 'Draft ready'
              : next.run.state === 'cancelled'
                ? 'Draft cancelled'
                : '',
          )
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
    if (!project) return
    setInstrumentProfile({
      tuning: [...project.tab.tuning],
      capoFret: project.tab.capo_fret,
      fretCount: project.tab.fret_count,
      preferredFret: project.tab.preferred_fret,
    })
    reviewUndoRef.current = []
    reviewRedoRef.current = []
  }, [project?.id, project?.active_version_id])

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
      const reviewSelection =
        project?.tab.chords.events.find((chord) => chord.id === selectedChordId) ??
        project?.tab.notes.find((note) => note.id === selectedNoteId)
      const loopStart =
        reviewMode && reviewSelection
          ? Math.max(0, reviewSelection.audio_onset_s - 0.75)
          : passage?.start_s
      const loopEnd =
        reviewMode && reviewSelection
          ? Math.min(
              project?.duration_s ?? reviewSelection.audio_offset_s,
              reviewSelection.audio_offset_s + 0.75,
            )
          : passage?.end_s
      if (
        loop &&
        loopStart !== undefined &&
        loopEnd !== undefined &&
        audio.currentTime >= loopEnd
      ) {
        audio.currentTime = loopStart
      }
      setCurrentTime(audio.currentTime)
      animationFrame = requestAnimationFrame(update)
    }
    animationFrame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(animationFrame)
  }, [
    loop,
    passage,
    playing,
    project,
    reviewMode,
    selectedChordId,
    selectedNoteId,
  ])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) void audio.play()
    else audio.pause()
  }, [])

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
  const selectedChord =
    project?.tab.chords.events.find((chord) => chord.id === selectedChordId) ?? null
  const selectedChordIndex =
    project?.tab.chords.events.findIndex((chord) => chord.id === selectedChordId) ?? -1
  const reviewSelection = selectedChord ?? selectedNote
  const playbackLoopStart =
    reviewMode && reviewSelection
      ? Math.max(0, reviewSelection.audio_onset_s - 0.75)
      : passage?.start_s ?? 0
  const playbackLoopEnd =
    reviewMode && reviewSelection
      ? Math.min(
          project?.duration_s ?? reviewSelection.audio_offset_s,
          reviewSelection.audio_offset_s + 0.75,
        )
      : passage?.end_s ?? project?.duration_s ?? 0
  const reviewItems = useMemo(
    () => (project ? reviewItemsForProject(project) : []),
    [project],
  )
  const selectedReviewIndex = reviewItems.findIndex(
    (item) => item.id === (selectedChordId ?? selectedNoteId),
  )
  const selectedStart = draftScope === 'whole' ? 0 : passage?.start_s ?? 0
  const selectedEnd = draftScope === 'whole' ? project?.duration_s ?? 0 : passage?.end_s ?? 0
  const selectedDuration = Math.max(0, selectedEnd - selectedStart)
  const cloudReady = capabilities?.cloudReady ?? false
  const mvsepMaximumDuration = capabilities?.separation.mvsepMaxDurationS ?? 600
  const selectionTooLong =
    draftEngine === 'mvsep' && selectedDuration > mvsepMaximumDuration
  const processing = ['queued', 'running'].includes(project?.run.state ?? '')
  const activeVersion = project?.versions.find(
    (version) => version.id === project.active_version_id,
  )

  const adoptProject = (next: Project, includePassage = true) => {
    setProject(next)
    if (includePassage) setPassage(next.passage)
    try {
      window.localStorage.setItem(LAST_PROJECT_KEY, next.id)
    } catch {
      // Persistence is best-effort when browser storage is disabled.
    }
    setProjects((current) => {
      if (next.trashed_at) {
        return current.filter((candidate) => candidate.id !== next.id)
      }
      const exists = current.some((candidate) => candidate.id === next.id)
      const summary = summaryFromProject(next)
      return exists
        ? current.map((candidate) => (candidate.id === next.id ? summary : candidate))
        : [summary, ...current]
    })
    setTrashedProjects((current) => {
      if (!next.trashed_at) {
        return current.filter((candidate) => candidate.id !== next.id)
      }
      const summary = summaryFromProject(next)
      const exists = current.some((candidate) => candidate.id === next.id)
      return exists
        ? current.map((candidate) => (candidate.id === next.id ? summary : candidate))
        : [summary, ...current]
    })
  }

  const saveNotes = async (
    notes: NoteEvent[],
    message: string,
    recordHistory = true,
  ): Promise<Project | null> => {
    if (viewMode !== 'edit' || !project || savingRef.current) return null
    const previous = project
    savingRef.current = true
    setSaving(true)
    setError('')
    setProject({ ...project, tab: { ...project.tab, notes } })
    try {
      const updated = toDesktopProject(
        await desktopEditorClient.applyVersionAction({
          projectId: project.id,
          expectedRevision: project.revision,
          action: {
            type: 'replace-notes',
            versionId: project.active_version_id,
            notes,
          },
        }),
      )
      adoptProject(updated, false)
      if (recordHistory) {
        reviewUndoRef.current.push({
          kind: 'notes',
          before: previous.tab.notes,
          after: notes,
        })
        reviewUndoRef.current = reviewUndoRef.current.slice(-100)
        reviewRedoRef.current = []
      }
      setNotice(message)
      return updated
    } catch (saveError) {
      if (saveError instanceof ApiError && saveError.status === 409) {
        const fresh = await loadDesktopProject(project.id)
        adoptProject(fresh)
        setSelectedNoteId(null)
        reviewUndoRef.current = []
        reviewRedoRef.current = []
        setError('A newer edit won. Review history was cleared and the latest version reloaded.')
      } else {
        setProject((current) => (current?.id === previous.id ? previous : current))
        setProjects((current) =>
          current.map((candidate) =>
            candidate.id === previous.id ? summaryFromProject(previous) : candidate,
          ),
        )
        setError(saveError instanceof Error ? saveError.message : 'Could not save note')
      }
      return null
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const saveChords = async (
    track: ChordTrack,
    message: string,
    recordHistory = true,
  ): Promise<Project | null> => {
    if (viewMode !== 'edit' || !project || savingRef.current) return null
    const previous = project
    const normalized = normalizeChordTrack(track, project.tab)
    savingRef.current = true
    setSaving(true)
    setError('')
    setProject({ ...project, tab: { ...project.tab, chords: normalized } })
    try {
      const updated = toDesktopProject(
        await desktopEditorClient.applyVersionAction({
          projectId: project.id,
          expectedRevision: project.revision,
          action: {
            type: 'replace-chords',
            versionId: project.active_version_id,
            track: normalized,
          },
        }),
      )
      adoptProject(updated, false)
      if (recordHistory) {
        reviewUndoRef.current.push({
          kind: 'chords',
          before: previous.tab.chords,
          after: normalized,
        })
        reviewUndoRef.current = reviewUndoRef.current.slice(-100)
        reviewRedoRef.current = []
      }
      setNotice(message)
      return updated
    } catch (saveError) {
      if (saveError instanceof ApiError && saveError.status === 409) {
        const fresh = await loadDesktopProject(project.id)
        adoptProject(fresh)
        setSelectedChordId(null)
        reviewUndoRef.current = []
        reviewRedoRef.current = []
        setError('A newer edit won. Review history was cleared and the latest version reloaded.')
      } else {
        setProject((current) => (current?.id === previous.id ? previous : current))
        setError(saveError instanceof Error ? saveError.message : 'Could not save chords')
      }
      return null
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const selectReviewItem = (item: ReviewItem | undefined) => {
    if (!item) return
    if (item.kind === 'note') {
      setSelectedChordId(null)
      setSelectedNoteId(item.id)
    } else {
      setSelectedNoteId(null)
      setSelectedChordId(item.id)
    }
    seek(Math.max(0, item.time - 0.75))
  }

  const moveReviewSelection = (direction: -1 | 1) => {
    if (!reviewItems.length) return
    if (selectedReviewIndex < 0) {
      selectReviewItem(direction === 1 ? reviewItems[0] : reviewItems.at(-1))
      return
    }
    const nextIndex =
      (selectedReviewIndex + direction + reviewItems.length) % reviewItems.length
    selectReviewItem(reviewItems[nextIndex])
  }

  const startReview = () => {
    if (!reviewItems.length) return
    reviewReturnRef.current = { track, loop }
    setReviewMode(true)
    setLoop(true)
    if (assets.some((asset) => asset.role === 'lead')) switchTrack('lead')
    selectReviewItem(reviewItems[0])
  }

  const finishReview = () => {
    const previous = reviewReturnRef.current
    reviewReturnRef.current = null
    setReviewMode(false)
    setSelectedNoteId(null)
    setSelectedChordId(null)
    if (!previous) return
    setLoop(previous.loop)
    if (assets.some((asset) => asset.role === previous.track)) {
      switchTrack(previous.track)
    }
  }

  const selectNextReview = (
    nextProject: Project,
    previous: { id: string; audio_onset_s: number },
  ) => {
    const unresolved = reviewItemsForProject(nextProject)
    const next =
      unresolved.find((item) => item.time > previous.audio_onset_s + 0.0001) ??
      unresolved[0]
    if (!next) {
      setSelectedNoteId(null)
      setSelectedChordId(null)
      return
    }
    selectReviewItem(next)
  }

  const moveBoundary = (leftChordId: string, seconds: number) => {
    if (!project) return
    try {
      const track = normalizeChordTrack(
        moveChordBoundary(project.tab.chords, leftChordId, seconds),
        project.tab,
      )
      void saveChords(track, 'Chord boundary moved')
    } catch (boundaryError) {
      setError(boundaryError instanceof Error ? boundaryError.message : 'Could not move boundary')
    }
  }

  const addChordAtPlayhead = () => {
    if (!project) return
    const id = `chord-${crypto.randomUUID()}`
    let track = project.tab.chords
    try {
      if (!track.events.length) {
        const start = project.passage.start_s
        const end = project.passage.end_s
        const event: ChordEvent = {
          id,
          onset_frame: 0,
          end_frame: 1,
          audio_onset_s: start,
          audio_offset_s: end,
          score_tick: 0,
          duration_ticks: 1,
          kind: 'unknown',
          root: null,
          quality: null,
          bass: null,
          model_score: null,
          alternatives: [],
          provenance: 'manual',
          edited: true,
          reviewed: false,
        }
        track = {
          ...emptyChordTrack(),
          analyzed_start_s: start,
          analyzed_end_s: end,
          events: [event],
        }
      } else {
        const target =
          track.events.find(
            (chord) =>
              currentTime > chord.audio_onset_s && currentTime < chord.audio_offset_s,
          ) ??
          track.events.find((chord) => chord.id === selectedChordId)
        if (!target) throw new Error('Move the playhead inside a chord span first')
        track = splitChord(track, target.id, currentTime, id)
        track = deleteChordToUnknown(track, id)
      }
      track = normalizeChordTrack(track, project.tab)
      void saveChords(track, 'Chord inserted').then((updated) => {
        if (updated) {
          setSelectedNoteId(null)
          setSelectedChordId(id)
        }
      })
    } catch (insertError) {
      setError(insertError instanceof Error ? insertError.message : 'Could not insert chord')
    }
  }

  const saveSelectedChord = (symbol: string, start: number, end: number) => {
    if (!project || !selectedChord) return
    try {
      let track = replaceChordSymbol(project.tab.chords, selectedChord.id, symbol)
      const events = project.tab.chords.events
      if (selectedChordIndex > 0 && start !== selectedChord.audio_onset_s) {
        track = moveChordBoundary(track, events[selectedChordIndex - 1].id, start)
      }
      if (
        selectedChordIndex < events.length - 1 &&
        end !== selectedChord.audio_offset_s
      ) {
        track = moveChordBoundary(track, selectedChord.id, end)
      }
      const reviewed = setChordReviewed(track, selectedChord.id, true)
      void saveChords(reviewed, 'Chord changes saved').then((updated) => {
        if (updated) selectNextReview(updated, selectedChord)
      })
    } catch (chordError) {
      setError(chordError instanceof Error ? chordError.message : 'Could not edit chord')
    }
  }

  const reviewSelectedChord = (reviewed: boolean) => {
    if (!project || !selectedChord) return
    const track = setChordReviewed(project.tab.chords, selectedChord.id, reviewed)
    void saveChords(track, reviewed ? 'Chord accepted' : 'Chord returned to review').then(
      (updated) => {
        if (updated && reviewed) selectNextReview(updated, selectedChord)
      },
    )
  }

  const splitSelectedChord = () => {
    if (!project || !selectedChord) return
    const id = `chord-${crypto.randomUUID()}`
    try {
      const track = splitChord(project.tab.chords, selectedChord.id, currentTime, id)
      void saveChords(track, 'Chord split').then((updated) => {
        if (updated) setSelectedChordId(id)
      })
    } catch (splitError) {
      setError(splitError instanceof Error ? splitError.message : 'Could not split chord')
    }
  }

  const mergeSelectedChord = (direction: 'left' | 'right') => {
    if (!project || !selectedChord) return
    try {
      const track = mergeChord(project.tab.chords, selectedChord.id, direction)
      void saveChords(track, `Merged chord ${direction}`)
    } catch (mergeError) {
      setError(mergeError instanceof Error ? mergeError.message : 'Could not merge chord')
    }
  }

  const deleteSelectedChord = () => {
    if (!project || !selectedChord) return
    const track = setChordReviewed(
      deleteChordToUnknown(project.tab.chords, selectedChord.id),
      selectedChord.id,
      true,
    )
    void saveChords(track, 'Chord changed to unknown').then((updated) => {
      if (updated) selectNextReview(updated, selectedChord)
    })
  }

  const changeFingering = (noteId: string, fingering: Fingering) => {
    if (viewMode !== 'edit' || !project || savingRef.current) return
    const notes = project.tab.notes.map((note) =>
      note.id === noteId
        ? {
            ...note,
            string: fingering.string,
            fret: fingering.fret,
            user_locked: true,
            reviewed: true,
            confidence: { ...note.confidence, fingering: 1 },
          }
        : note,
    )
    void saveNotes(notes, `Moved note to string ${fingering.string}, fret ${fingering.fret}`)
  }

  const undoReviewMutation = async () => {
    if (!project || savingRef.current) return
    const entry = reviewUndoRef.current.pop()
    if (!entry) return
    const updated =
      entry.kind === 'notes'
        ? await saveNotes(entry.before, 'Undid note change', false)
        : await saveChords(entry.before, 'Undid chord change', false)
    if (updated) {
      reviewRedoRef.current.push(entry)
    } else {
      reviewUndoRef.current.push(entry)
    }
  }

  const redoReviewMutation = async () => {
    if (!project || savingRef.current) return
    const entry = reviewRedoRef.current.pop()
    if (!entry) return
    const updated =
      entry.kind === 'notes'
        ? await saveNotes(entry.after, 'Redid note change', false)
        : await saveChords(entry.after, 'Redid chord change', false)
    if (updated) {
      reviewUndoRef.current.push(entry)
    } else {
      reviewRedoRef.current.push(entry)
    }
  }

  const addNoteAtPlayhead = () => {
    if (!project || savingRef.current) return
    const start = Math.max(project.passage.start_s, Math.min(currentTime, project.passage.end_s - 0.01))
    const beatSeconds = 60 / project.tab.tempo_bpm
    const nextOnset = project.tab.notes
      .filter((note) => note.audio_onset_s > start)
      .sort((left, right) => left.audio_onset_s - right.audio_onset_s)[0]?.audio_onset_s
    const end = Math.min(start + beatSeconds, nextOnset ?? Number.POSITIVE_INFINITY, project.passage.end_s)
    const relativeFret = project.tab.preferred_fret ?? 0
    const string = 1
    const tuning = soundingTuning(project.tab)
    const midiPitch = tuning.at(-1)! + relativeFret
    const alternatives = legalFingerings(
      midiPitch,
      tuning,
      availableFretCount(project.tab),
    )
    const chosen = alternatives.find((candidate) => candidate.string === string) ?? alternatives[0]
    const onsetFrame = Math.round(start * project.tab.sample_rate)
    const endFrame = Math.max(onsetFrame + 1, Math.round(end * project.tab.sample_rate))
    const scoreTick = audioFrameToScoreTick(onsetFrame, project.tab.sync_anchors)
    const note: NoteEvent = {
      id: `note-manual-${crypto.randomUUID()}`,
      onset_frame: onsetFrame,
      end_frame: endFrame,
      audio_onset_s: start,
      audio_offset_s: end,
      score_tick: scoreTick,
      duration_ticks: project.tab.ticks_per_quarter,
      midi_pitch: midiPitch,
      pitch_curve_cents: [],
      string: chosen.string,
      fret: chosen.fret,
      techniques: [],
      confidence: { pitch: 1, onset: 1, fingering: 1, technique: 1 },
      alternatives,
      user_locked: true,
      reviewed: true,
    }
    const notes = [...project.tab.notes, note].sort(
      (left, right) => left.audio_onset_s - right.audio_onset_s || left.midi_pitch - right.midi_pitch,
    )
    void saveNotes(notes, 'Added note').then((updated) => {
      if (updated) setSelectedNoteId(note.id)
    })
  }

  const saveSelectedNote = (nextNote: NoteEvent) => {
    if (viewMode !== 'edit' || !project || savingRef.current) return
    const notes = project.tab.notes.map((note) => (note.id === nextNote.id ? nextNote : note))
    void saveNotes(notes, 'Changes saved').then((updated) => {
      if (updated) selectNextReview(updated, nextNote)
    })
  }

  const acceptNote = (note: NoteEvent) => {
    if (!project) return
    const notes = project.tab.notes.map((candidate) =>
      candidate.id === note.id
        ? { ...candidate, reviewed: true, user_locked: false }
        : candidate,
    )
    void saveNotes(notes, 'Note accepted').then((updated) => {
      if (updated) selectNextReview(updated, note)
    })
  }

  const reopenNote = (note: NoteEvent) => {
    if (!project) return
    const notes = project.tab.notes.map((candidate) =>
      candidate.id === note.id
        ? { ...candidate, reviewed: false, user_locked: false }
        : candidate,
    )
    void saveNotes(notes, 'Note returned to review')
  }

  const deleteNote = (note: NoteEvent) => {
    if (!project) return
    const notes = project.tab.notes.filter((candidate) => candidate.id !== note.id)
    setSelectedNoteId(null)
    void saveNotes(notes, 'Note deleted').then((updated) => {
      if (!updated) return
      selectNextReview(updated, note)
    })
  }

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target
      const editingText =
        (target instanceof Element &&
          target.matches('input, textarea, select')) ||
        (target instanceof HTMLElement && target.isContentEditable)
      if (editingText) return

      const key = event.key.toLowerCase()
      if (
        viewMode === 'edit' &&
        (event.metaKey || event.ctrlKey) &&
        key === 'z'
      ) {
        event.preventDefault()
        if (event.shiftKey) void redoReviewMutation()
        else void undoReviewMutation()
        return
      }

      if (reviewMode && viewMode === 'edit' && !event.metaKey && !event.ctrlKey) {
        if (key === 'j') {
          event.preventDefault()
          moveReviewSelection(-1)
          return
        }
        if (key === 'k') {
          event.preventDefault()
          moveReviewSelection(1)
          return
        }
        if (key === 'a' && !savingRef.current) {
          event.preventDefault()
          if (selectedNote) acceptNote(selectedNote)
          else if (selectedChord) reviewSelectedChord(true)
          return
        }
      }

      const interactive =
        target instanceof Element &&
        target.matches('button, summary, a, [role="button"]')
      if (event.code === 'Space' && !interactive) {
        event.preventDefault()
        togglePlay()
      } else if (viewMode === 'play' && event.key === 'ArrowLeft') {
        event.preventDefault()
        seek(currentTime - 5)
      } else if (viewMode === 'play' && event.key === 'ArrowRight') {
        event.preventDefault()
        seek(currentTime + 5)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  })

  const createDraft = async () => {
    if (viewMode !== 'edit' || !project || !passage) return
    setError('')
    const engine = draftEngine
    const selectedPassage =
      draftScope === 'whole'
        ? { start_s: 0, end_s: project.duration_s }
        : passage
    try {
      const next = await api.processProject(
        project.id,
        selectedPassage,
        instrumentProfile.tuning,
        instrumentProfile.capoFret,
        instrumentProfile.fretCount,
        instrumentProfile.preferredFret,
        project.revision,
        engine,
        engine === 'mvsep' && cloudConsent,
      )
      adoptProject(next, false)
    } catch (draftError) {
      setError(draftError instanceof Error ? draftError.message : 'Could not create draft')
    } finally {
      if (engine === 'mvsep') setCloudConsent(false)
    }
  }

  const createChordDraft = async () => {
    if (
      viewMode !== 'edit' ||
      !project ||
      processing ||
      !capabilities?.chords?.available
    ) {
      return
    }
    setError('')
    setSelectedNoteId(null)
    setSelectedChordId(null)
    reviewUndoRef.current = []
    reviewRedoRef.current = []
    try {
      const next = await api.analyzeChords(
        project.id,
        project.active_version_id,
        project.revision,
        project.passage.start_s,
        project.passage.end_s,
      )
      adoptProject(next, false)
      setNotice('Finding chords in the original mix')
    } catch (chordError) {
      setError(chordError instanceof Error ? chordError.message : 'Could not find chords')
    }
  }

  const refinger = async (
    mode: FingeringMode,
    lockPolicy: 'preserve' | 'clear' = 'preserve',
  ) => {
    if (viewMode !== 'edit' || !project || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const next = toDesktopProject(
        await desktopEditorClient.refingerProject({
          projectId: project.id,
          expectedRevision: project.revision,
          sourceVersionId: project.active_version_id,
          mode,
          lockPolicy,
        }),
      )
      adoptProject(next, false)
      setSelectedNoteId(null)
      setNotice(
        lockPolicy === 'clear'
          ? 'Started fresh in a new version'
          :
        mode === 'easiest'
          ? 'Created Easiest version'
          : mode === 'position'
            ? 'Created One position version'
            : 'Created Balanced version',
      )
    } catch (refingerError) {
      setError(refingerError instanceof Error ? refingerError.message : 'Could not refinger')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const chooseProject = async (summary: ProjectSummary) => {
    audioRef.current?.pause()
    setSaving(true)
    try {
      const next = await loadDesktopProject(summary.id)
      const preferences = readPreferences(next.id)
      setProject(next)
      setPassage(next.passage)
      setTrack(preferences?.track ?? 'original')
      setSpeed(preferences?.speed ?? 1)
      setLoop(preferences?.loop ?? false)
      setDraftScope(preferences?.draftScope ?? 'whole')
      setCurrentTime(0)
      setSelectedNoteId(null)
      setRailOpen(false)
      setCloudConsent(false)
      try {
        window.localStorage.setItem(LAST_PROJECT_KEY, next.id)
      } catch {
        // Persistence is best-effort when browser storage is disabled.
      }
    } catch (chooseError) {
      setError(chooseError instanceof Error ? chooseError.message : 'Could not open project')
    } finally {
      setSaving(false)
    }
    if (mobileLayout) {
      window.requestAnimationFrame(() => menuButtonRef.current?.focus())
    }
  }

  const activateVersion = async (version: TabVersionSummary) => {
    if (!project || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const next = toDesktopProject(
        await desktopEditorClient.applyVersionAction({
          projectId: project.id,
          expectedRevision: project.revision,
          action: { type: 'activate', versionId: version.id },
        }),
      )
      adoptProject(next, false)
      setSelectedNoteId(null)
      setNotice(`Opened ${version.name}`)
    } catch (versionError) {
      setError(versionError instanceof Error ? versionError.message : 'Could not open version')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const duplicateVersion = async (version: TabVersionSummary) => {
    if (!project || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const next = await api.createVersion(
        project.id,
        project.revision,
        version.id,
        null,
      )
      adoptProject(next, false)
      setSelectedNoteId(null)
      setNotice(`Duplicated ${version.name}`)
    } catch (versionError) {
      setError(versionError instanceof Error ? versionError.message : 'Could not duplicate version')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const renameVersion = async (version: TabVersionSummary, name: string) => {
    if (!project || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const next = toDesktopProject(
        await desktopEditorClient.applyVersionAction({
          projectId: project.id,
          expectedRevision: project.revision,
          action: { type: 'rename', versionId: version.id, name },
        }),
      )
      adoptProject(next, false)
      setNotice('Version renamed')
    } catch (versionError) {
      setError(versionError instanceof Error ? versionError.message : 'Could not rename version')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const deleteVersion = async (version: TabVersionSummary) => {
    if (!project || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const next = toDesktopProject(
        await desktopEditorClient.applyVersionAction({
          projectId: project.id,
          expectedRevision: project.revision,
          action: { type: 'delete', versionId: version.id },
        }),
      )
      adoptProject(next, false)
      setSelectedNoteId(null)
      setNotice(`Deleted ${version.name}`)
    } catch (versionError) {
      setError(versionError instanceof Error ? versionError.message : 'Could not delete version')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const renameCurrentProject = async (title: string, artist: string) => {
    if (!project || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const next = await api.renameProject(
        project.id,
        project.revision,
        title,
        artist,
      )
      adoptProject(next, false)
      setProjectDialogProject(null)
      setNotice('Project saved')
    } catch (projectError) {
      setError(projectError instanceof Error ? projectError.message : 'Could not rename project')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const trashCurrentProject = async () => {
    if (!project || savingRef.current) return
    const currentId = project.id
    savingRef.current = true
    setSaving(true)
    try {
      const trashed = await api.trashProject(project.id, project.revision)
      adoptProject(trashed, false)
      setProjectDialogProject(null)
      const nextSummary = projects.find((candidate) => candidate.id !== currentId)
      if (nextSummary) {
        await chooseProject(nextSummary)
      } else {
        setProject(null)
        setPassage(null)
      }
      setNotice('Project moved to Trash')
    } catch (projectError) {
      setError(projectError instanceof Error ? projectError.message : 'Could not trash project')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const restoreProject = async (summary: ProjectSummary) => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const restored = await api.restoreProject(summary.id, summary.revision)
      adoptProject(restored, false)
      setNotice(`${restored.title} restored`)
    } catch (projectError) {
      setError(projectError instanceof Error ? projectError.message : 'Could not restore project')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const permanentlyDeleteProject = async (summary: ProjectSummary) => {
    if (
      summary.demo ||
      savingRef.current ||
      !window.confirm(
        `Permanently delete “${summary.title}”? Its audio and tab versions will be removed.`,
      )
    ) {
      return
    }
    savingRef.current = true
    setSaving(true)
    try {
      await api.deleteProject(summary.id, summary.revision)
      setTrashedProjects((current) =>
        current.filter((candidate) => candidate.id !== summary.id),
      )
      setNotice(`${summary.title} permanently deleted`)
    } catch (projectError) {
      setError(
        projectError instanceof Error
          ? projectError.message
          : 'Could not permanently delete project',
      )
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const importProjectBundle = async (file: File) => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      const imported = await api.importProject(file)
      adoptProject(imported)
      setTrack('original')
      setCurrentTime(0)
      setDraftScope('whole')
      setDraftEngine('preview')
      setCloudConsent(false)
      setNotice(`${imported.title} restored from bundle`)
    } catch (importError) {
      setError(
        importError instanceof Error ? importError.message : 'Could not import project',
      )
    } finally {
      savingRef.current = false
      setSaving(false)
      if (bundleInputRef.current) bundleInputRef.current.value = ''
    }
  }

  const saveDiagnostics = async () => {
    const bridge = window.pywebview?.api
    if (!capabilities?.packaged || !bridge) {
      window.location.assign('/api/diagnostics/export')
      return
    }
    const result = await bridge.saveDiagnostics()
    if (!result.ok && !result.cancelled) {
      setError(result.error ?? 'Could not save diagnostics')
    }
  }

  useEffect(() => {
    if (!project) return
    try {
      window.localStorage.setItem(
        preferenceKey(project.id),
        JSON.stringify({ track, speed, loop, draftScope }),
      )
    } catch {
      // Persistence is best-effort when browser storage is disabled.
    }
  }, [draftScope, loop, project?.id, speed, track])

  useEffect(() => {
    if (
      !project ||
      !passage ||
      (passage.start_s === project.passage.start_s &&
        passage.end_s === project.passage.end_s &&
        passage.name === project.passage.name)
    ) {
      return
    }
    const timeout = window.setTimeout(() => {
      if (savingRef.current) return
      savingRef.current = true
      setSaving(true)
      void api
        .patchWorkspace(project.id, project.revision, passage)
        .then((next) => adoptProject(next, false))
        .catch(async (workspaceError) => {
          if (workspaceError instanceof ApiError && workspaceError.status === 409) {
            const fresh = await api.getProject(project.id)
            adoptProject(fresh)
            setError('A newer edit won. Reloaded latest selected section.')
          } else {
            setError(
              workspaceError instanceof Error
                ? workspaceError.message
                : 'Could not save selected section',
            )
          }
        })
        .finally(() => {
          savingRef.current = false
          setSaving(false)
        })
    }, 650)
    return () => window.clearTimeout(timeout)
  }, [
    passage?.end_s,
    passage?.name,
    passage?.start_s,
    project?.id,
    project?.passage.end_s,
    project?.passage.name,
    project?.passage.start_s,
    project?.revision,
  ])

  const switchTrack = (role: AssetRole) => {
    const audioTime = audioRef.current?.currentTime
    if (audioTime !== undefined && Number.isFinite(audioTime)) {
      setCurrentTime(audioTime)
    }
    setTrack(role)
  }

  const changeSpeed = (nextSpeed: number) => {
    setSpeed(nextSpeed)
    if (audioRef.current) {
      audioRef.current.playbackRate = nextSpeed
      audioRef.current.preservesPitch = true
    }
  }

  const enterPlayMode = () => {
    if (!project?.tab.notes.length || saving) return
    setSelectedNoteId(null)
    setRailOpen(false)
    setViewMode('play')
  }

  const exitPlayMode = () => {
    setViewMode('edit')
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
    }
  }

  const toggleFullscreen = async () => {
    if (!document.documentElement.requestFullscreen) {
      setNotice('Fullscreen unavailable. Play mode still fills the window.')
      return
    }
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else {
        await document.documentElement.requestFullscreen()
        if (!document.fullscreenElement) {
          setNotice('Fullscreen unavailable. Play mode still fills the window.')
        }
      }
    } catch {
      setNotice('Fullscreen unavailable. Play mode still fills the window.')
    }
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
        <h1>{trashedProjects.length ? 'Project library is empty' : 'SoloTrace could not open a project'}</h1>
        <p>
          {error ||
            (trashedProjects.length
              ? 'Restore a project from Trash or import a new song.'
              : 'Restart the local service and try again.')}
        </p>
        {trashedProjects.map((candidate) => (
          <div key={candidate.id}>
            <button
              className="button secondary"
              type="button"
              onClick={() => void restoreProject(candidate)}
            >
              Restore {candidate.title}
            </button>
            {!candidate.demo && (
              <button
                className="button danger-text"
                type="button"
                onClick={() => void permanentlyDeleteProject(candidate)}
              >
                Delete permanently
              </button>
            )}
          </div>
        ))}
        <input
          ref={bundleInputRef}
          hidden
          type="file"
          accept=".zip,.solotrace.zip,application/zip"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void importProjectBundle(file)
          }}
        />
        <button
          className="button secondary"
          type="button"
          onClick={() => bundleInputRef.current?.click()}
        >
          Import SoloTrace project
        </button>
        <button className="button primary" type="button" onClick={() => void loadInitial()}>
          Reload library
        </button>
      </main>
    )
  }

  return (
    <div
      className={
        viewMode === 'play'
          ? 'play-shell'
          : `app-shell ${selectedNote || selectedChord ? 'has-inspector' : ''}`
      }
    >
      <audio ref={bindAudio} preload="metadata" />
      {viewMode === 'play' ? (
        <>
          <header className="play-header">
            <div className="mode-switch" aria-label="Workspace mode">
              <button type="button" onClick={exitPlayMode}>
                Edit
              </button>
              <button type="button" className="active" aria-pressed="true">
                <Icon name="play" />
                Play
              </button>
            </div>
            <div className="play-song-heading">
              <h1>{project.title}</h1>
              <span>{projectSubtitle(project)}</span>
            </div>
            <span className="shortcut-hint">Space play · ← → jump 5 seconds</span>
            <button
              className="button secondary fullscreen-button"
              type="button"
              aria-pressed={fullscreen}
              onClick={() => void toggleFullscreen()}
            >
              <Icon name="fullscreen" />
              {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            </button>
          </header>
          <PlayTab
            project={project}
            currentTime={currentTime}
            playing={playing}
            onSeek={seek}
          />
          <Transport
            variant="play"
            playing={playing}
            currentTime={currentTime}
            duration={project.duration_s}
            speed={speed}
            loop={loop}
            loopStart={playbackLoopStart}
            loopEnd={playbackLoopEnd}
            track={track}
            availableTracks={assets.map((asset) => asset.role)}
            onTrack={switchTrack}
            onTogglePlay={togglePlay}
            onSeek={seek}
            onSpeed={changeSpeed}
            onLoop={setLoop}
          />
        </>
      ) : (
        <>
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
        <div className="version-switcher">
          <label>
            <span>Tab version</span>
            <select
              aria-label="Tab version"
              disabled={saving}
              value={project.active_version_id}
              onChange={(event) => {
                const version = project.versions.find(
                  (candidate) => candidate.id === event.target.value,
                )
                if (version) void activateVersion(version)
              }}
            >
              {project.versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="version-manage"
            disabled={saving}
            onClick={() => setVersionOpen(true)}
          >
            Manage
          </button>
        </div>
        <div className="mode-switch edit-mode-switch" aria-label="Workspace mode">
          <button type="button" className="active" aria-pressed="true">
            Edit
          </button>
          <button
            type="button"
            disabled={
              saving ||
              (!project.tab.notes.length && !project.tab.chords.events.length)
            }
            aria-pressed="false"
            onClick={enterPlayMode}
          >
            <Icon name="play" />
            Play
          </button>
        </div>
        <div className="save-state">
          <span className={saving ? 'saving' : ''} />
          {saving ? 'Saving' : `Revision ${project.revision}`}
        </div>
        <details className="export-menu">
          <summary className="button secondary">
            <Icon name="download" />
            Export
            <Icon name="chevron" />
          </summary>
          <div>
            {[
              ['bundle', 'SoloTrace bundle', 'All versions and audio'],
              ['musicxml', 'MusicXML', 'Tab and notation'],
              ['midi', 'MIDI', 'Quantized reference'],
              ['ascii', 'Text tab', 'Portable plain text'],
              ['json', 'Project JSON', 'Lossless tab data'],
            ].map(([format, label, detail]) => (
              <a
                key={format}
                href={`/api/projects/${project.id}/export/${format}${
                  format === 'bundle'
                    ? ''
                    : `?version_id=${encodeURIComponent(project.active_version_id)}`
                }`}
                onClick={(event) => {
                  const bridge = window.pywebview?.api
                  if (!capabilities?.packaged || !bridge) return
                  event.preventDefault()
                  void bridge.saveExport(project.id, format).then((result) => {
                    if (!result.ok && !result.cancelled) {
                      setError(result.error ?? 'Could not save export')
                    }
                  })
                }}
              >
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
          <input
            ref={bundleInputRef}
            hidden
            type="file"
            accept=".zip,.solotrace.zip,application/zip"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void importProjectBundle(file)
            }}
          />
          <button
            className="button rail-choice"
            type="button"
            disabled={saving}
            onClick={() => bundleInputRef.current?.click()}
          >
            Import SoloTrace project
          </button>
          <nav aria-label="Projects">
            <p className="rail-label">Songs</p>
            {projects.map((candidate) => (
              <div className="project-list-row" key={candidate.id}>
                <button
                  type="button"
                  disabled={saving}
                  className={candidate.id === project.id ? 'active' : ''}
                  onClick={() => void chooseProject(candidate)}
                >
                  <span>{candidate.title}</span>
                  <small>
                    {candidate.active_version_name} ·{' '}
                    {candidate.demo ? 'demo' : formatTime(candidate.duration_s)}
                  </small>
                </button>
                <button
                  type="button"
                  className="project-manage-button"
                  aria-label={`Manage ${candidate.title}`}
                  disabled={saving}
                  onClick={() => {
                    void (
                      candidate.id === project.id
                        ? Promise.resolve()
                        : chooseProject(candidate)
                    ).then(() => setProjectDialogProject(candidate))
                  }}
                >
                  •••
                </button>
              </div>
            ))}
          </nav>
          {trashedProjects.length > 0 && (
            <div className="trash-shelf">
              <p className="rail-label">Trash</p>
              {trashedProjects.map((candidate) => (
                <div key={candidate.id}>
                  <span>{candidate.title}</span>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void restoreProject(candidate)}
                  >
                    Restore
                  </button>
                  {!candidate.demo && (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void permanentlyDeleteProject(candidate)}
                    >
                      Delete permanently
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="rail-group">
            <p className="rail-label">Next draft instrument</p>
            <label className="rail-field">
              Tuning
              <select
                value={
                  instrumentProfile.tuning.join(',') === '40,45,50,55,59,64'
                    ? 'standard'
                    : instrumentProfile.tuning.join(',') === '38,45,50,55,59,64'
                      ? 'drop-d'
                      : 'custom'
                }
                onChange={(event) => {
                  if (event.target.value === 'standard') {
                    setInstrumentProfile((current) => ({
                      ...current,
                      tuning: [40, 45, 50, 55, 59, 64],
                    }))
                  } else if (event.target.value === 'drop-d') {
                    setInstrumentProfile((current) => ({
                      ...current,
                      tuning: [38, 45, 50, 55, 59, 64],
                    }))
                  }
                }}
              >
                <option value="standard">Standard EADGBE</option>
                <option value="drop-d">Drop D</option>
                <option value="custom">Custom MIDI</option>
              </select>
            </label>
            <label className="rail-field">
              Uncapoed open-string MIDI
              <input
                key={instrumentProfile.tuning.join(',')}
                defaultValue={instrumentProfile.tuning.join(' ')}
                onBlur={(event) => {
                  const tuning = event.target.value.trim().split(/\s+/).map(Number)
                  if (
                    tuning.length === 6 &&
                    tuning.every(Number.isInteger) &&
                    tuning.every(
                      (pitch, index) =>
                        pitch >= 0 &&
                        pitch <= 127 &&
                        (index === 0 || pitch > tuning[index - 1]),
                    )
                  ) {
                    setInstrumentProfile((current) => ({ ...current, tuning }))
                  }
                }}
              />
            </label>
            <div className="rail-field-pair">
              <label className="rail-field">
                Capo
                <input
                  type="number"
                  min="0"
                  max="12"
                  value={instrumentProfile.capoFret}
                  onChange={(event) =>
                    setInstrumentProfile((current) => ({
                      ...current,
                      capoFret: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label className="rail-field">
                Total frets
                <input
                  type="number"
                  min="12"
                  max="36"
                  value={instrumentProfile.fretCount}
                  onChange={(event) =>
                    setInstrumentProfile((current) => ({
                      ...current,
                      fretCount: Number(event.target.value),
                    }))
                  }
                />
              </label>
            </div>
            <label className="rail-field">
              Preferred relative fret
              <input
                type="number"
                min="0"
                max={instrumentProfile.fretCount - instrumentProfile.capoFret}
                placeholder="Automatic"
                value={instrumentProfile.preferredFret ?? ''}
                onChange={(event) =>
                  setInstrumentProfile((current) => ({
                    ...current,
                    preferredFret:
                      event.target.value === '' ? null : Number(event.target.value),
                  }))
                }
              />
            </label>
            <span>
              Sounding pitch adds capo. New draft, new version; existing notes stay unchanged.
            </span>
          </div>
          <div className="rail-group">
            <p className="rail-label">Lead engine</p>
            <strong>
              {capabilities?.cloudReady
                ? 'Experimental MVSep available'
                : 'Offline preview'}
            </strong>
            <span>
              {capabilities?.cloudReady
                ? 'Cloud separation · local transcription'
                : 'MVSep or Basic Pitch unavailable'}
            </span>
            <button
              type="button"
              className="rail-choice"
              disabled={saving}
              onClick={() => setMvsepOpen(true)}
            >
              {capabilities?.cloudReady ? 'Replace API key' : 'Add API key'}
            </button>
          </div>
          <div className="rail-group">
            <p className="rail-label">Support</p>
            <button
              type="button"
              className="rail-choice"
              disabled={saving}
              onClick={() => void saveDiagnostics()}
            >
              Save redacted diagnostics
            </button>
            {capabilities?.packaged && window.pywebview?.api && (
              <button
                type="button"
                className="rail-choice"
                onClick={() => void window.pywebview?.api?.revealDataFolder()}
              >
                Reveal data folder
              </button>
            )}
          </div>
          <div className="rail-group">
            <p className="rail-label">Draft style</p>
            <button
              type="button"
              className={`rail-choice ${
                activeVersion?.fingering_mode === 'balanced' ? 'active' : ''
              }`}
              aria-pressed={activeVersion?.fingering_mode === 'balanced'}
              disabled={saving || !project.tab.notes.length}
              onClick={() => void refinger('balanced')}
            >
              Balanced
            </button>
            <button
              type="button"
              className={`rail-choice ${
                activeVersion?.fingering_mode === 'easiest' ? 'active' : ''
              }`}
              aria-pressed={activeVersion?.fingering_mode === 'easiest'}
              disabled={saving || !project.tab.notes.length}
              onClick={() => void refinger('easiest')}
            >
              Easiest
            </button>
            <button
              type="button"
              className={`rail-choice ${
                activeVersion?.fingering_mode === 'position' ? 'active' : ''
              }`}
              aria-pressed={activeVersion?.fingering_mode === 'position'}
              disabled={saving || !project.tab.notes.length}
              onClick={() => void refinger('position')}
            >
              Stay in one position
            </button>
            <span>Preserve my edits is on. Each style creates a new version.</span>
            <button
              type="button"
              className="rail-choice danger-text"
              disabled={saving || !project.tab.notes.length}
              onClick={() =>
                void refinger(activeVersion?.fingering_mode ?? 'balanced', 'clear')
              }
            >
              Start fresh
            </button>
          </div>
          <div className="rail-provenance">
            <p className="rail-label">Draft source</p>
            <strong>
              {project.separation_scope === 'exact'
                ? 'Exact demo stems'
                : project.separation_scope === 'preview'
                  ? 'Local preview'
                  : project.separation_scope === 'all-guitar'
                    ? 'Combined guitar stem'
                    : 'MVSep lead stem'}
            </strong>
            <span>
              {project.separation_scope === 'solo-guitar'
                ? 'Selected audio processed by MVSep'
                : 'Audio processed locally'}
            </span>
          </div>
        </aside>

        <main className="editor">
          <PipelineStrip
            run={project.run}
            onCancel={() => {
              setCloudConsent(false)
              void api
                .cancelProcess(project.id)
                .then((next) => adoptProject(next, false))
                .catch((cancelError) =>
                  setError(
                    cancelError instanceof Error
                      ? cancelError.message
                      : 'Could not cancel draft',
                  ),
                )
            }}
          />
          <section className="track-toolbar" aria-label="Audio source">
            <div className="track-source-tools">
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
                    aria-pressed={track === role}
                    disabled={!assets.some((asset) => asset.role === role)}
                    onClick={() => switchTrack(role)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                className="button secondary find-chords-button"
                type="button"
                disabled={processing || !capabilities?.chords?.available}
                onClick={() => void createChordDraft()}
                title={capabilities?.chords?.detail}
              >
                <Icon name="spark" />
                Find chords
              </button>
              <button
                type="button"
                className="button secondary add-note-button"
                disabled={saving}
                onClick={addNoteAtPlayhead}
              >
                Add note
              </button>
            </div>
            {!reviewMode ? (
              <button
                type="button"
                className="button primary review-launch"
                disabled={!reviewItems.length}
                onClick={startReview}
              >
                {reviewItems.length
                  ? `Review · ${reviewItems.length} remaining`
                  : 'Review complete'}
              </button>
            ) : (
              <div className="review-session-tools" role="group" aria-label="Review session">
                <button
                  type="button"
                  className="button secondary"
                  disabled={!reviewItems.length}
                  onClick={() => moveReviewSelection(-1)}
                >
                  Previous
                </button>
                <span className="review-remaining" aria-live="polite">
                  {reviewItems.length
                    ? `${reviewItems.length} remaining`
                    : 'Review complete'}
                </span>
                <button
                  type="button"
                  className="button secondary"
                  disabled={!reviewItems.length}
                  onClick={() => moveReviewSelection(1)}
                >
                  Next
                </button>
                <button
                  type="button"
                  className="button primary"
                  onClick={finishReview}
                >
                  Finish
                </button>
              </div>
            )}
          </section>

          <div className="editor-canvas">
            <Waveform
              audio={audioElement}
              audioUrl={currentAsset?.url ?? ''}
              currentTime={currentTime}
              duration={project.duration_s}
              peaks={project.waveform_peaks}
              passage={passage}
              selectionEnabled={draftScope === 'passage'}
              onPassageChange={updatePassage}
              onSeek={seek}
            />
            <div className="draft-action-row">
              <div className="draft-scope">
                <label className="section-toggle">
                  <input
                    type="checkbox"
                    checked={draftScope === 'passage'}
                    onChange={(event) =>
                      setDraftScope(event.target.checked ? 'passage' : 'whole')
                    }
                  />
                  <span>
                    <strong>Limit to a section</strong>
                    <small>Optional · full song is transcribed by default</small>
                  </span>
                </label>
                {draftScope === 'passage' && (
                  <div className="draft-range">
                    <span>
                      {formatTime(selectedStart)}–{formatTime(selectedEnd)}
                    </span>
                    <small>{selectedDuration.toFixed(1)} seconds selected</small>
                  </div>
                )}
                {selectionTooLong && (
                  <p className="range-warning" role="status">
                    MVSep supports up to {Math.floor(mvsepMaximumDuration / 60)} minutes.
                    Select a section or use Offline preview.
                  </p>
                )}
              </div>
              <div className="draft-submit">
                <div
                  className="draft-scope-switcher"
                  role="group"
                  aria-label="Separation mode"
                >
                  <button
                    type="button"
                    className={draftEngine === 'preview' ? 'active' : ''}
                    aria-pressed={draftEngine === 'preview'}
                    onClick={() => {
                      setDraftEngine('preview')
                      setCloudConsent(false)
                    }}
                  >
                    Offline preview
                  </button>
                  <button
                    type="button"
                    className={draftEngine === 'mvsep' ? 'active' : ''}
                    aria-pressed={draftEngine === 'mvsep'}
                    disabled={!cloudReady}
                    onClick={() => setDraftEngine('mvsep')}
                  >
                    Experimental MVSep
                  </button>
                </div>
                {draftEngine === 'mvsep' && (
                  <label className="cloud-consent">
                    <input
                      type="checkbox"
                      checked={cloudConsent}
                      onChange={(event) => setCloudConsent(event.target.checked)}
                    />
                    <span>I have rights to this audio. Send chosen range to MVSep.</span>
                  </label>
                )}
                <button
                  className="button primary"
                  type="button"
                  disabled={
                    processing ||
                    selectionTooLong ||
                    (draftEngine === 'mvsep' && (!cloudReady || !cloudConsent))
                  }
                  onClick={() => void createDraft()}
                >
                  <Icon name="spark" />
                  {draftScope === 'whole'
                    ? project.tab.notes.length
                      ? 'Transcribe full song again'
                      : 'Transcribe full song'
                    : project.tab.notes.length
                      ? 'Transcribe selected section again'
                      : 'Transcribe selected section'}
                </button>
              </div>
            </div>
            <TabEditor
              project={project}
              currentTime={currentTime}
              selectedNoteId={selectedNoteId}
              selectedChordId={selectedChordId}
              onSelectNote={(noteId) => {
                setSelectedChordId(null)
                setSelectedNoteId(noteId)
              }}
              onSelectChord={(chord) => {
                setSelectedNoteId(null)
                setSelectedChordId(chord.id)
                seek(chord.audio_onset_s)
              }}
              onSeek={seek}
              onFingeringChange={changeFingering}
              onChordBoundaryMove={moveBoundary}
              onAddChord={addChordAtPlayhead}
              disabled={saving}
            />
          </div>
        </main>

        {selectedNote && (
          <NoteInspector
            note={selectedNote}
            saving={saving}
            rangeStart={project.passage.start_s}
            rangeEnd={project.passage.end_s}
            onClose={() => setSelectedNoteId(null)}
            onSave={saveSelectedNote}
            onAccept={acceptNote}
            onDelete={deleteNote}
            onReopen={reopenNote}
            onAudition={(note) => {
              seek(Math.max(0, note.audio_onset_s - 0.35))
              void audioRef.current?.play()
            }}
          />
        )}
        {selectedChord && (
          <ChordInspector
            chord={selectedChord}
            index={selectedChordIndex}
            chordCount={project.tab.chords.events.length}
            saving={saving}
            onClose={() => setSelectedChordId(null)}
            onSave={saveSelectedChord}
            onAccept={() => reviewSelectedChord(true)}
            onReopen={() => reviewSelectedChord(false)}
            onAudition={() => {
              seek(Math.max(0, selectedChord.audio_onset_s - 0.35))
              void audioRef.current?.play()
            }}
            onSplit={splitSelectedChord}
            onMerge={mergeSelectedChord}
            onDelete={deleteSelectedChord}
          />
        )}
      </div>

      <Transport
        playing={playing}
        currentTime={currentTime}
        duration={project.duration_s}
        speed={speed}
        loop={loop}
        loopStart={playbackLoopStart}
        loopEnd={playbackLoopEnd}
        onTogglePlay={togglePlay}
        onSeek={seek}
        onSpeed={changeSpeed}
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
          setDraftScope('whole')
          setCloudConsent(false)
          return next
        }}
      />
        </>
      )}

      <MVSepDialog
        open={mvsepOpen}
        configured={capabilities?.cloud.configured ?? false}
        onClose={() => setMvsepOpen(false)}
        onSave={async (token) => {
          await api.saveMvsepToken(token)
          const nextCapabilities = await api.capabilities()
          setCapabilities(nextCapabilities)
          setCloudConsent(false)
          setNotice('MVSep API key saved to Keychain')
        }}
        onRemove={async () => {
          await api.removeMvsepToken()
          const nextCapabilities = await api.capabilities()
          setCapabilities(nextCapabilities)
          setDraftEngine('preview')
          setCloudConsent(false)
          setNotice('MVSep API key removed from Keychain')
        }}
      />

      <VersionDialog
        open={versionOpen}
        project={project}
        saving={saving}
        onClose={() => setVersionOpen(false)}
        onActivate={activateVersion}
        onDuplicate={duplicateVersion}
        onRename={renameVersion}
        onDelete={deleteVersion}
      />

      <ProjectDialog
        project={projectDialogProject ? summaryFromProject(project) : null}
        saving={saving}
        onClose={() => setProjectDialogProject(null)}
        onRename={renameCurrentProject}
        onTrash={trashCurrentProject}
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
