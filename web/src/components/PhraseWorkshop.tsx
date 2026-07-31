import { useEffect, useRef, useState } from 'react'

import type { FingeringMode } from '../types'
import { Icon } from './Icon'

export interface PhraseBar {
  number: number
  startScoreTick: number
  endScoreTick: number
  noteCount: number
}

export interface PhrasePreviewChange {
  noteId: string
  pitchLabel: string
  before: { string: number; fret: number }
  after: { string: number; fret: number }
}

export interface PhrasePreview {
  selectedNoteCount: number
  lockedNoteCount: number
  changes: readonly PhrasePreviewChange[]
  error?: string
}

interface PhraseWorkshopProps {
  bars: readonly PhraseBar[]
  startBar: number
  endBar: number
  mode: FingeringMode
  allowedStrings: readonly number[]
  stringCount: number
  fretCount: number
  minFret: number | null
  maxFret: number | null
  name: string
  preview: PhrasePreview | null
  saving: boolean
  onRangeChange: (startBar: number, endBar: number) => void
  onModeChange: (mode: FingeringMode) => void
  onAllowedStringsChange: (strings: number[]) => void
  onFretRangeChange: (minFret: number | null, maxFret: number | null) => void
  onNameChange: (name: string) => void
  onCancel: () => void
  onSave: () => void
}

const modeOptions: Array<{ value: FingeringMode; label: string; detail: string }> = [
  { value: 'balanced', label: 'Balanced', detail: 'Natural movement across strings and frets' },
  { value: 'easiest', label: 'Easiest', detail: 'Favor open strings and lower frets' },
  { value: 'position', label: 'One position', detail: 'Keep the hand in one compact area' },
]

function optionalNumber(value: string): number | null {
  return value === '' ? null : Number(value)
}

