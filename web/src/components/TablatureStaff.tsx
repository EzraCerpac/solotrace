import { useState } from 'react'

import { minimumConfidence, pitchName } from '../music'
import type { RestValue } from '../tab-layout'
import type { Fingering, NoteEvent } from '../types'

export const STAFF_TOP = 68
export const STRING_GAP = 36

export interface StaffMeasure {
  number: number
  x: number
}

export interface StaffNote {
  note: NoteEvent
  x: number
  endX: number
}

export interface StaffRest {
  id: string
  x: number
  value: RestValue
}

interface TablatureStaffProps {
  width: number
  labels: string[]
  measures: StaffMeasure[]
  notes: StaffNote[]
  rests?: StaffRest[]
  currentTime: number
  playheadX: number | null
  selectedNoteId?: string | null
  editable?: boolean
  disabled?: boolean
  ariaLabel: string
  description: string
  onNoteActivate: (note: NoteEvent) => void
  onFingeringChange?: (noteId: string, fingering: Fingering) => void
  onBackgroundClick?: (event: React.MouseEvent<SVGSVGElement>) => void
}

function noteLabel(note: NoteEvent): string {
  const confidence = Math.round(minimumConfidence(note.confidence) * 100)
  const technique = note.techniques.length ? `, ${note.techniques.join(', ')}` : ''
  return `${pitchName(note.midi_pitch)}, string ${note.string}, fret ${note.fret}, ${confidence}% confidence${technique}`
}

function RestGlyph({ x, value }: { x: number; value: RestValue }) {
  const y = 42
  if (value === 'whole' || value === 'half') {
    return (
      <g className={`notation-rest ${value}`} aria-label={`${value} rest`}>
        <line x1={x - 12} x2={x + 12} y1={y - 8} y2={y - 8} />
        <rect x={x - 7} y={value === 'whole' ? y - 8 : y - 13} width={14} height={5} />
      </g>
    )
  }
  if (value === 'quarter') {
    return (
      <path
        className="notation-rest quarter"
        aria-label="quarter rest"
        d={`M${x + 3} ${y - 18} l-7 10 8 7 -7 11 5 7 -1 -9 7 -9 -7 -7 6 -8Z`}
      />
    )
  }
  const flags = value === 'sixteenth' ? 2 : 1
  return (
    <g className={`notation-rest ${value}`} aria-label={`${value} rest`}>
      <path d={`M${x - 2} ${y - 15} q9 -3 8 5 q-2 6 -9 4 l-4 18`} />
      {flags === 2 && <path d={`M${x} ${y - 4} q9 -3 8 5 q-2 5 -8 4`} />}
    </g>
  )
}

