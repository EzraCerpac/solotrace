import type { ChordEvent, NoteEvent, SyncAnchor, TabDocument } from './types'

export interface BeatMap {
  tempo_bpm: number
  time_signature: [number, number]
  bar_offset_ticks: number
  sync_anchors: SyncAnchor[]
}

export type BeatMapValidationCode =
  | 'anchor-count'
  | 'anchor-order'
  | 'boundary'
  | 'meter'
  | 'offset'
  | 'tempo'
  | 'segment-tempo'

export class BeatMapValidationError extends Error {
  readonly code: BeatMapValidationCode
  readonly anchorIndex?: number

  constructor(code: BeatMapValidationCode, message: string, anchorIndex?: number) {
    super(message)
    this.name = 'BeatMapValidationError'
    this.code = code
    this.anchorIndex = anchorIndex
  }
}

export interface TempoEvent {
  scoreTick: number
  bpm: number
}

export interface BeatMapCoverage {
  startFrame: number
  endFrame: number
}

type TabWithBeatMap = TabDocument & { bar_offset_ticks?: number }

export function ticksPerMeasure(
  ticksPerQuarter: number,
  timeSignature: readonly [number, number],
): number {
  const [beats, beatType] = timeSignature
  if (
    !Number.isInteger(beats) ||
    beats <= 0 ||
    beats > 32 ||
    !Number.isInteger(beatType) ||
    ![2, 4, 8, 16].includes(beatType)
  ) {
    throw new BeatMapValidationError(
      'meter',
      'Time signature needs 1–32 beats and a beat unit of 2, 4, 8, or 16.',
    )
  }
  const ticks = (beats * ticksPerQuarter * 4) / beatType
  if (!Number.isInteger(ticks)) {
    throw new BeatMapValidationError(
      'meter',
      'Time signature cannot use whole score ticks at this resolution.',
    )
  }
  return ticks
}

export function beatMapFromTab(tab: TabDocument): BeatMap {
  return {
    tempo_bpm: tab.tempo_bpm,
    time_signature: [...tab.time_signature] as [number, number],
    bar_offset_ticks: (tab as TabWithBeatMap).bar_offset_ticks ?? 0,
    sync_anchors: tab.sync_anchors.map((anchor) => ({ ...anchor })),
  }
}

function inferredCoverage(tab: TabDocument): BeatMapCoverage | undefined {
  const events = [...tab.notes, ...tab.chords.events]
  if (!events.length) return undefined
  return {
    startFrame: Math.min(...events.map((event) => event.onset_frame)),
    endFrame: Math.max(...events.map((event) => event.end_frame)),
  }
}

export function validateBeatMap(
  tab: TabDocument,
  beatMap: BeatMap,
  coverage: BeatMapCoverage | undefined = inferredCoverage(tab),
): BeatMap {
  if (!Number.isFinite(beatMap.tempo_bpm) || beatMap.tempo_bpm <= 20 || beatMap.tempo_bpm > 400) {
    throw new BeatMapValidationError('tempo', 'Tempo must be greater than 20 and at most 400 BPM.')
  }
  const measureTicks = ticksPerMeasure(tab.ticks_per_quarter, beatMap.time_signature)
  if (
    !Number.isInteger(beatMap.bar_offset_ticks) ||
    beatMap.bar_offset_ticks < 0 ||
    beatMap.bar_offset_ticks >= measureTicks
  ) {
    throw new BeatMapValidationError(
      'offset',
      `Pickup must be between 0 and ${measureTicks - 1} ticks.`,
    )
  }
  if (beatMap.sync_anchors.length < 2 || beatMap.sync_anchors.length > 5000) {
    throw new BeatMapValidationError('anchor-count', 'Beat Map needs 2–5000 sync pins.')
  }
  beatMap.sync_anchors.forEach((anchor, index) => {
    if (
      !Number.isSafeInteger(anchor.audio_frame) ||
      anchor.audio_frame < 0 ||
      !Number.isSafeInteger(anchor.score_tick) ||
      anchor.score_tick < 0
    ) {
      throw new BeatMapValidationError(
        'anchor-order',
        'Sync pins need non-negative whole frames and score ticks.',
        index,
      )
    }
    if (index === 0) return
    const previous = beatMap.sync_anchors[index - 1]
    if (
      anchor.audio_frame <= previous.audio_frame ||
      anchor.score_tick <= previous.score_tick
    ) {
      throw new BeatMapValidationError(
        'anchor-order',
        'Sync pins must move forward in both audio and score time.',
        index,
      )
    }
    const frameSpan = anchor.audio_frame - previous.audio_frame
    const tickSpan = anchor.score_tick - previous.score_tick
    const bpm = (tickSpan * tab.sample_rate * 60) / (frameSpan * tab.ticks_per_quarter)
    if (!Number.isFinite(bpm) || bpm <= 20 || bpm > 400) {
      throw new BeatMapValidationError(
        'segment-tempo',
        `Pins ${index} and ${index + 1} imply ${bpm.toFixed(1)} BPM; use 20–400 BPM.`,
        index,
      )
    }
  })
  if (
    coverage &&
    (beatMap.sync_anchors[0].audio_frame > coverage.startFrame ||
      beatMap.sync_anchors.at(-1)!.audio_frame < coverage.endFrame)
  ) {
    throw new BeatMapValidationError(
      'boundary',
      'Locked first and last sync pins must cover the transcription passage.',
    )
  }

  return {
    tempo_bpm: beatMap.tempo_bpm,
    time_signature: [...beatMap.time_signature] as [number, number],
    bar_offset_ticks: beatMap.bar_offset_ticks,
    sync_anchors: beatMap.sync_anchors.map((anchor) => ({ ...anchor })),
  }
}

