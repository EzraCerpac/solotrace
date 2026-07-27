import { useState } from 'react'

import { formatChordSymbol } from '@solotrace/editor'
import type { ChordEvent } from '../types'

interface HarmonyLaneProps {
  width: number
  side: number
  passageStart: number
  passageEnd: number
  tempoBpm: number
  beatType: number
  chords: ChordEvent[]
  currentTime: number
  selectedChordId: string | null
  editable: boolean
  disabled: boolean
  onSelect: (chord: ChordEvent) => void
  onBoundaryMove: (leftChordId: string, seconds: number) => void
  onAddAtPlayhead: () => void
}

export function HarmonyLane({
  width,
  side,
  passageStart,
  passageEnd,
  tempoBpm,
  beatType,
  chords,
  currentTime,
  selectedChordId,
  editable,
  disabled,
  onSelect,
  onBoundaryMove,
  onAddAtPlayhead,
}: HarmonyLaneProps) {
  const duration = Math.max(0.01, passageEnd - passageStart)
  const innerWidth = width - side * 2
  const [drag, setDrag] = useState<{ id: string; seconds: number } | null>(null)
  const xForTime = (seconds: number) =>
    side + Math.max(0, Math.min(1, (seconds - passageStart) / duration)) * innerWidth
  const beatSeconds = (60 / tempoBpm) * (4 / beatType)
  const displayed = chords.filter(
    (chord) =>
      chord.audio_offset_s >= passageStart && chord.audio_onset_s <= passageEnd,
  )

  return (
    <div
      className="harmony-lane"
      style={{ width }}
      role="group"
      aria-label="Harmony lane"
    >
      <div className="harmony-label">CHORDS</div>
      {displayed.length === 0 ? (
        editable ? (
          <button
            type="button"
            className="harmony-empty-action"
            disabled={disabled}
            onClick={onAddAtPlayhead}
          >
            Add chord at playhead
          </button>
        ) : (
          <span className="harmony-empty-label">No chord labels</span>
        )
      ) : (
        displayed.map((chord, index) => {
          const left = xForTime(chord.audio_onset_s)
          const right = xForTime(chord.audio_offset_s)
          const selected = chord.id === selectedChordId
          const playing =
            currentTime >= chord.audio_onset_s && currentTime < chord.audio_offset_s
          const boundarySeconds = drag?.id === chord.id ? drag.seconds : chord.audio_offset_s
          return (
            <div key={chord.id}>
              <button
                type="button"
                className={[
                  'harmony-chord',
                  selected ? 'selected' : '',
                  playing ? 'playing' : '',
                  chord.reviewed ? 'reviewed' : 'needs-review',
                ].join(' ')}
                style={{ left, width: Math.max(24, right - left) }}
                disabled={disabled}
                aria-label={`${formatChordSymbol(chord)}, ${chord.reviewed ? 'reviewed' : 'needs review'}`}
                onClick={() => onSelect(chord)}
              >
                <strong>{formatChordSymbol(chord)}</strong>
                {chord.model_score !== null && (
                  <small>{Math.round(chord.model_score * 100)} model score</small>
                )}
              </button>
              {editable && index < displayed.length - 1 && (
                <button
                  type="button"
                  className="harmony-boundary"
                  style={{ left: xForTime(boundarySeconds) }}
                  disabled={disabled}
                  aria-label={`Move boundary after ${formatChordSymbol(chord)}`}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId)
                    setDrag({ id: chord.id, seconds: chord.audio_offset_s })
                  }}
                  onPointerMove={(event) => {
                    if (drag?.id !== chord.id) return
                    const lane = event.currentTarget.parentElement?.parentElement
                    if (!lane) return
                    const bounds = lane.getBoundingClientRect()
                    const scale = width / bounds.width
                    const x = (event.clientX - bounds.left) * scale
                    const exact =
                      passageStart +
                      Math.max(0, Math.min(1, (x - side) / innerWidth)) * duration
                    const seconds = event.altKey
                      ? exact
                      : Math.round(exact / beatSeconds) * beatSeconds
                    setDrag({ id: chord.id, seconds })
                  }}
                  onPointerUp={(event) => {
                    if (drag?.id === chord.id) {
                      onBoundaryMove(chord.id, drag.seconds)
                      event.currentTarget.releasePointerCapture(event.pointerId)
                    }
                    setDrag(null)
                  }}
                  onPointerCancel={() => setDrag(null)}
                />
              )}
            </div>
          )
        })
      )}
      <div
        className="harmony-playhead"
        style={{ left: xForTime(currentTime) }}
        aria-hidden="true"
      />
    </div>
  )
}