export function PhraseWorkshop({
  bars,
  startBar,
  endBar,
  mode,
  allowedStrings,
  stringCount,
  fretCount,
  minFret,
  maxFret,
  name,
  preview,
  saving,
  onRangeChange,
  onModeChange,
  onAllowedStringsChange,
  onFretRangeChange,
  onNameChange,
  onCancel,
  onSave,
}: PhraseWorkshopProps) {
  const [waitingForEnd, setWaitingForEnd] = useState(false)
  const selectionAnchor = useRef(startBar)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const selectBar = (bar: number, extend: boolean) => {
    if (extend) {
      onRangeChange(Math.min(selectionAnchor.current, bar), Math.max(selectionAnchor.current, bar))
      setWaitingForEnd(false)
      return
    }
    if (!waitingForEnd) {
      selectionAnchor.current = bar
      onRangeChange(bar, bar)
      setWaitingForEnd(true)
      return
    }
    onRangeChange(Math.min(selectionAnchor.current, bar), Math.max(selectionAnchor.current, bar))
    setWaitingForEnd(false)
  }

  const toggleString = (string: number) => {
    const selected = allowedStrings.includes(string)
    if (selected && allowedStrings.length === 1) return
    onAllowedStringsChange(
      selected
        ? allowedStrings.filter((candidate) => candidate !== string)
        : [...allowedStrings, string].sort((left, right) => left - right),
    )
  }
  const hasChanges = Boolean(preview && preview.changes.length > 0)
  const invalidName = name.trim().length === 0

  return (
    <aside className="phrase-workshop" aria-labelledby="phrase-workshop-title">
      <div className="inspector-heading">
        <div>
          <p className="eyebrow">Phrase Workshop</p>
          <h2 id="phrase-workshop-title" ref={headingRef} tabIndex={-1}>
            Shape bars {startBar}–{endBar}
          </h2>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Close Phrase Workshop"
          disabled={saving}
          onClick={onCancel}
        >
          <Icon name="close" />
        </button>
      </div>

      <section className="phrase-bar-picker" aria-labelledby="phrase-bars-heading">
        <div className="phrase-section-heading">
          <div>
            <h3 id="phrase-bars-heading">Choose whole bars</h3>
            <p>{waitingForEnd ? 'Now choose the last bar.' : 'Choose a first bar, then a last bar. Shift-click extends.'}</p>
          </div>
          <span aria-live="polite">{endBar - startBar + 1} bars selected</span>
        </div>
        <div className="phrase-bar-lane" role="group" aria-label="Phrase bar selection">
          {bars.map((bar) => {
            const selected = bar.number >= startBar && bar.number <= endBar
            return (
              <button
                key={bar.number}
                type="button"
                className={selected ? 'selected' : ''}
                aria-pressed={selected}
                aria-label={`Bar ${bar.number}, ${bar.noteCount} ${bar.noteCount === 1 ? 'note' : 'notes'}`}
                onClick={(event) => selectBar(bar.number, event.shiftKey)}
              >
                <strong>{bar.number}</strong>
                <small>{bar.noteCount || '—'}</small>
              </button>
            )
          })}
        </div>
        <div className="field-pair phrase-range-fields">
          <label>
            Start bar
            <input
              type="number"
              min={bars[0]?.number ?? 1}
              max={endBar}
              value={startBar}
              disabled={saving}
              onChange={(event) => onRangeChange(Number(event.target.value), endBar)}
            />
          </label>
          <label>
            End bar
            <input
              type="number"
              min={startBar}
              max={bars.at(-1)?.number ?? startBar}
              value={endBar}
              disabled={saving}
              onChange={(event) => onRangeChange(startBar, Number(event.target.value))}
            />
          </label>
        </div>
      </section>

      <fieldset className="phrase-mode-picker">
        <legend>Playing approach</legend>
        {modeOptions.map((option) => (
          <label key={option.value} className={mode === option.value ? 'selected' : ''}>
            <input
              type="radio"
              name="phrase-mode"
              value={option.value}
              checked={mode === option.value}
              disabled={saving}
              onChange={() => onModeChange(option.value)}
            />
            <span><strong>{option.label}</strong><small>{option.detail}</small></span>
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Allowed strings</legend>
        <p className="field-help">Keep at least one string available. Locked notes always stay fixed.</p>
        <div className="phrase-string-grid">
          {Array.from({ length: stringCount }, (_, index) => index + 1).map((string) => {
            const checked = allowedStrings.includes(string)
            return (
              <label key={string}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={saving || (checked && allowedStrings.length === 1)}
                  onChange={() => toggleString(string)}
                />
                String {string}
              </label>
            )
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend>Fret range <span>Optional</span></legend>
        <div className="field-pair">
          <label>
            Minimum fret
            <input
              type="number"
              min="0"
              max={maxFret ?? fretCount}
              placeholder="Any"
              value={minFret ?? ''}
              disabled={saving}
              onChange={(event) => onFretRangeChange(optionalNumber(event.target.value), maxFret)}
            />
          </label>
          <label>
            Maximum fret
            <input
              type="number"
              min={minFret ?? 0}
              max={fretCount}
              placeholder="Any"
              value={maxFret ?? ''}
              disabled={saving}
              onChange={(event) => onFretRangeChange(minFret, optionalNumber(event.target.value))}
            />
          </label>
        </div>
      </fieldset>

      <section className="phrase-preview" aria-labelledby="phrase-preview-heading" aria-live="polite">
        <h3 id="phrase-preview-heading">Preview</h3>
        {!preview && <p>Finding a playable route…</p>}
        {preview?.error && <p className="inline-error" role="alert">{preview.error}</p>}
        {preview && !preview.error && (
          <>
            <p>
              {preview.changes.length === 0
                ? 'This phrase already matches these controls.'
                : `${preview.changes.length} of ${preview.selectedNoteCount} notes move to a new string or fret.`}
              {preview.lockedNoteCount > 0 && ` ${preview.lockedNoteCount} locked ${preview.lockedNoteCount === 1 ? 'note stays' : 'notes stay'} fixed.`}
            </p>
            {preview.changes.length > 0 && (
              <ol className="phrase-change-list" aria-label="Proposed fingering changes">
                {preview.changes.map((change) => (
                  <li key={change.noteId}>
                    <span>{change.pitchLabel}</span>
                    <del>String {change.before.string}, fret {change.before.fret}</del>
                    <ins>String {change.after.string}, fret {change.after.fret}</ins>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </section>

      <label>
        New version name
        <input
          required
          maxLength={80}
          value={name}
          disabled={saving}
          aria-invalid={invalidName}
          aria-describedby={invalidName ? 'phrase-version-name-error' : undefined}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </label>
      {invalidName && (
        <p id="phrase-version-name-error" className="inline-error" role="alert">
          Enter a name for the new version.
        </p>
      )}

      <div className="review-action-bar phrase-actions">
        <button className="button secondary" type="button" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
        <button
          className="button primary"
          type="button"
          disabled={saving || invalidName || !hasChanges || Boolean(preview?.error)}
          onClick={onSave}
        >
          <Icon name="save" />
          {saving ? 'Saving version…' : 'Save new version'}
        </button>
      </div>
    </aside>
  )
}
