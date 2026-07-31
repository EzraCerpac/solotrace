import { useEffect, useState, type FormEvent } from 'react'

import {
  CHORD_QUALITIES,
  formatChordSymbol,
  type ChordEvent,
  type ChordQuality,
} from '@solotrace/editor'
import { Icon } from './Icon'

interface ChordInspectorProps {
  chord: ChordEvent
  index: number
  chordCount: number
  saving: boolean
  onClose: () => void
  onSave: (symbol: string, startSeconds: number, endSeconds: number) => void
  onAccept: () => void
  onReopen: () => void
  onAudition: () => void
  onSplit: () => void
  onMerge: (direction: 'left' | 'right') => void
  onDelete: () => void
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

function spelledPitch(pitch: NonNullable<ChordEvent['root']>): string {
  const accidental = ({ [-2]: 'bb', [-1]: 'b', [0]: '', [1]: '#', [2]: '##' } as Record<
    number,
    string
  >)[pitch.alter]
  return `${pitch.step}${accidental ?? ''}`
}

export function ChordInspector({
  chord,
  index,
  chordCount,
  saving,
  onClose,
  onSave,
  onAccept,
  onReopen,
  onAudition,
  onSplit,
  onMerge,
  onDelete,
}: ChordInspectorProps) {
  const [symbol, setSymbol] = useState(formatChordSymbol(chord))
  const [start, setStart] = useState(chord.audio_onset_s)
  const [end, setEnd] = useState(chord.audio_offset_s)

  useEffect(() => {
    setSymbol(formatChordSymbol(chord))
    setStart(chord.audio_onset_s)
    setEnd(chord.audio_offset_s)
  }, [chord])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSave(symbol, start, end)
  }

  const root = chord.root ? spelledPitch(chord.root) : 'C'
  const bass = chord.bass ? `/${spelledPitch(chord.bass)}` : ''

  return (
    <aside className="note-inspector chord-inspector" aria-label="Selected chord">
      <div className="inspector-heading">
        <div>
          <p className="eyebrow">Selected chord</p>
          <h2>{formatChordSymbol(chord)}</h2>
        </div>
        <button className="icon-button" type="button" aria-label="Close chord editor" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <button type="button" className="audition-button" onClick={onAudition}>
        <Icon name="play" />
        Hear in context
      </button>
      <p className="review-reason">
        {chord.reviewed
          ? 'Reviewed'
          : chord.model_score === null
            ? 'Manual chord awaiting review'
            : `Check chord match · ${Math.round(chord.model_score * 100)}% confidence`}
      </p>
      <div className="review-action-bar">
        {chord.reviewed ? (
          <button type="button" className="button secondary" disabled={saving} onClick={onReopen}>
            Reopen review
          </button>
        ) : (
          <button type="button" className="button primary" disabled={saving} onClick={onAccept}>
            <Icon name="check" />
            Accept
          </button>
        )}
        <button className="button secondary" type="submit" form="chord-editor-form" disabled={saving}>
          <Icon name="save" />
          Save changes
        </button>
      </div>
      <form id="chord-editor-form" onSubmit={submit}>
        <fieldset>
          <legend>Symbol</legend>
          <label>
            Chord symbol
            <input value={symbol} disabled={saving} onChange={(event) => setSymbol(event.target.value)} />
          </label>
          <div className="field-pair">
            <label>
              Root
              <select
                disabled={saving}
                value={chord.kind === 'chord' ? root : chord.kind}
                onChange={(event) => {
                  if (event.target.value === 'no-chord') setSymbol('N.C.')
                  else if (event.target.value === 'unknown') setSymbol('X')
                  else {
                    setSymbol(
                      `${event.target.value}${QUALITY_SUFFIX[chord.quality ?? 'maj']}${bass}`,
                    )
                  }
                }}
              >
                {['C', 'C#', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'].map(
                  (name) => <option key={name}>{name}</option>,
                )}
                <option value="no-chord">N.C.</option>
                <option value="unknown">Unknown</option>
              </select>
            </label>
            <label>
              Quality
              <select
                disabled={saving || chord.kind !== 'chord'}
                value={chord.quality ?? 'maj'}
                onChange={(event) => {
                  const quality = event.target.value as ChordQuality
                  setSymbol(`${root}${QUALITY_SUFFIX[quality]}${bass}`)
                }}
              >
                {CHORD_QUALITIES.map((quality) => <option key={quality}>{quality}</option>)}
              </select>
            </label>
          </div>
        </fieldset>
        {chord.alternatives.length > 0 && (
          <fieldset>
            <legend>Model alternatives</legend>
            <div className="alternative-grid chord-alternatives">
              {chord.alternatives.map((alternative, alternativeIndex) => {
                const candidate = { ...chord, ...alternative, bass: null }
                return (
                  <button
                    type="button"
                    key={`${formatChordSymbol(candidate)}-${alternativeIndex}`}
                    disabled={saving}
                    onClick={() => setSymbol(formatChordSymbol(candidate))}
                  >
                    <strong>{formatChordSymbol(candidate)}</strong>
                    <span>{Math.round(alternative.model_score * 100)} score</span>
                  </button>
                )
              })}
            </div>
          </fieldset>
        )}
        <fieldset>
          <legend>Exact timing</legend>
          <div className="field-pair">
            <label>
              Starts
              <input
                type="number"
                step="0.001"
                value={Number(start.toFixed(3))}
                disabled={saving || index === 0}
                onChange={(event) => setStart(Number(event.target.value))}
              />
            </label>
            <label>
              Ends
              <input
                type="number"
                step="0.001"
                value={Number(end.toFixed(3))}
                disabled={saving || index === chordCount - 1}
                onChange={(event) => setEnd(Number(event.target.value))}
              />
            </label>
          </div>
          <p className="model-score">
            {chord.model_score === null
              ? 'Manual chord'
              : `${Math.round(chord.model_score * 100)} model score`}
          </p>
        </fieldset>
        <fieldset>
          <legend>Boundaries</legend>
          <div className="inspector-button-grid">
            <button type="button" disabled={saving} onClick={onSplit}>Split at playhead</button>
            <button type="button" disabled={saving || index === 0} onClick={() => onMerge('left')}>Merge left</button>
            <button type="button" disabled={saving || index === chordCount - 1} onClick={() => onMerge('right')}>Merge right</button>
            <button type="button" disabled={saving} onClick={onDelete}>Set unknown</button>
          </div>
        </fieldset>
      </form>
    </aside>
  )
}
