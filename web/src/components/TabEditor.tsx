import { useEffect, useMemo, useRef } from 'react'

import {
  audioFrameToScoreTick,
  pitchName,
  scoreTickToAudioFrame,
} from '../music'
import type { Fingering, Project } from '../types'
import { TablatureStaff } from './TablatureStaff'

interface TabEditorProps {
  project: Project
  currentTime: number
  selectedNoteId: string | null
  onSelectNote: (noteId: string) => void
  onSeek: (seconds: number) => void
  onFingeringChange: (noteId: string, fingering: Fingering) => void
  disabled?: boolean
}

const side = 64

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
  const passageStart = project.passage.start_s
  const passageEnd = project.passage.end_s
  const duration = Math.max(0.01, passageEnd - passageStart)
  const stringCount = project.tab.tuning.length
  const labels = [...project.tab.tuning].reverse().map(pitchName)
  const width = Math.max(1120, Math.min(12_000, Math.round(duration * 62)))
  const innerWidth = width - side * 2
  const xForTime = (seconds: number) =>
    side +
    Math.max(0, Math.min(1, (seconds - passageStart) / duration)) * innerWidth
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
          <span>
            Transcribe the full song, or optionally limit it to a section above.
          </span>
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
          <TablatureStaff
            width={width}
            labels={labels}
            measures={measures.map((measure) => ({
              number: measure.number,
              x: xForTime(measure.time),
            }))}
            notes={visibleNotes.map((note) => ({
              note,
              x: xForTime(note.audio_onset_s),
              endX: xForTime(note.audio_offset_s),
            }))}
            currentTime={currentTime}
            playheadX={playheadX}
            selectedNoteId={selectedNoteId}
            editable
            disabled={disabled}
            ariaLabel={`${stringCount}-string tablature for ${project.title}`}
            description="Select a note, use arrow keys to move it to another legal string, or drag it vertically while its pitch stays fixed."
            onNoteActivate={(note) => {
              onSelectNote(note.id)
              onSeek(note.audio_onset_s)
            }}
            onFingeringChange={onFingeringChange}
          />
        </div>
      )}
      <p className="tab-help">
        Drag a note across strings. Pitch stays fixed; impossible strings are skipped. Arrow
        keys provide the same control.
      </p>
    </section>
  )
}
