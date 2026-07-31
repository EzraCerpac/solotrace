import { beatMapFromTab, ticksPerMeasure } from '@solotrace/editor'
import { audioFrameToScoreTick, scoreTickToAudioFrame } from './music'
import type { NoteEvent, Project } from './types'

export type RestValue = 'whole' | 'half' | 'quarter' | 'eighth' | 'sixteenth'

export interface TabRest {
  id: string
  start_s: number
  end_s: number
  value: RestValue
}

export interface PlayMeasure {
  number: number
  start_s: number
  end_s: number
  notes: NoteEvent[]
  rests: TabRest[]
  has_tab_notes: boolean
  minimum_width: number
}

export interface PositionedPlayMeasure extends PlayMeasure {
  x: number
  width: number
}

export interface PlayTabSystem {
  kind: 'tab'
  id: string
  start_s: number
  end_s: number
  width: number
  measures: PositionedPlayMeasure[]
}

export interface PlayRestSystem {
  kind: 'rest'
  id: string
  start_s: number
  end_s: number
  start_bar: number
  end_bar: number
  measure_count: number
  width: number
}

export type PlaySystem = PlayTabSystem | PlayRestSystem

export const PLAY_SIDE = 58
const MINIMUM_MEASURE_WIDTH = 220

function restValue(units: number): RestValue {
  if (units >= 16) return 'whole'
  if (units >= 8) return 'half'
  if (units >= 4) return 'quarter'
  if (units >= 2) return 'eighth'
  return 'sixteenth'
}

