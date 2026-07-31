import { assignFingerings, type FingeringConstraints } from './fingering'
import { availableFretCount, soundingTuning } from './instrument'
import type { FingeringMode, NoteEvent, TabDocument } from './types'

export type PhrasePlanErrorCode =
  | 'invalid-range'
  | 'invalid-constraints'
  | 'empty-range'
  | 'impossible-constraints'

export class PhrasePlanError extends Error {
  readonly code: PhrasePlanErrorCode

  constructor(code: PhrasePlanErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PhrasePlanError'
    this.code = code
  }
}

export interface PhraseScoreRange {
  startScoreTick: number
  endScoreTick: number
}

export interface PhraseFingeringRequest {
  range: PhraseScoreRange
  mode: FingeringMode
  constraints?: FingeringConstraints
}

export interface PhraseFingeringChange {
  noteId: string
  scoreTick: number
  midiPitch: number
  before: { string: number; fret: number }
  after: { string: number; fret: number }
}

export interface PhraseFingeringPlan {
  range: PhraseScoreRange
  mode: FingeringMode
  constraints: FingeringConstraints
  notes: NoteEvent[]
  changes: PhraseFingeringChange[]
  selectedNoteCount: number
  lockedNoteCount: number
}

function barTicks(tab: TabDocument): number {
  const [beats, beatUnit] = tab.time_signature
  const ticks = (tab.ticks_per_quarter * 4 * beats) / beatUnit
  if (!Number.isInteger(ticks) || ticks <= 0) {
    throw new PhrasePlanError(
      'invalid-range',
      'Time signature does not divide into whole score ticks.',
    )
  }
  return ticks
}

function normalizedConstraints(
  tab: TabDocument,
  constraints: FingeringConstraints | undefined,
): FingeringConstraints {
  const allowedStrings = constraints?.allowedStrings
    ? [...new Set(constraints.allowedStrings)].sort((left, right) => left - right)
    : undefined
  const minFret = constraints?.minFret ?? null
  const maxFret = constraints?.maxFret ?? null
  if (
    allowedStrings?.some(
      (string) => !Number.isInteger(string) || string < 1 || string > tab.tuning.length,
    ) ||
    (allowedStrings && allowedStrings.length === 0) ||
    (minFret != null && (!Number.isInteger(minFret) || minFret < 0)) ||
    (maxFret != null && (!Number.isInteger(maxFret) || maxFret > availableFretCount(tab))) ||
    (minFret != null && maxFret != null && minFret > maxFret)
  ) {
    throw new PhrasePlanError(
      'invalid-constraints',
      'Choose at least one valid string and a fret range available on this instrument.',
    )
  }
  return { allowedStrings, minFret, maxFret }
}

function expandToBars(tab: TabDocument, requested: PhraseScoreRange): PhraseScoreRange {
  if (
    !Number.isFinite(requested.startScoreTick) ||
    !Number.isFinite(requested.endScoreTick) ||
    requested.startScoreTick < 0 ||
    requested.endScoreTick <= requested.startScoreTick
  ) {
    throw new PhrasePlanError(
      'invalid-range',
      'Phrase range must have a non-negative start before its end.',
    )
  }
  const ticksPerBar = barTicks(tab)
  const offset = (tab as TabDocument & { bar_offset_ticks?: number }).bar_offset_ticks ?? 0
  const startScoreTick = Math.max(
    0,
    Math.floor((requested.startScoreTick - offset) / ticksPerBar) * ticksPerBar + offset,
  )
  const endScoreTick =
    Math.ceil((requested.endScoreTick - offset) / ticksPerBar) * ticksPerBar + offset
  return { startScoreTick, endScoreTick }
}

function groupIndices(notes: readonly NoteEvent[], start: number, step: -1 | 1): number[] {
  const neighbor = notes[start]
  if (!neighbor) return []
  const indices = [start]
  for (let index = start + step; notes[index]?.onset_frame === neighbor.onset_frame; index += step) {
    indices.push(index)
  }
  return indices
}

/**
 * Plan a bar-aligned partial refingering. Input tab stays untouched.
 * Neighboring onset groups are locked context, so hand movement and connected
 * techniques remain smooth across both phrase boundaries.
 */
export function planPhraseFingering(
  tab: TabDocument,
  request: PhraseFingeringRequest,
): PhraseFingeringPlan {
  const range = expandToBars(tab, request.range)
  const constraints = normalizedConstraints(tab, request.constraints)
  const chronological = tab.notes
    .map((note, originalIndex) => ({ note, originalIndex }))
    .sort(
      (left, right) =>
        left.note.onset_frame - right.note.onset_frame ||
        left.originalIndex - right.originalIndex,
    )
  const selected = chronological
    .map(({ note }, index) => ({ note, index }))
    .filter(
      ({ note }) =>
        note.score_tick >= range.startScoreTick && note.score_tick < range.endScoreTick,
    )
  if (selected.length === 0) {
    throw new PhrasePlanError(
      'empty-range',
      'Selected bars contain no notes. Choose bars containing tablature.',
    )
  }

  const selectedIndices = new Set(selected.map(({ index }) => index))
  const firstIndex = selected[0].index
  const lastIndex = selected.at(-1)!.index
  const contextIndices = new Set([
    ...groupIndices(chronological.map(({ note }) => note), firstIndex - 1, -1),
    ...groupIndices(chronological.map(({ note }) => note), lastIndex + 1, 1),
  ])
  const workingIndices = [...new Set([...selectedIndices, ...contextIndices])].sort(
    (left, right) => left - right,
  )
  const workingNotes = workingIndices.map((index) => {
    const note = chronological[index].note
    return contextIndices.has(index) ? { ...note, user_locked: true } : note
  })

  let plannedWorking: NoteEvent[]
  try {
    plannedWorking = assignFingerings(
      workingNotes,
      soundingTuning(tab),
      availableFretCount(tab),
      request.mode,
      tab.preferred_fret,
      constraints,
    )
  } catch (error) {
    throw new PhrasePlanError(
      'impossible-constraints',
      error instanceof Error
        ? `No playable fingering fits these phrase controls. ${error.message}`
        : 'No playable fingering fits these phrase controls.',
      { cause: error },
    )
  }

  const notes = tab.notes.map((note) => ({ ...note }))
  workingIndices.forEach((chronologicalIndex, workingIndex) => {
    if (!selectedIndices.has(chronologicalIndex)) return
    const originalIndex = chronological[chronologicalIndex].originalIndex
    const before = tab.notes[originalIndex]
    const planned = plannedWorking[workingIndex]
    const changed = before.string !== planned.string || before.fret !== planned.fret
    notes[originalIndex] = changed
      ? { ...planned, reviewed: false, user_locked: false }
      : { ...planned, reviewed: before.reviewed, user_locked: before.user_locked }
  })
  const changes = tab.notes.flatMap((before, index): PhraseFingeringChange[] => {
    const after = notes[index]
    if (before.string === after.string && before.fret === after.fret) return []
    return [{
      noteId: before.id,
      scoreTick: before.score_tick,
      midiPitch: before.midi_pitch,
      before: { string: before.string, fret: before.fret },
      after: { string: after.string, fret: after.fret },
    }]
  })
  return {
    range,
    mode: request.mode,
    constraints,
    notes,
    changes,
    selectedNoteCount: selected.length,
    lockedNoteCount: selected.filter(({ note }) => note.user_locked).length,
  }
}
