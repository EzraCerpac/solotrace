import { Icon } from './Icon'
import { formatTime } from '../music'
import type { AssetRole } from '../types'

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
  variant?: 'edit' | 'play'
  track?: AssetRole
  availableTracks?: AssetRole[]
  onTrack?: (track: AssetRole) => void
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
  variant = 'edit',
  track,
  availableTracks = [],
  onTrack,
}: TransportProps) {
  return (
    <footer
      className={`transport ${variant === 'play' ? 'play-transport' : ''}`}
      aria-label="Playback controls"
    >
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
        {variant === 'play' && track && onTrack && (
          <div className="transport-track-switcher" aria-label="Audio source">
            {(
              [
                ['original', 'Full track', 'Full'],
                ['lead', 'Lead only', 'Lead'],
                ['backing', 'Backing track', 'Backing'],
              ] as Array<[AssetRole, string, string]>
            ).map(([role, label, shortLabel]) => (
              <button
                key={role}
                type="button"
                className={track === role ? 'active' : ''}
                disabled={!availableTracks.includes(role)}
                aria-label={label}
                aria-pressed={track === role}
                onClick={() => onTrack(role)}
              >
                <span className="wide-track-label">{label}</span>
                <span className="short-track-label">{shortLabel}</span>
              </button>
            ))}
          </div>
        )}
        <button
          className={`transport-option ${loop ? 'active' : ''}`}
          type="button"
          aria-label={`Loop ${formatTime(loopStart)} to ${formatTime(loopEnd)}`}
          aria-pressed={loop}
          onClick={() => onLoop(!loop)}
        >
          <Icon name="loop" />
          <span className="loop-label">
            Loop {formatTime(loopStart)}–{formatTime(loopEnd)}
          </span>
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
        {variant === 'edit' && <span className="pitch-note">Pitch preserved</span>}
      </div>
    </footer>
  )
}
