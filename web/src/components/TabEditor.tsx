import { useEffect, useMemo, useRef, useState } from 'react'

import {
  audioFrameToScoreTick,
  minimumConfidence,
  pitchName,
  scoreTickToAudioFrame,
} from '../music'
import type { Fingering, NoteEvent, Project } from '../types'

interface TabEditorProps {
  project: Project
  currentTime: number
  selectedNoteId: string | null
  onSelectNote: (noteId: string) => void
  onSeek: (seconds: number) => void
  onFingeringChange: (noteId: string, fingering: Fingering) => void
  disabled?: boolean
}

const top = 76
const stringGap = 36
const side = 64
function noteLabel(note: NoteEvent): string {
  const confidence = Math.round(minimumConfidence(note.confidence) * 100)
  const technique = note.techniques.length ? `, ${note.techniques.join(', ')}` : ''
  return `${pitchName(note.midi_pitch)}, string ${note.string}, fret ${note.fret}, ${confidence}% confidence${technique}`
}

export function TabEditor({
  project,
  currentTime,
  selectedNoteId,
  onSelectNote,
  onSeek,
  onFingeringChange,
  disabled = false,
}: TabEditorProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{
    noteId: string
    fingering: Fingering
  } | null>(null)
  const passageStart = project.passage.start_s
  const passageEnd = project.passage.end_s
  const duration = Math.max(0.01, passageEnd - passageStart)
  const stringCount = project.tab.tuning.length
  const labels = [...project.tab.tuning].reverse().map(pitchName)
  const width = Math.max(1120, Math.min(12_000, Math.round(duration * 62)))
  const height = top + stringGap * (stringCount - 1) + 72
  const innerWidth = width - side * 2
  const xForTime = (seconds: number) =>
    side +
    Math.max(0, Math.min(1, (seconds - passageStart) / duration)) * innerWidth
  const yForString = (string: number) => top + (string - 1) * stringGap
  const playheadX = xForTime(currentTime)

  const measures = useMemo(() => {
    const output: Array<{ number: number; time: number }> = []
    const [beats, beatType] = project.tab.time_signature
    const ticksPerMeasure =
      project.tab.ticks_per_quarter * beats * (4 / beatType)
    if (project.tab.sync_anchors.length >= 2) {
      const startTick = audioFrameToScoreTick(
        Math.round(passageStart * project.tab.sample_rate),
        project.tab.sync_anchors,
      )
      const endTick = audioFrameToScoreTick(
        Math.round(passageEnd * project.tab.sample_rate),
        project.tab.sync_anchors,
      )
      const firstTick = Math.ceil(startTick / ticksPerMeasure) * ticksPerMeasure
      for (let tick = firstTick; tick <= endTick; tick += ticksPerMeasure) {
        const time =
          scoreTickToAudioFrame(tick, project.tab.sync_anchors) /
          project.tab.sample_rate
        if (time >= passageStart && time <= passageEnd) {
          output.push({
            number: Math.floor(tick / ticksPerMeasure) + 1,
            time,
          })
        }
      }
    } else {
      const secondsPerMeasure =
        (60 / project.tab.tempo_bpm) * beats * (4 / beatType)
      const firstNumber = Math.ceil(passageStart / secondsPerMeasure)
      for (
        let number = firstNumber;
        number * secondsPerMeasure <= passageEnd;
        number += 1
      ) {
        output.push({
          number: number + 1,
          time: number * secondsPerMeasure,
        })
      }
    }
    return output
  }, [
    passageEnd,
    passageStart,
    project.tab.sample_rate,
    project.tab.sync_anchors,
    project.tab.tempo_bpm,
    project.tab.ticks_per_quarter,
    project.tab.time_signature,
  ])

  const visibleNotes = useMemo(
    () =>
      project.tab.notes.filter(
        (note) =>
          note.audio_offset_s >= passageStart &&
          note.audio_onset_s <= passageEnd,
      ),
    [passageEnd, passageStart, project.tab.notes],
  )

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const localX = playheadX - container.scrollLeft
    if (localX > container.clientWidth * 0.82 || localX < container.clientWidth * 0.12) {
      const left = Math.max(0, playheadX - container.clientWidth * 0.3)
      if (typeof container.scrollTo === 'function') {
        container.scrollTo({
          left,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'auto'
            : 'smooth',
        })
      } else {
        container.scrollLeft = left
      }
    }
  }, [playheadX])

  const moveByKeyboard = (note: NoteEvent, direction: -1 | 1) => {
    const targetString = note.string + direction
    const alternative = note.alternatives.find((item) => item.string === targetString)
    if (alternative) onFingeringChange(note.id, alternative)
  }

  return (
    <section className="tab-section" aria-labelledby="tab-heading">
      <div className="tab-heading-row">
        <div>
          <p className="eyebrow">Playable draft</p>
          <h2 id="tab-heading">{project.passage.name}</h2>
        </div>
        <p className="tab-legend">
          <span className="legend-mark certain" /> Confident
          <span className="legend-mark review" /> Needs review
        </p>
      </div>
      {project.tab.notes.length === 0 ? (
        <div className="tab-empty">
          <p>No notes yet.</p>
          <span>Mark the solo above, then create a draft. Waveform editing stays available.</span>
        </div>
      ) : (
        <div
          className="tab-scroll"
          ref={scrollRef}
          onDoubleClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect()
            const absoluteX = event.clientX - bounds.left + event.currentTarget.scrollLeft
            const progress = Math.max(
              0,
              Math.min(1, (absoluteX - side) / innerWidth),
            )
            onSeek(passageStart + progress * duration)
          }}
        >
          <svg
            className="tab-svg"
            width={width}
            height={height}
            role="img"
            aria-label={`${stringCount}-string tablature for ${project.title}`}
          >
            <title>{`${project.title} synchronized guitar tablature`}</title>
            <desc>
              Select a note, use arrow keys to move it to another legal string, or drag it
              vertically while its pitch stays fixed.
            </desc>
            {measures.map((measure) => {
              const x = xForTime(measure.time)
              return (
                <g key={measure.number} className="measure">
                  <line
                    x1={x}
                    x2={x}
                    y1={42}
                    y2={top + stringGap * (stringCount - 1) + 15}
                  />
                  <text x={x + 8} y={34}>
                    Bar {measure.number}
                  </text>
                </g>
              )
            })}
            {labels.map((label, index) => {
              const y = yForString(index + 1)
              return (
                <g key={label + index} className="string-line">
                  <text x={26} y={y + 5}>
                    {label}
                  </text>
                  <line x1={side - 8} x2={width - side + 8} y1={y} y2={y} />
                </g>
              )
            })}
            <line
              className="playhead"
              x1={playheadX}
              x2={playheadX}
              y1={38}
              y2={top + stringGap * (stringCount - 1) + 22}
            />
            {visibleNotes.map((note) => {
              const activeFingering =
                drag?.noteId === note.id
                  ? drag.fingering
                  : { string: note.string, fret: note.fret, label: '', cost: 0 }
              const x = xForTime(note.audio_onset_s)
              const endX = xForTime(note.audio_offset_s)
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
                    selected ? 'selected' : '',
                    playing ? 'playing' : '',
                    needsReview ? 'needs-review' : '',
                    disabled ? 'is-disabled' : '',
                  ].join(' ')}
                  role="button"
                  tabIndex={disabled ? -1 : 0}
                  aria-disabled={disabled}
                  aria-label={noteLabel(note)}
                  onClick={() => {
                    onSelectNote(note.id)
                    onSeek(note.audio_onset_s)
                  }}
                  onKeyDown={(event) => {
                    if (disabled) return
                    if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      moveByKeyboard(note, -1)
                    } else if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      moveByKeyboard(note, 1)
                    } else if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelectNote(note.id)
                      onSeek(note.audio_onset_s)
                    }
                  }}
                  onPointerDown={(event) => {
                    if (disabled) return
                    event.currentTarget.setPointerCapture(event.pointerId)
                    onSelectNote(note.id)
                    setDrag({
                      noteId: note.id,
                      fingering: activeFingering,
                    })
                  }}
                  onPointerMove={(event) => {
                    if (drag?.noteId !== note.id) return
                    const svg = event.currentTarget.ownerSVGElement
                    if (!svg) return
                    const bounds = svg.getBoundingClientRect()
                    const scaleY = height / bounds.height
                    const localY = (event.clientY - bounds.top) * scaleY
                    const string = Math.max(
                      1,
                      Math.min(
                        stringCount,
                        Math.round((localY - top) / stringGap) + 1,
                      ),
                    )
                    const fingering = note.alternatives.find(
                      (alternative) => alternative.string === string,
                    )
                    if (fingering) setDrag({ noteId: note.id, fingering })
                  }}
                  onPointerUp={(event) => {
                    if (drag?.noteId === note.id) {
                      if (
                        drag.fingering.string !== note.string ||
                        drag.fingering.fret !== note.fret
                      ) {
                        onFingeringChange(note.id, drag.fingering)
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
                      y1={40}
                      y2={y - 13}
                    />
                  )}
                  <line className="note-duration" x1={x} x2={Math.max(x + 14, endX)} y1={y} y2={y} />
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
        </div>
      )}
      <p className="tab-help">
        Drag a note across strings. Pitch stays fixed; impossible strings are skipped. Arrow
        keys provide the same control.
      </p>
    </section>
  )
}