function restsForMeasure(
  measureNumber: number,
  start: number,
  end: number,
  notes: NoteEvent[],
  sixteenthSeconds: number,
): TabRest[] {
  const occupied = notes
    .map((note) => ({
      start: Math.max(start, note.audio_onset_s),
      end: Math.min(end, note.audio_offset_s),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start)

  const merged: Array<{ start: number; end: number }> = []
  occupied.forEach((interval) => {
    const previous = merged.at(-1)
    if (previous && interval.start <= previous.end + sixteenthSeconds * 0.2) {
      previous.end = Math.max(previous.end, interval.end)
    } else {
      merged.push({ ...interval })
    }
  })

  const gaps: Array<{ start: number; end: number }> = []
  let cursor = start
  merged.forEach((interval) => {
    if (interval.start - cursor >= sixteenthSeconds * 0.75) {
      gaps.push({ start: cursor, end: interval.start })
    }
    cursor = Math.max(cursor, interval.end)
  })
  if (end - cursor >= sixteenthSeconds * 0.75) {
    gaps.push({ start: cursor, end })
  }

  const rests: TabRest[] = []
  gaps.forEach((gap, gapIndex) => {
    const firstUnit = Math.ceil((gap.start - start) / sixteenthSeconds - 0.001)
    const finalUnit = Math.floor((gap.end - start) / sixteenthSeconds + 0.001)
    let unit = firstUnit
    let index = 0
    while (unit < finalUnit) {
      const remaining = finalUnit - unit
      const size = [16, 8, 4, 2, 1].find((candidate) => candidate <= remaining) ?? 1
      rests.push({
        id: `bar-${measureNumber}-gap-${gapIndex}-rest-${index}`,
        start_s: start + unit * sixteenthSeconds,
        end_s: Math.min(end, start + (unit + size) * sixteenthSeconds),
        value: restValue(size),
      })
      unit += size
      index += 1
    }
  })
  return rests
}

function minimumMeasureWidth(notes: NoteEvent[]): number {
  const counts = new Map<number, number>()
  notes.forEach((note) => counts.set(note.string, (counts.get(note.string) ?? 0) + 1))
  const densestString = Math.max(0, ...counts.values())
  return Math.min(720, Math.max(MINIMUM_MEASURE_WIDTH, 92 + densestString * 44))
}

interface MeasureSpan {
  number: number
  start_s: number
  end_s: number
  start_tick: number
  end_tick: number
}

function measureSpans(project: Project): MeasureSpan[] {
  const measureTicks = ticksPerMeasure(
    project.tab.ticks_per_quarter,
    project.tab.time_signature,
  )
  const barOffsetTicks = beatMapFromTab(project.tab).bar_offset_ticks
  const quarterSeconds = 60 / Math.max(1, project.tab.tempo_bpm)
  const fallbackFramesPerTick =
    (quarterSeconds * project.tab.sample_rate) / project.tab.ticks_per_quarter
  const anchors = [...project.tab.sync_anchors].sort(
    (left, right) => left.score_tick - right.score_tick,
  )
  const first = anchors[0]
  const estimatedSongTick = first
    ? Math.round(
        (first.audio_frame / project.tab.sample_rate / quarterSeconds) *
          project.tab.ticks_per_quarter,
      )
    : 0
  const localTickOffset = first ? estimatedSongTick - first.score_tick : 0
  const frameForSongTick = (songTick: number) => {
    if (!first) return Math.round(songTick * fallbackFramesPerTick)
    const localTick = songTick - localTickOffset
    if (localTick >= first.score_tick) {
      return scoreTickToAudioFrame(localTick, anchors)
    }
    const second = anchors[1]
    const tickSpan = second?.score_tick - first.score_tick
    const framesPerTick =
      second && tickSpan
        ? (second.audio_frame - first.audio_frame) / tickSpan
        : fallbackFramesPerTick
    return Math.round(first.audio_frame + (localTick - first.score_tick) * framesPerTick)
  }
  const durationFrame = Math.round(project.duration_s * project.tab.sample_rate)
  const endSongTick = anchors.length
    ? audioFrameToScoreTick(durationFrame, anchors) + localTickOffset
    : Math.round(durationFrame / fallbackFramesPerTick)
  const tickBoundaries = [0]
  let nextTick = barOffsetTicks > 0 ? barOffsetTicks : measureTicks
  while (nextTick < endSongTick && tickBoundaries.length < 10_000) {
    tickBoundaries.push(nextTick)
    nextTick += measureTicks
  }
  tickBoundaries.push(nextTick)

  return tickBoundaries.slice(0, -1).map((startTick, index) => {
    const endTick = tickBoundaries[index + 1]
    const start = index === 0
      ? 0
      : Math.max(
          0,
          Math.min(project.duration_s, frameForSongTick(startTick) / project.tab.sample_rate),
        )
    const end = index === tickBoundaries.length - 2
      ? project.duration_s
      : Math.max(
          start,
          Math.min(project.duration_s, frameForSongTick(endTick) / project.tab.sample_rate),
        )
    return {
      number: barOffsetTicks > 0 ? index : index + 1,
      start_s: start,
      end_s: end,
      start_tick: startTick,
      end_tick: endTick,
    }
  })
}

export function buildPlayMeasures(project: Project): PlayMeasure[] {
  const quarterSeconds = 60 / Math.max(1, project.tab.tempo_bpm)
  const fallbackSixteenthSeconds = quarterSeconds / 4
  const spans = measureSpans(project)

  return spans.map((span, index) => {
    const start = span.start_s
    const end = span.end_s
    const sixteenthUnits =
      (span.end_tick - span.start_tick) / (project.tab.ticks_per_quarter / 4)
    const sixteenthSeconds =
      end > start && sixteenthUnits > 0
        ? (end - start) / sixteenthUnits
        : fallbackSixteenthSeconds
    const soundingNotes = project.tab.notes.filter(
      (note) => note.audio_offset_s > start && note.audio_onset_s < end,
    )
    const notes = soundingNotes.filter(
      (note) =>
        note.audio_onset_s >= start &&
        (note.audio_onset_s < end ||
          (index === spans.length - 1 && note.audio_onset_s <= end)),
    )
    return {
      number: span.number,
      start_s: start,
      end_s: end,
      notes,
      rests: soundingNotes.length
        ? restsForMeasure(span.number, start, end, soundingNotes, sixteenthSeconds)
        : [],
      has_tab_notes: soundingNotes.length > 0,
      minimum_width: minimumMeasureWidth(notes),
    }
  })
}

function positionMeasures(
  measures: PlayMeasure[],
  containerWidth: number,
): PlayTabSystem {
  const minimumContentWidth = measures.reduce(
    (total, measure) => total + measure.minimum_width,
    0,
  )
  const width = Math.max(containerWidth, minimumContentWidth + PLAY_SIDE * 2)
  const spare = Math.max(0, width - PLAY_SIDE * 2 - minimumContentWidth)
  const extraPerMeasure = spare / measures.length
  let x = PLAY_SIDE
  const positioned = measures.map((measure) => {
    const measureWidth = measure.minimum_width + extraPerMeasure
    const next = { ...measure, x, width: measureWidth }
    x += measureWidth
    return next
  })
  const first = measures[0]
  const last = measures.at(-1)!
  return {
    kind: 'tab',
    id: `bars-${first.number}-${last.number}`,
    start_s: first.start_s,
    end_s: last.end_s,
    width,
    measures: positioned,
  }
}

/** Pure score-tick layout shared by Play rendering and export validation. */
export function buildRhythmicTabSystems(
  project: Project,
  containerWidth: number,
): PlaySystem[] {
  const measures = buildPlayMeasures(project)
  const safeWidth = Math.max(320, containerWidth)
  const measuresPerSystem = safeWidth < 600 ? 1 : safeWidth < 900 ? 2 : 4
  const systems: PlaySystem[] = []
  let tabRun: PlayMeasure[] = []
  let restRun: PlayMeasure[] = []

  const flushTabs = () => {
    if (!tabRun.length) return
    systems.push(positionMeasures(tabRun, safeWidth))
    tabRun = []
  }
  const flushRests = () => {
    if (!restRun.length) return
    const first = restRun[0]
    const last = restRun.at(-1)!
    systems.push({
      kind: 'rest',
      id: `rest-${first.number}-${last.number}`,
      start_s: first.start_s,
      end_s: last.end_s,
      start_bar: first.number,
      end_bar: last.number,
      measure_count: restRun.length,
      width: safeWidth,
    })
    restRun = []
  }

  measures.forEach((measure) => {
    if (!measure.has_tab_notes) {
      flushTabs()
      restRun.push(measure)
      return
    }

    flushRests()
    if (tabRun.length >= measuresPerSystem) {
      flushTabs()
    }
    tabRun.push(measure)
  })
  flushTabs()
  flushRests()
  return systems
}

/** @deprecated Prefer the renderer/export contract name. */
export const buildPlaySystems = buildRhythmicTabSystems

export function timeForSystemX(system: PlayTabSystem, x: number): number {
  const measure =
    system.measures.find((candidate) => x >= candidate.x && x <= candidate.x + candidate.width) ??
    (x < PLAY_SIDE ? system.measures[0] : system.measures.at(-1)!)
  const progress = Math.max(0, Math.min(1, (x - measure.x) / measure.width))
  return measure.start_s + progress * (measure.end_s - measure.start_s)
}
