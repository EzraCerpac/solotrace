import { Icon } from './Icon'
import { formatTime } from '../music'

interface TransportProps {
  playing: boolean
  currentTime: number
  duration: number
  speed: number
  loop: boolean
  loopStart: number
  loopEnd: number
  onTogglePlay: () => void
  onSeek: (time: number) => void
  onSpeed: (speed: number) => void
  onLoop: (enabled: boolean) => void
}

export function Transport({
  playing,
  currentTime,
  duration,
  speed,
  loop,
  loopStart,
  loopEnd,
  onTogglePlay,
  onSeek,
  onSpeed,
  onLoop,
}: TransportProps) {
  return (
    <footer className="transport" aria-label="Playback controls">
      <div className="transport-main">
        <button
          className="transport-play"
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={onTogglePlay}
        >
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <code>{formatTime(currentTime, true)}</code>
        <input
          className="transport-range"
          type="range"
          aria-label="Song position"
          min="0"
          max={Math.max(duration, 0.01)}
          step="0.01"
          value={Math.min(currentTime, duration)}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
        <code className="transport-duration">{formatTime(duration, true)}</code>
      </div>
      <div className="transport-options">
        <button
          className={`transport-option ${loop ? 'active' : ''}`}
          type="button"
          aria-pressed={loop}
          onClick={() => onLoop(!loop)}
        >
          <Icon name="loop" />
          Loop {formatTime(loopStart)}–{formatTime(loopEnd)}
        </button>
        <label>
          Speed
          <select value={speed} onChange={(event) => onSpeed(Number(event.target.value))}>
            <option value={0.5}>0.50×</option>
            <option value={0.65}>0.65×</option>
            <option value={0.75}>0.75×</option>
            <option value={0.9}>0.90×</option>
            <option value={1}>1.00×</option>
          </select>
        </label>
        <span className="pitch-note">Pitch preserved</span>
      </div>
    </footer>
  )
}

