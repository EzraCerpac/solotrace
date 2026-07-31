import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

export interface BeatMapEditorAnchor {
  audio_frame: number
  score_tick: number
}

export interface BeatMapEditorValue {
  tempo_bpm: number
  time_signature: [number, number]
  bar_offset_ticks: number
  sync_anchors: BeatMapEditorAnchor[]
}

export interface BeatMapEditorProps {
  value: BeatMapEditorValue
  versionName: string
  duration: number
  sampleRate: number
  ticksPerQuarter: number
  peaks: number[]
  currentTime: number
  isPlaying: boolean
  noteOnsets?: number[]
  tabPreview?: ReactNode
  dirty?: boolean
  saving?: boolean
  error?: string | null
  clickPreviewEnabled?: boolean
  onChange: (value: BeatMapEditorValue) => void
  onSeek?: (seconds: number) => void
  onClickPreviewChange?: (enabled: boolean) => void
  onApply: (value: BeatMapEditorValue) => void
  onCancel: () => void
}

interface DragState {
  pointerId: number
  anchorIndex: number
}

interface BeatLine {
  scoreTick: number
  frame: number
  bar: boolean
  barNumber: number
}

const waveformHeight = 176
const baseWaveformWidth = 960
const supportedMeters = [
  [4, 4],
  [3, 4],
  [6, 8],
] as const

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor
}

function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, seconds)
  const minutes = Math.floor(safeSeconds / 60)
  const remainder = Math.floor(safeSeconds % 60)
  const milliseconds = Math.round((safeSeconds % 1) * 1000)
  return `${minutes}:${String(remainder).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`
}

function sortedAnchors(anchors: BeatMapEditorAnchor[]) {
  return [...anchors].sort(
    (left, right) => left.score_tick - right.score_tick,
  )
}

function segmentForFrame(frame: number, anchors: BeatMapEditorAnchor[]) {
  for (let index = 0; index < anchors.length - 1; index += 1) {
    if (frame <= anchors[index + 1].audio_frame) return index
  }
  return Math.max(0, anchors.length - 2)
}

function segmentForTick(tick: number, anchors: BeatMapEditorAnchor[]) {
  for (let index = 0; index < anchors.length - 1; index += 1) {
    if (tick <= anchors[index + 1].score_tick) return index
  }
  return Math.max(0, anchors.length - 2)
}

function interpolate(
  value: number,
  inputStart: number,
  inputEnd: number,
  outputStart: number,
  outputEnd: number,
) {
  if (inputEnd === inputStart) return outputStart
  const progress = (value - inputStart) / (inputEnd - inputStart)
  return outputStart + progress * (outputEnd - outputStart)
}

function frameToScoreTick(frame: number, anchors: BeatMapEditorAnchor[]) {
  if (anchors.length < 2) return 0
  const index = segmentForFrame(frame, anchors)
  const left = anchors[index]
  const right = anchors[index + 1]
  return interpolate(
    frame,
    left.audio_frame,
    right.audio_frame,
    left.score_tick,
    right.score_tick,
  )
}

function scoreTickToFrame(tick: number, anchors: BeatMapEditorAnchor[]) {
  if (anchors.length < 2) return 0
  const index = segmentForTick(tick, anchors)
  const left = anchors[index]
  const right = anchors[index + 1]
  return interpolate(
    tick,
    left.score_tick,
    right.score_tick,
    left.audio_frame,
    right.audio_frame,
  )
}

function beatTicksFor(
  ticksPerQuarter: number,
  timeSignature: [number, number],
) {
  return (ticksPerQuarter * 4) / timeSignature[1]
}

