import type {
  EditorProject,
  Fingering,
  FingeringMode,
  NoteEvent,
  TabVersion,
} from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isFingering(value: unknown, stringCount: number, fretCount: number): value is Fingering {
  return (
    isRecord(value) &&
    isInteger(value.string) &&
    value.string >= 1 &&
    value.string <= stringCount &&
    isInteger(value.fret) &&
    value.fret >= 0 &&
    value.fret <= fretCount &&
    typeof value.label === 'string' &&
    isFiniteNumber(value.cost)
  )
}

function isNote(
  value: unknown,
  tuning: readonly number[],
  fretCount: number,
): value is NoteEvent {
  if (!isRecord(value)) return false
  const confidence = value.confidence
  const openPitch =
    isInteger(value.string) && value.string >= 1 && value.string <= tuning.length
      ? tuning[tuning.length - value.string]
      : undefined
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    isInteger(value.onset_frame) &&
    value.onset_frame >= 0 &&
    isInteger(value.end_frame) &&
    value.end_frame > value.onset_frame &&
    isFiniteNumber(value.audio_onset_s) &&
    value.audio_onset_s >= 0 &&
    isFiniteNumber(value.audio_offset_s) &&
    value.audio_offset_s > value.audio_onset_s &&
    isInteger(value.score_tick) &&
    value.score_tick >= 0 &&
    isInteger(value.duration_ticks) &&
    value.duration_ticks > 0 &&
    isInteger(value.midi_pitch) &&
    value.midi_pitch >= 0 &&
    value.midi_pitch <= 127 &&
    Array.isArray(value.pitch_curve_cents) &&
    value.pitch_curve_cents.every(isFiniteNumber) &&
    isInteger(value.string) &&
    value.string >= 1 &&
    value.string <= tuning.length &&
    isInteger(value.fret) &&
    value.fret >= 0 &&
    value.fret <= fretCount &&
    openPitch !== undefined &&
    openPitch + value.fret === value.midi_pitch &&
    isStringArray(value.techniques) &&
    isRecord(confidence) &&
    [confidence.pitch, confidence.onset, confidence.fingering, confidence.technique].every(
      (score) => isFiniteNumber(score) && score >= 0 && score <= 1,
    ) &&
    Array.isArray(value.alternatives) &&
    value.alternatives.every((candidate) =>
      isFingering(candidate, tuning.length, fretCount) &&
      tuning[tuning.length - candidate.string] + candidate.fret === value.midi_pitch,
    ) &&
    typeof value.user_locked === 'boolean' &&
    typeof value.reviewed === 'boolean'
  )
}

function isVersion(value: unknown): value is TabVersion {
  if (!isRecord(value) || !isRecord(value.tab)) return false
  const tab = value.tab
  const timeSignature = tab.time_signature
  const tuning = tab.tuning
  const capoFret = tab.capo_fret
  const fretCount = tab.fret_count
  const preferredFret = tab.preferred_fret
  const soundingTuning =
    Array.isArray(tuning) && isInteger(capoFret)
      ? tuning.map((pitch) => Number(pitch) + capoFret)
      : []
  const availableFretCount =
    isInteger(fretCount) && isInteger(capoFret) ? fretCount - capoFret : -1
  const modes = new Set<FingeringMode>(['balanced', 'easiest', 'position'])
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    typeof value.source !== 'string' ||
    !modes.has(value.fingering_mode as FingeringMode) ||
    typeof value.created_at !== 'string' ||
    typeof value.updated_at !== 'string' ||
    !isInteger(tab.sample_rate) ||
    tab.sample_rate <= 0 ||
    !isInteger(tab.ticks_per_quarter) ||
    tab.ticks_per_quarter <= 0 ||
    !isFiniteNumber(tab.tempo_bpm) ||
    tab.tempo_bpm <= 0 ||
    !Array.isArray(timeSignature) ||
    timeSignature.length !== 2 ||
    !timeSignature.every((item) => isInteger(item) && item > 0) ||
    !Array.isArray(tuning) ||
    tuning.length < 4 ||
    tuning.length > 8 ||
    !tuning.every((pitch) => isInteger(pitch) && pitch >= 0 && pitch <= 127) ||
    !isInteger(capoFret) ||
    capoFret < 0 ||
    capoFret > 12 ||
    !isInteger(fretCount) ||
    fretCount < 12 ||
    availableFretCount < 1 ||
    !(
      preferredFret === null ||
      (isInteger(preferredFret) && preferredFret >= 0 && preferredFret <= availableFretCount)
    ) ||
    !Array.isArray(tab.sync_anchors) ||
    !tab.sync_anchors.every(
      (anchor) =>
        isRecord(anchor) &&
        isInteger(anchor.audio_frame) &&
        anchor.audio_frame >= 0 &&
        isInteger(anchor.score_tick) &&
        anchor.score_tick >= 0,
    ) ||
    !Array.isArray(tab.notes) ||
    tab.notes.length === 0 ||
    !tab.notes.every((note) => isNote(note, soundingTuning, availableFretCount))
  ) {
    return false
  }
  return new Set(tab.notes.map((note) => note.id)).size === tab.notes.length
}

/** Runtime guard for untrusted static, browser-storage, and D1 documents. */
export function isEditorProject(value: unknown): value is EditorProject {
  if (!isRecord(value)) return false
  if (Array.isArray(value.versions)) {
    value.versions.forEach((version) => {
      if (!isRecord(version) || !isRecord(version.tab)) return
      if (version.tab.capo_fret === undefined) version.tab.capo_fret = 0
      if (version.tab.preferred_fret === undefined) version.tab.preferred_fret = null
    })
  }
  const versions = value.versions
  const passage = value.passage
  const origins = new Set(['local', 'example', 'saved-example'])
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.title === 'string' &&
    typeof value.artist === 'string' &&
    typeof value.created_at === 'string' &&
    typeof value.updated_at === 'string' &&
    isInteger(value.revision) &&
    value.revision >= 1 &&
    isFiniteNumber(value.duration_s) &&
    value.duration_s > 0 &&
    isRecord(passage) &&
    typeof passage.name === 'string' &&
    isFiniteNumber(passage.start_s) &&
    passage.start_s >= 0 &&
    isFiniteNumber(passage.end_s) &&
    passage.end_s > passage.start_s &&
    Array.isArray(value.assets) &&
    value.assets.every(
      (asset) =>
        isRecord(asset) &&
        ['original', 'lead', 'backing'].includes(String(asset.role)) &&
        typeof asset.url === 'string' &&
        typeof asset.filename === 'string' &&
        isFiniteNumber(asset.duration_s) &&
        asset.duration_s > 0 &&
        isInteger(asset.sample_rate) &&
        asset.sample_rate > 0 &&
        typeof asset.method === 'string',
    ) &&
    Array.isArray(versions) &&
    versions.length > 0 &&
    versions.every(isVersion) &&
    new Set(versions.map((version) => version.id)).size === versions.length &&
    typeof value.active_version_id === 'string' &&
    versions.some((version) => version.id === value.active_version_id) &&
    typeof value.source_name === 'string' &&
    origins.has(String(value.origin)) &&
    (value.example_slug === undefined || typeof value.example_slug === 'string') &&
    Array.isArray(value.waveform_peaks) &&
    value.waveform_peaks.every(isFiniteNumber) &&
    isStringArray(value.provenance)
  )
}
