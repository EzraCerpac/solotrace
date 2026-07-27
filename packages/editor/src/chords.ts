import type {
  ChordEvent,
  ChordKind,
  ChordQuality,
  ChordTrack,
  SpelledPitch,
  SyncAnchor,
  TabDocument,
} from './types'

export const CHORD_QUALITIES: readonly ChordQuality[] = Object.freeze([
  'min',
  'maj',
  'dim',
  'aug',
  'min6',
  'maj6',
  'min7',
  'minmaj7',
  'maj7',
  '7',
  'dim7',
  'hdim7',
  'sus2',
  'sus4',
])

export function emptyChordTrack(): ChordTrack {
  return {
    engine: 'manual',
    model_revision: null,
    model_sha256: null,
    analyzed_start_s: null,
    analyzed_end_s: null,
    events: [],
  }
}

function accidental(pitch: SpelledPitch): string {
  return ({ [-2]: 'bb', [-1]: 'b', [0]: '', [1]: '#', [2]: '##' } as Record<number, string>)[
    pitch.alter
  ] ?? ''
}

const QUALITY_SUFFIX: Record<ChordQuality, string> = {
  min: 'm',
  maj: '',
  dim: 'dim',
  aug: 'aug',
  min6: 'm6',
  maj6: '6',
  min7: 'm7',
  minmaj7: 'm(maj7)',
  maj7: 'maj7',
  '7': '7',
  dim7: 'dim7',
  hdim7: 'm7b5',
  sus2: 'sus2',
  sus4: 'sus4',
}

const SUFFIX_QUALITY = new Map<string, ChordQuality>([
  ['', 'maj'],
  ['maj', 'maj'],
  ['m', 'min'],
  ['-', 'min'],
  ['min', 'min'],
  ['dim', 'dim'],
  ['°', 'dim'],
  ['aug', 'aug'],
  ['+', 'aug'],
  ['m6', 'min6'],
  ['min6', 'min6'],
  ['6', 'maj6'],
  ['maj6', 'maj6'],
  ['m7', 'min7'],
  ['min7', 'min7'],
  ['m(maj7)', 'minmaj7'],
  ['minmaj7', 'minmaj7'],
  ['mmaj7', 'minmaj7'],
  ['maj7', 'maj7'],
  ['7', '7'],
  ['dim7', 'dim7'],
  ['°7', 'dim7'],
  ['hdim7', 'hdim7'],
  ['m7b5', 'hdim7'],
  ['ø7', 'hdim7'],
  ['sus2', 'sus2'],
  ['sus4', 'sus4'],
  ['sus', 'sus4'],
])

export function formatChordSymbol(event: Pick<ChordEvent, 'kind' | 'root' | 'quality' | 'bass'>) {
  if (event.kind === 'no-chord') return 'N.C.'
  if (event.kind === 'unknown') return 'X'
  if (!event.root || !event.quality) return 'X'
  const bass = event.bass ? `/${event.bass.step}${accidental(event.bass)}` : ''
  return `${event.root.step}${accidental(event.root)}${QUALITY_SUFFIX[event.quality]}${bass}`
}