function validateBeatMap(
  value: BeatMapEditorValue,
  ticksPerQuarter: number,
) {
  const issues: string[] = []
  const [beats, beatType] = value.time_signature
  const beatTicks = beatTicksFor(ticksPerQuarter, value.time_signature)
  const measureTicks = beats * beatTicks

  if (!Number.isFinite(value.tempo_bpm) || value.tempo_bpm < 20 || value.tempo_bpm > 400) {
    issues.push('Tempo must be between 20 and 400 BPM.')
  }
  if (
    !Number.isInteger(beats) ||
    beats < 1 ||
    beats > 32 ||
    !Number.isInteger(beatType) ||
    ![2, 4, 8, 16].includes(beatType) ||
    !Number.isInteger(beatTicks)
  ) {
    issues.push('Meter must divide the score into whole ticks.')
  }
  if (
    !Number.isInteger(value.bar_offset_ticks) ||
    value.bar_offset_ticks < 0 ||
    value.bar_offset_ticks >= measureTicks
  ) {
    issues.push('Bar 1 downbeat must fall within the opening measure.')
  }
  if (value.sync_anchors.length < 2 || value.sync_anchors.length > 5_000) {
    issues.push('Beat map needs between 2 and 5,000 sync pins.')
  }
  for (let index = 1; index < value.sync_anchors.length; index += 1) {
    const previous = value.sync_anchors[index - 1]
    const current = value.sync_anchors[index]
    if (
      current.audio_frame <= previous.audio_frame ||
      current.score_tick <= previous.score_tick
    ) {
      issues.push('Sync pins must move forward in both audio and score time.')
      break
    }
  }
  return issues
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'BUTTON'
  )
}

