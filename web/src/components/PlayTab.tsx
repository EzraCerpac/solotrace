import { useEffect, useMemo, useRef, useState } from 'react'

import { formatTime, pitchName } from '../music'
import {
  buildPlaySystems,
  PLAY_SIDE,
  timeForSystemX,
  type PlayRestSystem,
  type PlayTabSystem,
} from '../tab-layout'
import type { Project } from '../types'
import { TablatureStaff } from './TablatureStaff'
import { HarmonyLane } from './HarmonyLane'

interface PlayTabProps {
  project: Project
  currentTime: number
  playing: boolean
  onSeek: (seconds: number) => void
}

function xForMeasureTime(
  system: PlayTabSystem,
  seconds: number,
): number {
  const measure =
    system.measures.find(
      (candidate) => seconds >= candidate.start_s && seconds <= candidate.end_s,
    ) ??
    (seconds < system.start_s ? system.measures[0] : system.measures.at(-1)!)
  const duration = Math.max(0.001, measure.end_s - measure.start_s)
  const progress = Math.max(0, Math.min(1, (seconds - measure.start_s) / duration))
  return measure.x + progress * measure.width
}

function RestSystem({
  system,
  currentTime,
  active,
  onSeek,
  bindRef,
}: {
  system: PlayRestSystem
  currentTime: number
  active: boolean
  onSeek: (seconds: number) => void
  bindRef: (node: HTMLButtonElement | null) => void
}) {
  const innerWidth = system.width - PLAY_SIDE * 2
  const duration = Math.max(0.01, system.end_s - system.start_s)
  const progress = Math.max(0, Math.min(1, (currentTime - system.start_s) / duration))
  const playheadX = PLAY_SIDE + progress * innerWidth
  const bars =
    system.measure_count === 1
      ? `Bar ${system.start_bar}`
      : `Bars ${system.start_bar}–${system.end_bar}`

  return (
    <button
      ref={bindRef}
      className={`play-rest-system ${active ? 'active' : ''}`}
      type="button"
      aria-label={`${bars}, no tabbed notes, ${formatTime(system.start_s)} to ${formatTime(system.end_s)}. Jump to this region.`}
      onClick={(event) => {
        if (event.detail === 0) {
          onSeek(system.start_s)
          return
        }
        const bounds = event.currentTarget.getBoundingClientRect()
        const localX = Math.max(
          0,
          Math.min(bounds.width, event.clientX - bounds.left),
        )
        onSeek(system.start_s + (localX / Math.max(1, bounds.width)) * duration)
      }}
    >
      <svg
        width={system.width}
        height="116"
        role="img"
        aria-label={`${bars}, no tabbed notes`}
      >
        <title>{`${bars}, no tabbed notes`}</title>
        <text className="rest-system-bars" x={PLAY_SIDE} y="24">
          {bars}
        </text>
        <text className="rest-system-time" x={system.width - PLAY_SIDE} y="24" textAnchor="end">
          {formatTime(system.start_s)}–{formatTime(system.end_s)}
        </text>
        <line
          className="rest-system-line"
          x1={PLAY_SIDE}
          x2={system.width - PLAY_SIDE}
          y1="72"
          y2="72"
        />
        <line
          className="rest-system-block"
          x1={system.width / 2 - 42}
          x2={system.width / 2 + 42}
          y1="72"
          y2="72"
        />
        <line
          className="rest-system-cap"
          x1={system.width / 2 - 42}
          x2={system.width / 2 - 42}
          y1="62"
          y2="82"
        />
        <line
          className="rest-system-cap"
          x1={system.width / 2 + 42}
          x2={system.width / 2 + 42}
          y1="62"
          y2="82"
        />
        <text className="rest-system-count" x={system.width / 2} y="55" textAnchor="middle">
          {system.measure_count}
        </text>
        <text className="rest-system-label" x={system.width / 2} y="103" textAnchor="middle">
          No tabbed notes
        </text>
        {active && (
          <line
            className="playhead"
            x1={playheadX}
            x2={playheadX}
            y1="34"
            y2="96"
          />
        )}
      </svg>
    </button>
  )
}