export function TablatureStaff({
  width,
  labels,
  measures,
  notes,
  rests = [],
  currentTime,
  playheadX,
  selectedNoteId = null,
  editable = false,
  disabled = false,
  ariaLabel,
  description,
  onNoteActivate,
  onFingeringChange,
  onBackgroundClick,
}: TablatureStaffProps) {
  const stringCount = labels.length
  const height = STAFF_TOP + STRING_GAP * (stringCount - 1) + 64
  const [drag, setDrag] = useState<{
    noteId: string
    fingering: Fingering
  } | null>(null)
  const yForString = (string: number) => STAFF_TOP + (string - 1) * STRING_GAP

  return (
    <svg
      className={`tab-svg ${editable ? 'editable' : 'read-only'}`}
      width={width}
      height={height}
      role="img"
      aria-label={ariaLabel}
      onClick={onBackgroundClick}
    >
      <title>{ariaLabel}</title>
      <desc>{description}</desc>
      {measures.map((measure) => (
        <g key={`${measure.number}-${measure.x}`} className="measure">
          <line
            x1={measure.x}
            x2={measure.x}
            y1={36}
            y2={STAFF_TOP + STRING_GAP * (stringCount - 1) + 15}
          />
          <text x={measure.x + 8} y={29}>
            Bar {measure.number}
          </text>
        </g>
      ))}
      {labels.map((label, index) => {
        const y = yForString(index + 1)
        return (
          <g key={label + index} className="string-line">
            <text x={24} y={y + 5}>
              {label}
            </text>
            <line x1={54} x2={width - 46} y1={y} y2={y} />
          </g>
        )
      })}
      {rests.map((rest) => (
        <RestGlyph key={rest.id} x={rest.x} value={rest.value} />
      ))}
      {playheadX !== null && (
        <line
          className="playhead"
          x1={playheadX}
          x2={playheadX}
          y1={34}
          y2={STAFF_TOP + STRING_GAP * (stringCount - 1) + 22}
        />
      )}
      {notes.map(({ note, x, endX }) => {
        const activeFingering =
          drag?.noteId === note.id
            ? drag.fingering
            : { string: note.string, fret: note.fret, label: '', cost: 0 }
        const y = yForString(activeFingering.string)
        const selected = selectedNoteId === note.id
        const playing =
          currentTime >= note.audio_onset_s && currentTime <= note.audio_offset_s
        const needsReview = minimumConfidence(note.confidence) < 0.72
        return (
          <g
            key={note.id}
            className={[
              'tab-note',
              editable ? 'editable' : 'read-only',
              selected ? 'selected' : '',
              playing ? 'playing' : '',
              needsReview ? 'needs-review' : '',
              disabled ? 'is-disabled' : '',
            ].join(' ')}
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-disabled={disabled}
            aria-label={editable ? noteLabel(note) : `${noteLabel(note)}. Jump to note.`}
            onClick={(event) => {
              event.stopPropagation()
              if (!disabled) onNoteActivate(note)
            }}
            onKeyDown={(event) => {
              if (disabled) return
              if (editable && event.key === 'ArrowUp') {
                event.preventDefault()
                const targetString = note.string - 1
                const alternative = note.alternatives.find(
                  (item) => item.string === targetString,
                )
                if (alternative) onFingeringChange?.(note.id, alternative)
              } else if (editable && event.key === 'ArrowDown') {
                event.preventDefault()
                const targetString = note.string + 1
                const alternative = note.alternatives.find(
                  (item) => item.string === targetString,
                )
                if (alternative) onFingeringChange?.(note.id, alternative)
              } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onNoteActivate(note)
              }
            }}
            onPointerDown={(event) => {
              if (!editable || disabled) return
              event.stopPropagation()
              event.currentTarget.setPointerCapture(event.pointerId)
              onNoteActivate(note)
              setDrag({ noteId: note.id, fingering: activeFingering })
            }}
            onPointerMove={(event) => {
              if (!editable || drag?.noteId !== note.id) return
              const svg = event.currentTarget.ownerSVGElement
              if (!svg) return
              const bounds = svg.getBoundingClientRect()
              const scaleY = height / bounds.height
              const localY = (event.clientY - bounds.top) * scaleY
              const string = Math.max(
                1,
                Math.min(
                  stringCount,
                  Math.round((localY - STAFF_TOP) / STRING_GAP) + 1,
                ),
              )
              const fingering = note.alternatives.find(
                (alternative) => alternative.string === string,
              )
              if (fingering) setDrag({ noteId: note.id, fingering })
            }}
            onPointerUp={(event) => {
              if (!editable) return
              if (drag?.noteId === note.id) {
                if (
                  drag.fingering.string !== note.string ||
                  drag.fingering.fret !== note.fret
                ) {
                  onFingeringChange?.(note.id, drag.fingering)
                }
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
              setDrag(null)
            }}
            onPointerCancel={() => setDrag(null)}
          >
            {selected && (
              <line
                className="note-stitch"
                x1={x}
                x2={x}
                y1={36}
                y2={y - 13}
              />
            )}
            <line
              className="note-duration"
              x1={x}
              x2={Math.max(x + 14, endX)}
              y1={y}
              y2={y}
            />
            <rect x={x - 12} y={y - 14} width={28} height={28} rx={6} />
            <text x={x + 2} y={y + 5} textAnchor="middle">
              {activeFingering.fret}
            </text>
            {note.techniques.includes('bend') && (
              <path
                className="technique-path"
                d={`M${x + 12} ${y - 15} q13 -20 25 -2`}
              />
            )}
            {note.techniques.includes('vibrato') && (
              <path
                className="technique-path"
                d={`M${x + 18} ${y - 8} q5 -6 10 0 t10 0`}
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}
