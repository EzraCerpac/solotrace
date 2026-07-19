export type AssetRole = 'original' | 'lead' | 'backing'
export type RunState = 'idle' | 'queued' | 'running' | 'complete' | 'failed'
export type StageState = 'pending' | 'running' | 'complete' | 'failed' | 'skipped'
export type FingeringMode = 'balanced' | 'easiest' | 'position'
export type DraftEngine = 'enhanced' | 'preview'

export interface Confidence {
  pitch: number
  onset: number
  fingering: number
  technique: number
}

export interface Fingering {
  string: number
  fret: number
  label: string
  cost: number
}

export interface NoteEvent {
  id: string
  onset_frame: number
  end_frame: number
  audio_onset_s: number
  audio_offset_s: number
  score_tick: number
  duration_ticks: number
  midi_pitch: number
  pitch_curve_cents: number[]
  string: number
  fret: number
  techniques: string[]
  confidence: Confidence
  alternatives: Fingering[]
  user_locked: boolean
}

export interface SyncAnchor {
  audio_frame: number
  score_tick: number
}

export interface TabDocument {
  revision: number
  sample_rate: number
  ticks_per_quarter: number
  tempo_bpm: number
  time_signature: [number, number]
  tuning: number[]
  fret_count: number
  sync_anchors: SyncAnchor[]
  notes: NoteEvent[]
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

export interface MediaAsset {
  role: AssetRole
  url: string
  filename: string
  duration_s: number
  sample_rate: number
  method: string
}

export interface Passage {
  name: string
  start_s: number
  end_s: number
}

export interface Project {
  id: string
  title: string
  artist: string
  created_at: string
  updated_at: string
  duration_s: number
  passage: Passage
  assets: MediaAsset[]
  tab: TabDocument
  run: ProcessingRun
  source_name: string
  demo: boolean
  separation_scope: 'solo-guitar' | 'all-guitar' | 'preview' | 'exact'
  waveform_peaks: number[]
  provenance: string[]
}

export interface Capabilities {
  audio: {
    ffmpeg: boolean
    maxUploadMb: number
  }
  separation: {
    selected: string
    available: {
      preview: boolean
      demucsMlx: boolean
    }
    notice: string
  }
  transcription: {
    selected: string
    available: {
      pyin: boolean
      basicPitch: boolean
    }
  }
  enhancedReady: boolean
  privacy: string
}