function parsePitch(text: string): SpelledPitch | null {
  const match = /^([A-Ga-g])(bb|##|b|#)?$/.exec(text.trim())
  if (!match) return null
  return {
    step: match[1].toUpperCase() as SpelledPitch['step'],
    alter: ({ bb: -2, b: -1, '#': 1, '##': 2 } as Record<string, number>)[match[2] ?? ''] ?? 0,
  }
}

export type ParsedChordSymbol = {
  kind: ChordKind
  root: SpelledPitch | null
  quality: ChordQuality | null
  bass: SpelledPitch | null
}

export function parseChordSymbol(input: string): ParsedChordSymbol {
  const symbol = input.trim()
  if (/^(?:N\.?C\.?|no[- ]?chord)$/i.test(symbol)) {
    return { kind: 'no-chord', root: null, quality: null, bass: null }
  }
  if (/^(?:X|\?|unknown)$/i.test(symbol)) {
    return { kind: 'unknown', root: null, quality: null, bass: null }
  }
  const [body, bassText, ...extra] = symbol.split('/')
  if (extra.length) throw new Error('Use one optional slash bass, such as C/E')
  const rootMatch = /^([A-Ga-g](?:bb|##|b|#)?)(.*)$/.exec(body)
  if (!rootMatch) throw new Error('Enter a chord such as C, Cm7, Dbmaj7, or N.C.')
  const root = parsePitch(rootMatch[1])
  const quality = SUFFIX_QUALITY.get(rootMatch[2].toLowerCase())
  const bass = bassText === undefined ? null : parsePitch(bassText)
  if (!root || !quality || (bassText !== undefined && !bass)) {
    throw new Error('This chord spelling or quality is not supported')
  }
  return { kind: 'chord', root, quality, bass }
}

function audioFrameToScoreTick(audioFrame: number, anchors: readonly SyncAnchor[]): number {
  if (!anchors.length) return 0
  const ordered = [...anchors].sort((left, right) => left.audio_frame - right.audio_frame)
  if (audioFrame <= ordered[0].audio_frame) return ordered[0].score_tick
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const left = ordered[index]
    const right = ordered[index + 1]
    if (audioFrame <= right.audio_frame) {
      const span = right.audio_frame - left.audio_frame
      if (!span) return right.score_tick
      return Math.round(
        left.score_tick +
          ((audioFrame - left.audio_frame) / span) * (right.score_tick - left.score_tick),
      )
    }
  }
  const last = ordered.at(-1)!
  const previous = ordered.at(-2) ?? last
  const span = last.audio_frame - previous.audio_frame
  if (!span) return last.score_tick
  return Math.max(
    0,
    Math.round(
      last.score_tick +
        (audioFrame - last.audio_frame) *
          ((last.score_tick - previous.score_tick) / span),
    ),
  )
}

export function normalizeChordTrack(track: ChordTrack, tab: TabDocument): ChordTrack {
  const events = [...track.events].sort(
    (left, right) => left.audio_onset_s - right.audio_onset_s || left.id.localeCompare(right.id),
  )
  if (!events.length) return { ...track, events: [] }
  if (track.analyzed_start_s === null || track.analyzed_end_s === null) {
    throw new Error('A non-empty chord track needs an analyzed range')
  }
  const ids = new Set(events.map((event) => event.id))
  if (ids.size !== events.length) throw new Error('Chord IDs must be unique')
  if (Math.abs(events[0].audio_onset_s - track.analyzed_start_s) > 0.0001) {
    throw new Error('Chords must start at the analyzed range')
  }
  if (Math.abs(events.at(-1)!.audio_offset_s - track.analyzed_end_s) > 0.0001) {
    throw new Error('Chords must end at the analyzed range')
  }
  return {
    ...track,
    events: events.map((event, index) => {
      const onset =
        index === 0 ? track.analyzed_start_s! : events[index - 1].audio_offset_s
      const offset =
        index === events.length - 1 ? track.analyzed_end_s! : event.audio_offset_s
      if (offset <= onset) throw new Error('Chord spans must have positive duration')
      if (
        index &&
        Math.abs(events[index - 1].audio_offset_s - event.audio_onset_s) > 0.0001
      ) {
        throw new Error('Chord spans must be contiguous and cannot overlap')
      }
      const onsetFrame = Math.round(onset * tab.sample_rate)
      const endFrame = Math.max(onsetFrame + 1, Math.round(offset * tab.sample_rate))
      const scoreTick = audioFrameToScoreTick(onsetFrame, tab.sync_anchors)
      const endTick = audioFrameToScoreTick(endFrame, tab.sync_anchors)
      return {
        ...event,
        onset_frame: onsetFrame,
        end_frame: endFrame,
        audio_onset_s: onset,
        audio_offset_s: offset,
        score_tick: scoreTick,
        duration_ticks: Math.max(1, endTick - scoreTick),
      }
    }),
  }
}

export function replaceChordSymbol(
  track: ChordTrack,
  chordId: string,
  symbol: string,
): ChordTrack {
  const parsed = parseChordSymbol(symbol)
  return {
    ...track,
    events: track.events.map((event) =>
      event.id === chordId
        ? {
            ...event,
            ...parsed,
            provenance: 'manual',
            edited: true,
          }
        : event,
    ),
  }
}

export function setChordReviewed(
  track: ChordTrack,
  chordId: string,
  reviewed: boolean,
): ChordTrack {
  return {
    ...track,
    events: track.events.map((event) =>
      event.id === chordId ? { ...event, reviewed } : event,
    ),
  }
}

export function splitChord(
  track: ChordTrack,
  chordId: string,
  atSeconds: number,
  newId: string,
): ChordTrack {
  const index = track.events.findIndex((event) => event.id === chordId)
  if (index < 0) throw new Error('Chord not found')
  const event = track.events[index]
  if (atSeconds <= event.audio_onset_s || atSeconds >= event.audio_offset_s) {
    throw new Error('Split point must be inside the chord')
  }
  const left = { ...event, audio_offset_s: atSeconds, edited: true }
  const right = {
    ...event,
    id: newId,
    audio_onset_s: atSeconds,
    provenance: 'manual' as const,
    edited: true,
    reviewed: false,
  }
  return {
    ...track,
    events: [...track.events.slice(0, index), left, right, ...track.events.slice(index + 1)],
  }
}

export function mergeChord(
  track: ChordTrack,
  chordId: string,
  direction: 'left' | 'right',
): ChordTrack {
  const index = track.events.findIndex((event) => event.id === chordId)
  const neighborIndex = direction === 'left' ? index - 1 : index + 1
  if (index < 0 || neighborIndex < 0 || neighborIndex >= track.events.length) {
    throw new Error(`No chord to merge on the ${direction}`)
  }
  const first = Math.min(index, neighborIndex)
  const second = Math.max(index, neighborIndex)
  const selected = track.events[index]
  const merged = {
    ...selected,
    audio_onset_s: track.events[first].audio_onset_s,
    audio_offset_s: track.events[second].audio_offset_s,
    provenance: 'manual' as const,
    edited: true,
  }
  return {
    ...track,
    events: [...track.events.slice(0, first), merged, ...track.events.slice(second + 1)],
  }
}

export function moveChordBoundary(
  track: ChordTrack,
  leftChordId: string,
  atSeconds: number,
): ChordTrack {
  const index = track.events.findIndex((event) => event.id === leftChordId)
  if (index < 0 || index === track.events.length - 1) throw new Error('Boundary not found')
  const left = track.events[index]
  const right = track.events[index + 1]
  if (atSeconds <= left.audio_onset_s || atSeconds >= right.audio_offset_s) {
    throw new Error('Boundary must stay between the surrounding chord edges')
  }
  return {
    ...track,
    events: track.events.map((event, eventIndex) => {
      if (eventIndex === index) return { ...event, audio_offset_s: atSeconds, edited: true }
      if (eventIndex === index + 1) {
        return { ...event, audio_onset_s: atSeconds, edited: true }
      }
      return event
    }),
  }
}

export function deleteChordToUnknown(track: ChordTrack, chordId: string): ChordTrack {
  return {
    ...track,
    events: track.events.map((event) =>
      event.id === chordId
        ? {
            ...event,
            kind: 'unknown',
            root: null,
            quality: null,
            bass: null,
            provenance: 'manual',
            edited: true,
            reviewed: false,
          }
        : event,
    ),
  }
}
