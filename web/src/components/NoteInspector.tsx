import { useEffect, useState, type FormEvent } from 'react'

import { Icon } from './Icon'
import { minimumConfidence, pitchName } from '../music'
import type { NoteEvent } from '../types'

interface NoteInspectorProps {
  note: NoteEvent
  saving: boolean
  onClose: () => void
  onSave: (note: NoteEvent) => void
  onAccept: (note: NoteEvent) => void
  onDelete: (note: NoteEvent) => void
  onReopen: (note: NoteEvent) => void
  onAudition: (note: NoteEvent) => void
  rangeStart?: number
  rangeEnd?: number
}

const techniqueOptions = ['bend', 'vibrato', 'slide', 'hammer-on', 'pull-off']

export function NoteInspector({
  note,
  saving,
  onClose,
  onSave,
  onAccept,
  onDelete,
  onReopen,
  onAudition,
  rangeStart = 0,
  rangeEnd = Math.max(note.audio_offset_s + 1, 1),
}: NoteInspectorProps) {
  const [draft, setDraft] = useState(note)

  useEffect(() => {
    setDraft(note)
  }, [note])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSave({
      ...draft,
      audio_offset_s: Math.max(draft.audio_onset_s + 0.01, draft.audio_offset_s),
      user_locked: true,
      reviewed: true,
    })
  }

  return (
    <aside className="note-inspector" aria-label="Selected note">
      <div className="inspector-heading">
        <div>
          <p className="eyebrow">Selected note</p>
          <h2>{pitchName(draft.midi_pitch)}</h2>
        </div>
        <button className="icon-button" type="button" aria-label="Close note editor" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <button type="button" className="audition-button" onClick={() => onAudition(draft)}>
        <Icon name="play" />
        Hear this note in context
      </button>
      <div className="review-action-bar">
        {draft.reviewed ? (
          <button type="button" className="button secondary" disabled={saving} onClick={() => onReopen(draft)}>
            Reopen review
          </button>
        ) : (
          <button type="button" className="button primary" disabled={saving} onClick={() => onAccept(draft)}>
            <Icon name="check" />
            Accept
          </button>
        )}
        <button
          className="button secondary"
          type="submit"
          form="note-editor-form"
          disabled={saving}
        >
          <Icon name="save" />
          Save changes
        </button>
        <button
          className="button danger-text"
          type="button"
          disabled={saving}
          onClick={() => onDelete(draft)}
        >
          Delete note
        </button>
      </div>
      <form id="note-editor-form" onSubmit={submit}>
        <fieldset>
          <legend>Position</legend>
          <div className="current-fingering">
            <span>
              <small>String</small>
              {draft.string}
            </span>
            <span>
              <small>Fret</small>
              {draft.fret}
            </span>
          </div>
          <div className="alternative-grid" aria-label="Alternative fingerings">
            {draft.alternatives.map((alternative) => (
              <button
                type="button"
                key={`${alternative.string}-${alternative.fret}`}
                className={
                  alternative.string === draft.string && alternative.fret === draft.fret
                    ? 'active'
                    : ''
                }
                disabled={saving}
                onClick={() => {
                  setDraft({
                    ...draft,
                    string: alternative.string,
                    fret: alternative.fret,
                  })
                }}
              >
                <span>S{alternative.string}</span>
                <strong>{alternative.fret}</strong>
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Timing and pitch</legend>
          <div className="field-pair">
            <label>
              Starts
              <input
                type="number"
                min="0"
                step="0.01"
                disabled={saving}
                value={Number(draft.audio_onset_s.toFixed(3))}
                onChange={(event) =>
                  setDraft({ ...draft, audio_onset_s: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Ends
              <input
                type="number"
                min={draft.audio_onset_s + 0.01}
                step="0.01"
                disabled={saving}
                value={Number(draft.audio_offset_s.toFixed(3))}
                onChange={(event) =>
                  setDraft({ ...draft, audio_offset_s: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <div className="timing-handles" aria-label="Drag note timing handles">
            <label>
              Drag onset
              <input
                type="range"
                min={rangeStart}
                max={Math.max(rangeStart + 0.01, draft.audio_offset_s - 0.01)}
                step="0.01"
                disabled={saving}
                value={draft.audio_onset_s}
                onChange={(event) =>
                  setDraft({ ...draft, audio_onset_s: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Drag end
              <input
                type="range"
                min={draft.audio_onset_s + 0.01}
                max={rangeEnd}
                step="0.01"
                disabled={saving}
                value={draft.audio_offset_s}
                onChange={(event) =>
                  setDraft({ ...draft, audio_offset_s: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <label>
            MIDI pitch
            <input
              type="number"
              min="28"
              max="100"
              disabled={saving}
              value={draft.midi_pitch}
              onChange={(event) =>
                setDraft({ ...draft, midi_pitch: Number(event.target.value) })
              }
            />
          </label>
        </fieldset>
        <fieldset>
          <legend>Technique</legend>
          <div className="technique-list">
            {techniqueOptions.map((technique) => (
              <label key={technique}>
                <input
                  type="checkbox"
                  checked={draft.techniques.includes(technique)}
                  disabled={saving}
                  onChange={(event) => {
                    const techniques = event.target.checked
                      ? [...new Set([...draft.techniques, technique])]
                      : draft.techniques.filter((item) => item !== technique)
                    setDraft({ ...draft, techniques })
                  }}
                />
                {technique}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>
            Ambiguity
            <span>{Math.round((1 - minimumConfidence(draft.confidence)) * 100)} / 100</span>
          </legend>
          <div className="confidence-list">
            {Object.entries(draft.confidence).map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <progress max="1" value={value} />
                <code>{Math.round((1 - value) * 100)}</code>
              </div>
            ))}
          </div>
        </fieldset>
      </form>
    </aside>
  )
}
