import type {
  FingeringMode,
  MediaAsset,
  Passage,
  TabDocument,
  VersionFingeringStyle,
} from '@solotrace/editor'

export type {
  AssetRole,
  BeatMap,
  ChordEvent,
  ChordTrack,
  Confidence,
  Fingering,
  FingeringConstraints,
  FingeringMode,
  MediaAsset,
  NoteEvent,
  Passage,
  SyncAnchor,
  TabDocument,
} from '@solotrace/editor'

export type RunState = 'idle' | 'queued' | 'running' | 'complete' | 'failed' | 'cancelled'
export type StageState = 'pending' | 'running' | 'complete' | 'failed' | 'skipped'

interface NativeBridgeResult {
  ok: boolean
  cancelled?: boolean
  error?: string
}

declare global {
  interface Window {
    pywebview?: {
      api?: {
        saveExport: (
          projectId: string,
          formatName: string,
        ) => Promise<NativeBridgeResult>
        saveDiagnostics: () => Promise<NativeBridgeResult>
        revealDataFolder: () => Promise<NativeBridgeResult>
        openExternal: (url: string) => Promise<NativeBridgeResult>
      }
    }
  }
}
export type DraftEngine = 'mvsep' | 'preview'
export type DraftScope = 'whole' | 'passage'

export interface TabVersionSummary {
  id: string
  name: string
  source: string
  fingering_mode: VersionFingeringStyle
  created_at: string
  updated_at: string
  note_count: number
  needs_review_count: number
  chord_count: number
  chord_needs_review_count: number
}

export interface ProjectSummary {
  id: string
  title: string
  artist: string
  updated_at: string
  revision: number
  duration_s: number
  source_name: string
  youtube_url: string | null
  demo: boolean
  trashed_at: string | null
  active_version_id: string
  active_version_name: string
  note_count: number
  needs_review_count: number
  chord_count: number
  chord_needs_review_count: number
}

export interface PipelineStage {
  id: string
  label: string
  status: StageState
  detail: string
}

export interface ProcessingRun {
  id: string
  state: RunState
  stages: PipelineStage[]
  message: string
  error: string | null
  created_at: string
  updated_at: string
}

export interface Project {
  id: string
  title: string
  artist: string
  created_at: string
  updated_at: string
  revision: number
  duration_s: number
  passage: Passage
  assets: MediaAsset[]
  tab: TabDocument
  versions: TabVersionSummary[]
  active_version_id: string
  run: ProcessingRun
  source_name: string
  youtube_url: string | null
  demo: boolean
  trashed_at: string | null
  separation_scope: 'solo-guitar' | 'all-guitar' | 'preview' | 'exact'
  waveform_peaks: number[]
  provenance: string[]
}

export interface Capabilities {
  appVersion: string
  buildId: string
  packaged: boolean
  audio: {
    ffmpeg: boolean
    maxUploadMb: number
  }
  imports: {
    youtube: {
      available: boolean
      cookieBrowsers: Array<'chrome' | 'safari'>
      maxDurationS: number
      disabledReason: string
    }
  }
  separation: {
    selected: string
    available: {
      preview: boolean
      mvsep: boolean
    }
    notice: string
    mvsepMaxDurationS: number
    consentRequired: boolean
  }
  transcription: {
    selected: string
    available: {
      pyin: boolean
      basicPitch: boolean
    }
  }
  chords: {
    available: boolean
    engine: string
    modelRevision: string
    modelSha256: string
    detail: string
    desktopOnly: boolean
  }
  cloudReady: boolean
  cloud: {
    configured: boolean
    ready: boolean
  }
  privacy: string
}
