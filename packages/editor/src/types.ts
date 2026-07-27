export type AssetRole = 'original' | 'lead' | 'backing'
export type ExportFormat = 'json' | 'musicxml' | 'midi' | 'ascii'
export type FingeringMode = 'balanced' | 'easiest' | 'position'
export type ProjectOrigin = 'local' | 'example' | 'saved-example'
export type ChordKind = 'chord' | 'no-chord' | 'unknown'
export type ChordQuality =
  | 'min'
  | 'maj'
  | 'dim'
  | 'aug'
  | 'min6'
  | 'maj6'
  | 'min7'
  | 'minmaj7'
  | 'maj7'
  | '7'
  | 'dim7'
  | 'hdim7'
  | 'sus2'
  | 'sus4'
export type ChordProvenance = 'detected' | 'manual' | 'example'

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
  reviewed: boolean
}

export interface SyncAnchor {
  audio_frame: number
  score_tick: number
}

export interface SpelledPitch {
  step: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'
  alter: number
}

export interface ChordAlternative {
  kind: ChordKind
  root: SpelledPitch | null
  quality: ChordQuality | null
  model_score: number
}

export interface ChordEvent {
  id: string
  onset_frame: number
  end_frame: number
  audio_onset_s: number
  audio_offset_s: number
  score_tick: number
  duration_ticks: number
  kind: ChordKind
  root: SpelledPitch | null
  quality: ChordQuality | null
  bass: SpelledPitch | null
  model_score: number | null
  alternatives: ChordAlternative[]
  provenance: ChordProvenance
  edited: boolean
  reviewed: boolean
}

export interface ChordTrack {
  engine: string
  model_revision: string | null
  model_sha256: string | null
  analyzed_start_s: number | null
  analyzed_end_s: number | null
  events: ChordEvent[]
}

export interface TabDocument {
  sample_rate: number
  ticks_per_quarter: number
  tempo_bpm: number
  time_signature: [number, number]
  tuning: number[]
  fret_count: number
  sync_anchors: SyncAnchor[]
  notes: NoteEvent[]
  chords: ChordTrack
}

export interface TabVersion {
  id: string
  name: string
  source: string
  fingering_mode: FingeringMode
  created_at: string
  updated_at: string
  tab: TabDocument
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

/** Self-contained project document used by browser-local and D1 adapters. */
export interface EditorProject {
  id: string
  title: string
  artist: string
  created_at: string
  updated_at: string
  revision: number
  duration_s: number
  passage: Passage
  assets: MediaAsset[]
  versions: TabVersion[]
  active_version_id: string
  source_name: string
  origin: ProjectOrigin
  example_slug?: string
  waveform_peaks: number[]
  provenance: string[]
  separation_scope?: 'solo-guitar' | 'all-guitar' | 'preview' | 'exact'
}

export interface ExampleCatalogAssetUrls {
  original: string
  lead: string
  backing: string
}

export interface ExampleCatalogEntry {
  slug: string
  title: string
  summary: string
  tempoBpm: number
  timeSignature: [number, number]
  tuning: number[]
  tuningLabel: string
  durationS: number
  techniques: string[]
  versionNames: string[]
  projectUrl: string
  peaksUrl: string
  audio: ExampleCatalogAssetUrls
  license: 'CC0-1.0'
  provenance: string[]
}

export interface HostedCapabilityFlags {
  anonymousEditing: boolean
  localDrafts: boolean
  saveCopies: boolean
  uploads: boolean
  processing: boolean
  chordRecognition: boolean
  projectBundles: boolean
  maxSavedCopies: number
  maxDocumentBytes: number
}

export const HOSTED_EXAMPLE_CAPABILITIES = Object.freeze({
  anonymousEditing: true,
  localDrafts: true,
  saveCopies: true,
  uploads: false,
  processing: false,
  chordRecognition: false,
  projectBundles: false,
  maxSavedCopies: 3,
  maxDocumentBytes: 256 * 1024,
}) satisfies Readonly<HostedCapabilityFlags>

export type ProjectReference =
  | { origin: 'example'; slug: string }
  | { origin: 'saved-example'; id: string }
  | { origin: 'local'; id: string }

export interface SaveProjectRequest {
  project: EditorProject
  expectedRevision?: number
  asCopy?: boolean
}

export interface RefingerProjectRequest {
  projectId: string
  expectedRevision: number
  sourceVersionId: string
  mode: FingeringMode
  name?: string
}

export type VersionAction =
  | { type: 'activate'; versionId: string }
  | { type: 'rename'; versionId: string; name: string }
  | { type: 'delete'; versionId: string }
  | { type: 'replace-notes'; versionId: string; notes: NoteEvent[] }
  | { type: 'replace-chords'; versionId: string; track: ChordTrack }

export interface VersionActionRequest {
  projectId: string
  expectedRevision: number
  action: VersionAction
}

export interface ExportRequest {
  project: EditorProject
  format: ExportFormat
}

export interface ExportArtifact {
  format: ExportFormat
  filename: string
  mimeType: string
  bytes: Uint8Array
}

/** Adapter seam shared by desktop and hosted shells. */
export interface EditorClientAdapter {
  readonly capabilities: Readonly<HostedCapabilityFlags>
  loadProject(reference: ProjectReference): Promise<EditorProject>
  saveProject(request: SaveProjectRequest): Promise<EditorProject>
  refingerProject(request: RefingerProjectRequest): Promise<EditorProject>
  applyVersionAction(request: VersionActionRequest): Promise<EditorProject>
  exportProject(request: ExportRequest): Promise<ExportArtifact>
}