export function BeatMapEditor({
  value,
  versionName,
  duration,
  sampleRate,
  ticksPerQuarter,
  peaks,
  currentTime,
  isPlaying,
  noteOnsets = [],
  tabPreview,
  dirty = true,
  saving = false,
  error = null,
  clickPreviewEnabled = false,
  onChange,
  onSeek = () => undefined,
  onClickPreviewChange = () => undefined,
  onApply,
  onCancel,
}: BeatMapEditorProps) {
  const [zoom, setZoom] = useState(1)
  const [selectedPin, setSelectedPin] = useState<number | null>(null)
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [tapTimes, setTapTimes] = useState<number[]>([])
  const [interactionError, setInteractionError] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value

  const anchors = useMemo(
    () => sortedAnchors(value.sync_anchors),
    [value.sync_anchors],
  )
  const waveformWidth = Math.round(baseWaveformWidth * zoom)
  const beatTicks = beatTicksFor(ticksPerQuarter, value.time_signature)
  const measureTicks = value.time_signature[0] * beatTicks
  const validationIssues = useMemo(
    () => validateBeatMap(value, ticksPerQuarter),
    [ticksPerQuarter, value],
  )
  const customMeter = !supportedMeters.some(
    ([beats, beatType]) =>
      beats === value.time_signature[0] && beatType === value.time_signature[1],
  )

  const beatLines = useMemo<BeatLine[]>(() => {
    if (anchors.length < 2 || !Number.isInteger(beatTicks) || beatTicks <= 0) {
      return []
    }
    const firstTick = anchors[0].score_tick
    const lastTick = anchors[anchors.length - 1].score_tick
    const firstBeat =
      value.bar_offset_ticks +
      Math.ceil((firstTick - value.bar_offset_ticks) / beatTicks) * beatTicks
    const lineCount = Math.floor((lastTick - firstBeat) / beatTicks) + 1
    const stride = Math.max(1, Math.ceil(lineCount / 5_000))
    const output: BeatLine[] = []
    for (
      let tick = firstBeat;
      tick <= lastTick;
      tick += beatTicks * stride
    ) {
      const offset = positiveModulo(tick - value.bar_offset_ticks, measureTicks)
      const bar = Math.abs(offset) < 0.001
      output.push({
        scoreTick: Math.round(tick),
        frame: scoreTickToFrame(tick, anchors),
        bar,
        barNumber: Math.floor((tick - value.bar_offset_ticks) / measureTicks) + 1,
      })
    }
    return output
  }, [anchors, beatTicks, measureTicks, value.bar_offset_ticks])

  const waveformPath = useMemo(() => {
    if (!peaks.length) return `M 0 ${waveformHeight / 2} H ${waveformWidth}`
    const maximum = Math.max(0.001, ...peaks.map((peak) => Math.abs(peak)))
    const step = waveformWidth / Math.max(1, peaks.length - 1)
    return peaks
      .map((peak, index) => {
        const x = index * step
        const amplitude = (Math.abs(peak) / maximum) * 63
        return `M ${x.toFixed(2)} ${(waveformHeight / 2 - amplitude).toFixed(2)} V ${(waveformHeight / 2 + amplitude).toFixed(2)}`
      })
      .join(' ')
  }, [peaks, waveformWidth])

  const xForFrame = (frame: number) =>
    clamp(frame / Math.max(1, duration * sampleRate), 0, 1) * waveformWidth

  const frameForPointer = (clientX: number) => {
    const bounds = svgRef.current?.getBoundingClientRect()
    if (!bounds || bounds.width <= 0) return 0
    const progress = clamp((clientX - bounds.left) / bounds.width, 0, 1)
    return Math.round(progress * duration * sampleRate)
  }

  const setMap = (nextValue: BeatMapEditorValue) => {
    setInteractionError(null)
    valueRef.current = nextValue
    onChange(nextValue)
  }

  const replaceAnchorFrame = (index: number, requestedFrame: number) => {
    const current = sortedAnchors(valueRef.current.sync_anchors)
    if (index <= 0 || index >= current.length - 1) return
    const minimum = current[index - 1].audio_frame + 1
    const maximum = current[index + 1].audio_frame - 1
    if (minimum > maximum) {
      setInteractionError('This pin has no room to move between its neighbors.')
      return
    }
    current[index] = {
      ...current[index],
      audio_frame: clamp(Math.round(requestedFrame), minimum, maximum),
    }
    setMap({ ...valueRef.current, sync_anchors: current })
  }

  const removeAnchor = (index: number) => {
    const current = sortedAnchors(valueRef.current.sync_anchors)
    if (index <= 0 || index >= current.length - 1) return
    current.splice(index, 1)
    setSelectedPin(Math.min(index, current.length - 2))
    setMap({ ...valueRef.current, sync_anchors: current })
  }

  const promoteBeat = (line: BeatLine) => {
    const current = sortedAnchors(valueRef.current.sync_anchors)
    const existingIndex = current.findIndex(
      (anchor) => anchor.score_tick === line.scoreTick,
    )
    if (existingIndex >= 0) {
      setSelectedPin(existingIndex)
      return existingIndex
    }
    if (current.length >= 5_000) {
      setInteractionError('Maximum of 5,000 sync pins reached. Remove a pin first.')
      return null
    }
    const next = [
      ...current,
      { audio_frame: Math.round(line.frame), score_tick: line.scoreTick },
    ].sort((left, right) => left.score_tick - right.score_tick)
    const nextIndex = next.findIndex((anchor) => anchor.score_tick === line.scoreTick)
    setSelectedPin(nextIndex)
    setMap({ ...valueRef.current, sync_anchors: next })
    return nextIndex
  }

  const addPinAtPlayhead = () => {
    if (
      saving ||
      !isPlaying ||
      anchors.length < 2 ||
      !Number.isFinite(beatTicks) ||
      beatTicks <= 0
    ) return
    const frame = Math.round(clamp(currentTime, 0, duration) * sampleRate)
    const currentTick = frameToScoreTick(frame, anchors)
    const nearestTick =
      value.bar_offset_ticks +
      Math.round((currentTick - value.bar_offset_ticks) / beatTicks) * beatTicks
    const line: BeatLine = {
      scoreTick: Math.round(nearestTick),
      frame,
      bar: Math.abs(
        positiveModulo(nearestTick - value.bar_offset_ticks, measureTicks),
      ) < 0.001,
      barNumber:
        Math.floor((nearestTick - value.bar_offset_ticks) / measureTicks) + 1,
    }
    const existingIndex = anchors.findIndex(
      (anchor) => anchor.score_tick === line.scoreTick,
    )
    if (existingIndex >= 0) {
      setSelectedPin(existingIndex)
      replaceAnchorFrame(existingIndex, frame)
    } else {
      promoteBeat(line)
    }
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 't' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target)
      ) {
        return
      }
      if (isPlaying) {
        event.preventDefault()
        addPinAtPlayhead()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  useEffect(() => {
    if (selectedPin !== null && selectedPin >= anchors.length) {
      setSelectedPin(anchors.length ? anchors.length - 1 : null)
    }
  }, [anchors.length, selectedPin])

  const handlePinKeyDown = (
    event: ReactKeyboardEvent<SVGGElement>,
    index: number,
  ) => {
    if (saving) return
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (index > 0 && index < anchors.length - 1) {
        event.preventDefault()
        removeAnchor(index)
      }
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    if (index <= 0 || index >= anchors.length - 1) return
    event.preventDefault()
    const milliseconds = event.shiftKey ? 25 : 5
    const direction = event.key === 'ArrowLeft' ? -1 : 1
    replaceAnchorFrame(
      index,
      anchors[index].audio_frame +
        direction * Math.round((milliseconds / 1_000) * sampleRate),
    )
  }

  const startDrag = (
    event: ReactPointerEvent<SVGElement>,
    anchorIndex: number,
  ) => {
    const current = sortedAnchors(valueRef.current.sync_anchors)
    if (anchorIndex <= 0 || anchorIndex >= current.length - 1 || saving) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setSelectedPin(anchorIndex)
    setDragState({ pointerId: event.pointerId, anchorIndex })
  }

  const continueDrag = (event: ReactPointerEvent<SVGElement>) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return
    replaceAnchorFrame(dragState.anchorIndex, frameForPointer(event.clientX))
  }

  const stopDrag = (event: ReactPointerEvent<SVGElement>) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragState(null)
  }

  const setMeter = (beats: number, beatType: number) => {
    const nextBeatTicks = (ticksPerQuarter * 4) / beatType
    const nextMeasureTicks = Math.max(1, beats * nextBeatTicks)
    setMap({
      ...valueRef.current,
      time_signature: [beats, beatType],
      bar_offset_ticks: clamp(
        valueRef.current.bar_offset_ticks,
        0,
        Math.max(0, Math.floor(nextMeasureTicks) - 1),
      ),
    })
  }

  const tapTempo = () => {
    const now = performance.now()
    const recent =
      tapTimes.length && now - tapTimes[tapTimes.length - 1] <= 2_000
        ? [...tapTimes, now].slice(-8)
        : [now]
    setTapTimes(recent)
    if (recent.length < 4) return
    const intervals = recent
      .slice(1)
      .map((time, index) => time - recent[index])
    const average = intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length
    const tempo = clamp(Math.round(60_000 / average), 20, 400)
    setMap({ ...valueRef.current, tempo_bpm: tempo })
  }

  const rebuildSteadyGrid = () => {
    const current = sortedAnchors(valueRef.current.sync_anchors)
    if (current.length < 2) {
      setInteractionError('Two boundary pins are required before rebuilding the grid.')
      return
    }
    const first = current[0]
    const last = current[current.length - 1]
    const durationSeconds = (last.audio_frame - first.audio_frame) / sampleRate
    const tickLength =
      durationSeconds *
      (valueRef.current.tempo_bpm / 60) *
      ticksPerQuarter
    setSelectedPin(null)
    setMap({
      ...valueRef.current,
      sync_anchors: [
        first,
        {
          audio_frame: last.audio_frame,
          score_tick: first.score_tick + Math.max(1, Math.round(tickLength)),
        },
      ],
    })
  }

  const setDownbeatAtPlayhead = () => {
    if (
      anchors.length < 2 ||
      !Number.isFinite(beatTicks) ||
      beatTicks <= 0 ||
      !Number.isFinite(measureTicks) ||
      measureTicks <= 0
    ) return
    const playheadFrame = clamp(currentTime, 0, duration) * sampleRate
    const currentTick = frameToScoreTick(playheadFrame, anchors)
    const snappedTick = Math.round(currentTick / beatTicks) * beatTicks
    setMap({
      ...valueRef.current,
      bar_offset_ticks: Math.round(positiveModulo(snappedTick, measureTicks)),
    })
  }

  const firstAnchorFrame = anchors[0]?.audio_frame ?? 0
  const lastAnchorFrame = anchors[anchors.length - 1]?.audio_frame ?? duration * sampleRate

  return (
    <section
      className="beat-map-editor"
      aria-labelledby="beat-map-heading"
      aria-keyshortcuts="T"
    >
      <header className="beat-map-editor__header">
        <div>
          <p className="eyebrow">Editing timing for {versionName}</p>
          <h2 id="beat-map-heading">Beat Map</h2>
          <p className="beat-map-editor__intro">
            Line up beats with the recording. Notes keep their original audio timing.
          </p>
        </div>
        <div className="beat-map-editor__actions">
          <button
            type="button"
            className="button secondary"
            disabled={saving}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            disabled={saving || !dirty || validationIssues.length > 0}
            onClick={() => onApply(valueRef.current)}
          >
            {saving ? 'Applying…' : 'Apply timing'}
          </button>
        </div>
      </header>

      {(error || interactionError || validationIssues.length > 0) && (
        <div className="beat-map-editor__error" role="alert">
          {error && <p>{error}</p>}
          {interactionError && <p>{interactionError}</p>}
          {validationIssues.map((issue) => <p key={issue}>{issue}</p>)}
        </div>
      )}

      <div className="beat-map-editor__workspace">
        <div className="beat-map-editor__timeline-header">
          <div>
            <strong>Timing workspace</strong>
            <span aria-live="polite">
              {anchors.length.toLocaleString()} sync pins
              {selectedPin === null ? '' : ` · pin ${selectedPin + 1} selected`}
            </span>
          </div>
          <label className="beat-map-editor__zoom">
            Zoom
            <input
              type="range"
              min="1"
              max="12"
              step="0.25"
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
            />
            <output>{zoom.toFixed(2)}×</output>
          </label>
        </div>

        <div className="beat-map-editor__waveform-scroll">
          <div className="beat-map-editor__ruler" style={{ width: waveformWidth }}>
            <span>{formatTime(firstAnchorFrame / sampleRate)}</span>
            <span>Drag a beat line to add a pin · Arrow keys nudge · T pins while playing</span>
            <span>{formatTime(lastAnchorFrame / sampleRate)}</span>
          </div>
          <svg
            ref={svgRef}
            className="beat-map-editor__waveform"
            role="group"
            aria-roledescription="waveform editor"
            aria-label={`Waveform with ${beatLines.length} beat lines and ${anchors.length} sync pins`}
            viewBox={`0 0 ${waveformWidth} ${waveformHeight}`}
            width={waveformWidth}
            height={waveformHeight}
            onDoubleClick={(event) => {
              const frame = frameForPointer(event.clientX)
              onSeek(frame / sampleRate)
            }}
          >
            <rect
              className="beat-map-editor__waveform-background"
              width={waveformWidth}
              height={waveformHeight}
            />
            <path
              className="beat-map-editor__waveform-peaks"
              d={waveformPath}
            />
            {beatLines.map((line) => {
              const x = xForFrame(line.frame)
              return (
                <g key={line.scoreTick} className="beat-map-editor__beat">
                  <line
                    className="beat-map-editor__beat-hit-target"
                    x1={x}
                    x2={x}
                    y1={18}
                    y2={waveformHeight}
                    stroke="transparent"
                    strokeWidth={18}
                    style={{ touchAction: 'none' }}
                    onPointerDown={(event) => {
                      if (saving) return
                      const index = promoteBeat(line)
                      if (index !== null) startDrag(event, index)
                    }}
                    onPointerMove={continueDrag}
                    onPointerUp={stopDrag}
                    onPointerCancel={stopDrag}
                  />
                  <line
                    className={line.bar ? 'beat-map-editor__barline' : 'beat-map-editor__beatline'}
                    x1={x}
                    x2={x}
                    y1={line.bar ? 18 : 30}
                    y2={waveformHeight}
                    pointerEvents="none"
                  />
                  {line.bar && (
                    <text
                      className="beat-map-editor__bar-label"
                      x={x + 5}
                      y={14}
                    >
                      {line.barNumber <= 0 ? 'Pickup' : `Bar ${line.barNumber}`}
                    </text>
                  )}
                </g>
              )
            })}
            {noteOnsets.map((seconds, index) => (
              <line
                key={`${seconds}-${index}`}
                className="beat-map-editor__note-onset"
                x1={xForFrame(seconds * sampleRate)}
                x2={xForFrame(seconds * sampleRate)}
                y1={waveformHeight - 18}
                y2={waveformHeight}
              />
            ))}
            {anchors.map((anchor, index) => {
              const boundary = index === 0 || index === anchors.length - 1
              const x = xForFrame(anchor.audio_frame)
              return (
                <g
                  key={`${anchor.score_tick}-${index}`}
                  className={[
                    'beat-map-editor__pin',
                    boundary ? 'beat-map-editor__pin--locked' : '',
                    selectedPin === index ? 'beat-map-editor__pin--selected' : '',
                  ].filter(Boolean).join(' ')}
                  role="button"
                  tabIndex={0}
                  aria-label={`${boundary ? 'Locked boundary' : 'Sync'} pin ${index + 1}, ${formatTime(anchor.audio_frame / sampleRate)}`}
                  aria-pressed={selectedPin === index}
                  onFocus={() => setSelectedPin(index)}
                  onKeyDown={(event) => handlePinKeyDown(event, index)}
                  onPointerDown={(event) => {
                    setSelectedPin(index)
                    startDrag(event, index)
                  }}
                  onPointerMove={continueDrag}
                  onPointerUp={stopDrag}
                  onPointerCancel={stopDrag}
                >
                  <rect
                    x={x - 22}
                    y={0}
                    width={44}
                    height={48}
                    fill="transparent"
                    style={{ touchAction: 'none' }}
                  />
                  <line x1={x} x2={x} y1={20} y2={waveformHeight} />
                  <path d={`M ${x - 7} 20 L ${x + 7} 20 L ${x} 32 Z`} />
                  {boundary && <title>Boundary pin is locked</title>}
                </g>
              )
            })}
            <line
              className="beat-map-editor__playhead"
              x1={xForFrame(currentTime * sampleRate)}
              x2={xForFrame(currentTime * sampleRate)}
              y1={0}
              y2={waveformHeight}
            />
          </svg>
        </div>
      </div>

      <div className="beat-map-editor__control-grid">
        <fieldset className="beat-map-editor__control-card">
          <legend>Tempo and grid</legend>
          <label>
            Quarter-note tempo
            <span className="beat-map-editor__number-with-unit">
              <input
                type="number"
                min="20"
                max="400"
                step="0.1"
                disabled={saving}
                value={value.tempo_bpm}
                onChange={(event) => setMap({
                  ...valueRef.current,
                  tempo_bpm: Number(event.target.value),
                })}
              />
              <span>BPM</span>
            </span>
          </label>
          <div className="beat-map-editor__inline-actions">
            <button
              type="button"
              className="button secondary"
              disabled={saving}
              onClick={tapTempo}
            >
              Tap tempo
            </button>
            <span aria-live="polite">
              {tapTimes.length < 4
                ? `${tapTimes.length}/4 taps`
                : `${value.tempo_bpm} BPM from ${tapTimes.length} taps`}
            </span>
          </div>
          <button
            type="button"
            className="button secondary"
            disabled={saving || validationIssues.some((issue) => issue.startsWith('Tempo'))}
            onClick={rebuildSteadyGrid}
          >
            Rebuild steady grid
          </button>
          <p className="beat-map-editor__hint">
            Rebuild removes interior pins and keeps both locked boundaries.
          </p>
        </fieldset>

        <fieldset className="beat-map-editor__control-card">
          <legend>Meter</legend>
          <div className="beat-map-editor__segmented" aria-label="Time signature presets">
            {supportedMeters.map(([beats, beatType]) => (
              <button
                key={`${beats}/${beatType}`}
                type="button"
                className={
                  value.time_signature[0] === beats && value.time_signature[1] === beatType
                    ? 'active'
                    : ''
                }
                aria-pressed={
                  value.time_signature[0] === beats && value.time_signature[1] === beatType
                }
                disabled={saving}
                onClick={() => setMeter(beats, beatType)}
              >
                {beats}/{beatType}
              </button>
            ))}
            <button
              type="button"
              className={customMeter ? 'active' : ''}
              aria-pressed={customMeter}
              disabled={saving}
              onClick={() => {
                if (!customMeter) setMeter(5, 4)
              }}
            >
              Other
            </button>
          </div>
          {customMeter && (
            <div className="beat-map-editor__meter-fields">
              <label>
                Beats
                <input
                  type="number"
                  min="1"
                  max="32"
                  step="1"
                  disabled={saving}
                  value={value.time_signature[0]}
                  onChange={(event) => setMeter(
                    Number(event.target.value),
                    valueRef.current.time_signature[1],
                  )}
                />
              </label>
              <label>
                Beat unit
                <select
                  disabled={saving}
                  value={value.time_signature[1]}
                  onChange={(event) => setMeter(
                    valueRef.current.time_signature[0],
                    Number(event.target.value),
                  )}
                >
                  {[2, 4, 8, 16].map((beatType) => (
                    <option key={beatType} value={beatType}>{beatType}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <p className="beat-map-editor__hint">
            6/8 click preview pulses dotted quarters; stored tempo remains quarter-note BPM.
          </p>
        </fieldset>

        <fieldset className="beat-map-editor__control-card">
          <legend>Pickup and preview</legend>
          <p>
            {value.bar_offset_ticks === 0
              ? 'Song begins on bar 1.'
              : `Pickup before bar 1: ${value.bar_offset_ticks} score ticks.`}
          </p>
          <button
            type="button"
            className="button secondary"
            disabled={saving}
            onClick={setDownbeatAtPlayhead}
          >
            Set bar 1 at playhead
          </button>
          <label className="beat-map-editor__switch">
            <input
              type="checkbox"
              role="switch"
              checked={clickPreviewEnabled}
              disabled={saving}
              onChange={(event) => onClickPreviewChange(event.target.checked)}
            />
            Click preview
          </label>
          <p className="beat-map-editor__hint">
            Downbeats sound accented. Playback and track selection stay unchanged.
          </p>
        </fieldset>
      </div>

      <section
        className="beat-map-editor__tab-preview"
        aria-labelledby="beat-map-tab-preview-heading"
      >
        <div>
          <p className="eyebrow">Read-only preview</p>
          <h3 id="beat-map-tab-preview-heading">Tab after timing changes</h3>
        </div>
        {tabPreview ?? (
          <p className="beat-map-editor__empty-preview">
            Tablature preview unavailable. Timing changes remain staged.
          </p>
        )}
      </section>
    </section>
  )
}
