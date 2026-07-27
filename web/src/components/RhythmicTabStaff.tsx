import { useState, type KeyboardEvent } from 'react'

import { formatChordSymbol } from '@solotrace/editor'
import { pitchName } from '../music'
import type { PlayTabSystem, RestValue } from '../tab-layout'
import type { ChordEvent, NoteEvent } from '../types'

const TOP = 54
const STRING_GAP = 18
const STAFF_BOTTOM = TOP + STRING_GAP * 5

function RestMark({ value, x, y }: { value: RestValue; x: number; y: number }) {
  if (value === 'whole' || value === 'half') {
    return (
      <g className="tab-rest" aria-label={`${value} rest`}>
        <line x1={x - 8} x2={x + 8} y1={y} y2={y} />
        <rect x={x - 6} y={value === 'whole' ? y : y - 4} width="12" height="4" />
      </g>
    )
  }
  if (value === 'quarter') {
    return (
      <path
        className="tab-rest"
        aria-label="quarter rest"
        d={`M ${x + 2} ${y - 12} l -7 9 l 8 7 l -6 10`}
      />
    )
  }
  return (
    <g className="tab-rest" aria-label={`${value} rest`}>
      <line x1={x + 3} x2={x + 3} y1={y - 12} y2={y + 10} />
      <circle cx={x - 1} cy={y - 9} r="4" />
      {value === 'sixteenth' && <circle cx={x - 1} cy={y} r="4" />}
    </g>
  )
}

function durationMark(note: NoteEvent, quarter: number): {
  flags: number
  dotted: boolean
} {
  const ratio = note.duration_ticks / quarter
  return {
    flags: ratio <= 0.26 ? 2 : ratio <= 0.55 ? 1 : 0,
    dotted: Math.abs(ratio - 0.75) < 0.13 || Math.abs(ratio - 1.5) < 0.2,
  }
}

function techniqueLabel(note: NoteEvent): string {
  const names: Record<string, string> = {
    bend: 'b',
    vibrato: '~~~~',
    slide: '/',
    'slide-up': '/',
    'slide-down': '\\',
    'hammer-on': 'H',
    'pull-off': 'P',
  }
  return note.techniques.map((item) => names[item] ?? item).join(' ')
}

function xForTime(system: PlayTabSystem, seconds: number): number {
  const measure =
    system.measures.find(
      (candidate) => seconds >= candidate.start_s && seconds <= candidate.end_s,
    ) ?? (seconds < system.start_s ? system.measures[0] : system.measures.at(-1)!)
  const progress = Math.max(
    0,
    Math.min(1, (seconds - measure.start_s) / Math.max(0.001, measure.end_s - measure.start_s)),
  )
  return measure.x + progress * measure.width
}