export function PlayTab({ project, currentTime, playing, onSeek }: PlayTabProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const systemRefs = useRef(new Map<string, HTMLElement>())
  const followedSystemRef = useRef<string | null>(null)
  const [containerWidth, setContainerWidth] = useState(960)
  const labels = useMemo(
    () => [...project.tab.tuning].reverse().map(pitchName),
    [project.tab.tuning],
  )
  const systems = useMemo(
    () => buildPlaySystems(project, containerWidth),
    [containerWidth, project],
  )
  const activeSystem =
    systems.find(
      (system, index) =>
        currentTime >= system.start_s &&
        (currentTime < system.end_s ||
          (index === systems.length - 1 && currentTime <= system.end_s)),
    ) ?? null

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const update = () => {
      const width = Math.max(320, Math.floor(container.clientWidth))
      setContainerWidth((current) => (current === width ? current : width))
    }
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!activeSystem) return
    if (!playing || followedSystemRef.current === null) {
      followedSystemRef.current = activeSystem.id
      return
    }
    if (followedSystemRef.current === activeSystem.id) return
    followedSystemRef.current = activeSystem.id
    const node = systemRefs.current.get(activeSystem.id)
    if (!node || typeof node.scrollIntoView !== 'function') return
    node.scrollIntoView({
      block: 'start',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    })
  }, [activeSystem, playing])

  return (
    <main className="play-sheet">
      <div className="play-sheet-heading">
        <div>
          <p className="eyebrow">Full-track tablature</p>
          <h2>{project.passage.name}</h2>
        </div>
        <p>Click any note, bar, or rest to jump.</p>
      </div>
      <div className="play-systems" ref={containerRef}>
        {systems.map((system) => {
          const active = activeSystem?.id === system.id
          if (system.kind === 'rest') {
            return (
              <div className="play-system-scroll" key={system.id}>
                <RestSystem
                  system={system}
                  currentTime={currentTime}
                  active={active}
                  onSeek={onSeek}
                  bindRef={(node) => {
                    if (node) systemRefs.current.set(system.id, node)
                    else systemRefs.current.delete(system.id)
                  }}
                />
              </div>
            )
          }

          const notes = system.measures.flatMap((measure) =>
            measure.notes.map((note) => ({
              note,
              x: xForMeasureTime(system, note.audio_onset_s),
              endX: xForMeasureTime(
                system,
                Math.min(system.end_s, note.audio_offset_s),
              ),
            })),
          )
          const rests = system.measures.flatMap((measure) =>
            measure.rests.map((rest) => ({
              id: rest.id,
              x: xForMeasureTime(system, (rest.start_s + rest.end_s) / 2),
              value: rest.value,
            })),
          )
          const playheadX = active ? xForMeasureTime(system, currentTime) : null
          return (
            <section
              key={system.id}
              ref={(node) => {
                if (node) systemRefs.current.set(system.id, node)
                else systemRefs.current.delete(system.id)
              }}
              className={`play-system ${active ? 'active' : ''}`}
              aria-label={`Tab ${system.measures[0].number} through ${system.measures.at(-1)!.number}`}
            >
              <div className="play-system-scroll">
                <div className="tab-timeline" style={{ width: system.width }}>
                  <HarmonyLane
                    width={system.width}
                    side={PLAY_SIDE}
                    passageStart={system.start_s}
                    passageEnd={system.end_s}
                    tempoBpm={project.tab.tempo_bpm}
                    beatType={project.tab.time_signature[1]}
                    chords={project.tab.chords.events}
                    currentTime={currentTime}
                    selectedChordId={null}
                    editable={false}
                    disabled={false}
                    onSelect={(chord) => onSeek(chord.audio_onset_s)}
                    onBoundaryMove={() => undefined}
                    onAddAtPlayhead={() => undefined}
                  />
                  <TablatureStaff
                  width={system.width}
                  labels={labels}
                  measures={system.measures.map((measure) => ({
                    number: measure.number,
                    x: measure.x,
                  }))}
                  notes={notes}
                  rests={rests}
                  currentTime={currentTime}
                  playheadX={playheadX}
                  ariaLabel={`${labels.length}-string read-only tablature for ${project.title}, bars ${system.measures[0].number} through ${system.measures.at(-1)!.number}`}
                  description="Click a note or anywhere on the staff to jump playback. Notes cannot be edited in Play mode."
                  onNoteActivate={(note) => onSeek(note.audio_onset_s)}
                  onBackgroundClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect()
                    const localX =
                      (event.clientX - bounds.left) *
                      (system.width / Math.max(1, bounds.width))
                    onSeek(timeForSystemX(system, localX))
                  }}
                  />
                </div>
              </div>
            </section>
          )
        })}
      </div>
    </main>
  )
}