/** Piecewise-linear map. Extrapolation uses nearest segment for boundary events. */
export function scoreTickForAudioFrame(audioFrame: number, anchors: readonly SyncAnchor[]): number {
  if (anchors.length < 2) throw new BeatMapValidationError('anchor-count', 'Beat Map needs at least 2 sync pins.')
  let left = anchors[0]
  let right = anchors[1]
  if (audioFrame >= anchors.at(-1)!.audio_frame) {
    left = anchors.at(-2)!
    right = anchors.at(-1)!
  } else {
    for (let index = 1; index < anchors.length; index += 1) {
      if (audioFrame <= anchors[index].audio_frame) {
        left = anchors[index - 1]
        right = anchors[index]
        break
      }
    }
  }
  const progress = (audioFrame - left.audio_frame) / (right.audio_frame - left.audio_frame)
  return Math.max(0, Math.round(left.score_tick + progress * (right.score_tick - left.score_tick)))
}

function remapEvent<T extends NoteEvent | ChordEvent>(event: T, anchors: SyncAnchor[]): T {
  const scoreTick = scoreTickForAudioFrame(event.onset_frame, anchors)
  const endTick = scoreTickForAudioFrame(event.end_frame, anchors)
  return {
    ...event,
    score_tick: scoreTick,
    duration_ticks: Math.max(1, endTick - scoreTick),
  }
}

/**
 * Replace timing as one immutable operation. Audio frame/second fields are copied unchanged;
 * score fields are regenerated from the staged anchors.
 */
export function applyBeatMap(
  tab: TabDocument,
  candidate: BeatMap,
  coverage?: BeatMapCoverage,
): TabDocument & { bar_offset_ticks: number } {
  const beatMap = validateBeatMap(tab, candidate, coverage ?? inferredCoverage(tab))
  return {
    ...tab,
    tempo_bpm: beatMap.tempo_bpm,
    time_signature: beatMap.time_signature,
    bar_offset_ticks: beatMap.bar_offset_ticks,
    sync_anchors: beatMap.sync_anchors,
    notes: tab.notes.map((note) => remapEvent(note, beatMap.sync_anchors)),
    chords: {
      ...tab.chords,
      events: tab.chords.events.map((chord) => remapEvent(chord, beatMap.sync_anchors)),
    },
  }
}

/** Tempo changes implied by adjacent pins, suitable for MIDI and MusicXML export. */
export function tempoEventsForTab(tab: TabDocument): TempoEvent[] {
  const events: TempoEvent[] = [{ scoreTick: 0, bpm: tab.tempo_bpm }]
  const anchors = tab.sync_anchors
  for (let index = 0; index + 1 < anchors.length; index += 1) {
    const left = anchors[index]
    const right = anchors[index + 1]
    const bpm =
      ((right.score_tick - left.score_tick) * tab.sample_rate * 60) /
      ((right.audio_frame - left.audio_frame) * tab.ticks_per_quarter)
    if (!Number.isFinite(bpm) || bpm <= 20 || bpm > 400) continue
    const rounded = Math.round(bpm * 1000) / 1000
    const previous = events.at(-1)!
    if (left.score_tick === previous.scoreTick) {
      previous.bpm = rounded
    } else if (Math.abs(previous.bpm - rounded) >= 0.001) {
      events.push({ scoreTick: left.score_tick, bpm: rounded })
    }
  }
  return events
}

export function pickupMidiShift(tab: TabDocument): number {
  const offset = beatMapFromTab(tab).bar_offset_ticks
  if (offset === 0) return 0
  return ticksPerMeasure(tab.ticks_per_quarter, tab.time_signature) - offset
}