export function RhythmicTabStaff({
  system,
  labels,
  chords,
  playheadX,
  currentTime,
  onSeek,
  timeSignature,
  ticksPerQuarter,
}: {
  system: PlayTabSystem
  labels: string[]
  chords: ChordEvent[]
  playheadX: number | null
  currentTime: number
  onSeek: (seconds: number) => void
  timeSignature: [number, number]
  ticksPerQuarter: number
}) {
  const notes = system.measures.flatMap((measure) => measure.notes)
  const visibleChords = chords
    .filter(
      (chord) =>
        chord.audio_offset_s > system.start_s &&
        chord.audio_onset_s < system.end_s,
    )
    .map((chord) => ({
      chord,
      x: xForTime(system, Math.max(chord.audio_onset_s, system.start_s)),
    }))
  const [focusIndex, setFocusIndex] = useState(0)
  const height = 188
  const beamed = notes
    .map((note, index) => ({ note, index }))
    .filter(({ note }) => note.duration_ticks <= ticksPerQuarter / 2)
  const beamPairs = beamed.slice(1).flatMap((current, index) => {
    const previous = beamed[index]
    if (current.index !== previous.index + 1) return []
    const left = xForTime(system, previous.note.audio_onset_s)
    const right = xForTime(system, current.note.audio_onset_s)
    if (right - left > 86) return []
    const down = previous.note.string <= 3 && current.note.string <= 3
    const up = previous.note.string > 3 && current.note.string > 3
    return down || up ? [{ left, right, y: down ? STAFF_BOTTOM + 34 : TOP - 34 }] : []
  })

  const moveFocus = (event: KeyboardEvent<SVGGElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? notes.length - 1
          : Math.max(0, Math.min(notes.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)))
    setFocusIndex(next)
    document.getElementById(`rhythmic-note-${system.id}-${next}`)?.focus()
  }

  return (
    <svg
      className="rhythmic-tab"
      width={system.width}
      height={height}
      role="img"
      aria-label={`${labels.length}-string rhythmic tablature, bars ${system.measures[0].number} through ${system.measures.at(-1)!.number}`}
      onClick={(event) => {
        if ((event.target as Element).closest('[data-note]')) return
        const bounds = event.currentTarget.getBoundingClientRect()
        const x = (event.clientX - bounds.left) * (system.width / Math.max(1, bounds.width))
        const measure =
          system.measures.find((item) => x >= item.x && x <= item.x + item.width) ??
          system.measures.at(-1)!
        const progress = Math.max(0, Math.min(1, (x - measure.x) / measure.width))
        onSeek(measure.start_s + progress * (measure.end_s - measure.start_s))
      }}
    >
      <text className="tab-mark" x="12" y="28">TAB</text>
      {visibleChords.map(({ chord, x }) => {
        const active =
          currentTime >= chord.audio_onset_s &&
          currentTime < chord.audio_offset_s
        return (
          <text
            key={chord.id}
            className={`play-chord-symbol ${active ? 'active' : ''}`}
            x={x + 7}
            y="35"
          >
            {formatChordSymbol(chord)}
          </text>
        )
      })}
      {labels.map((label, index) => {
        const y = TOP + index * STRING_GAP
        return (
          <g key={label}>
            <text className="tab-string-label" x="48" y={y + 4} textAnchor="end">{label}</text>
            <line className="tab-string" x1="56" x2={system.width - 10} y1={y} y2={y} />
          </g>
        )
      })}
      <text className="time-signature" x="65" y={TOP + 29}>
        <tspan x="65" dy="0">{timeSignature[0]}</tspan>
        <tspan x="65" dy="23">{timeSignature[1]}</tspan>
      </text>
      {system.measures.map((measure, index) => (
        <g key={measure.number}>
          <line className="barline" x1={measure.x} x2={measure.x} y1={TOP - 8} y2={STAFF_BOTTOM + 8} />
          <text className="bar-number" x={measure.x + 6} y="15">{measure.number}</text>
          {index === system.measures.length - 1 && (
            <line className="barline" x1={measure.x + measure.width} x2={measure.x + measure.width} y1={TOP - 8} y2={STAFF_BOTTOM + 8} />
          )}
          {measure.rests.map((rest) => (
            <RestMark
              key={rest.id}
              value={rest.value}
              x={xForTime(system, (rest.start_s + rest.end_s) / 2)}
              y={STAFF_BOTTOM + 30}
            />
          ))}
        </g>
      ))}
      {notes.map((note, index) => {
        const x = xForTime(system, note.audio_onset_s)
        const y = TOP + (note.string - 1) * STRING_GAP
        const stemDown = note.string <= 3
        const stemEnd = stemDown ? STAFF_BOTTOM + 34 : TOP - 34
        const mark = durationMark(note, ticksPerQuarter)
        const active = currentTime >= note.audio_onset_s && currentTime < note.audio_offset_s
        const technique = techniqueLabel(note)
        const tied = system.measures.some(
          (measure) => note.audio_onset_s < measure.end_s && note.audio_offset_s > measure.end_s,
        )
        return (
          <g
            id={`rhythmic-note-${system.id}-${index}`}
            data-note=""
            key={note.id}
            className={`rhythmic-note ${active ? 'active' : ''}`}
            role="button"
            aria-label={`Jump to note: ${pitchName(note.midi_pitch)}, string ${note.string}, fret ${note.fret}`}
            tabIndex={index === focusIndex ? 0 : -1}
            onFocus={() => setFocusIndex(index)}
            onKeyDown={(event) => moveFocus(event, index)}
            onClick={(event) => {
              event.stopPropagation()
              onSeek(note.audio_onset_s)
            }}
          >
            <rect className="fret-erase" x={x - (note.fret > 9 ? 9 : 6)} y={y - 8} width={note.fret > 9 ? 18 : 12} height="16" />
            <text className="fret-number" x={x} y={y + 5} textAnchor="middle">{note.fret}</text>
            <line className="note-stem" x1={x + 9} x2={x + 9} y1={y} y2={stemEnd} />
            {Array.from({ length: mark.flags }, (_, flag) => (
              <path key={flag} className="note-flag" d={`M ${x + 9} ${stemEnd + (stemDown ? -flag * 7 : flag * 7)} q 15 ${stemDown ? 7 : -7} 7 ${stemDown ? 16 : -16}`} />
            ))}
            {mark.dotted && <circle className="duration-dot" cx={x + 16} cy={y} r="2.2" />}
            {technique && <text className="technique-mark" x={x} y={TOP - 17} textAnchor="middle">{technique}</text>}
            {tied && <path className="note-tie" d={`M ${x + 7} ${y + 9} q 18 12 36 0`} />}
          </g>
        )
      })}
      {beamPairs.map((beam, index) => (
        <line key={index} className="note-beam" x1={beam.left + 9} x2={beam.right + 9} y1={beam.y} y2={beam.y} />
      ))}
      {playheadX !== null && (
        <line className="playhead rhythmic-playhead" x1={playheadX} x2={playheadX} y1={TOP - 38} y2={STAFF_BOTTOM + 42} />
      )}
    </svg>
  )
}
