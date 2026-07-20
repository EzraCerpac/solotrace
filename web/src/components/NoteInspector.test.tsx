import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import type { NoteEvent } from '../types'
import { NoteInspector } from './NoteInspector'

const note: NoteEvent = {
  id: 'note-1',
  onset_frame: 48_000,
  end_frame: 60_000,
  audio_onset_s: 1,
  audio_offset_s: 1.25,
  score_tick: 0,
  duration_ticks: 240,
  midi_pitch: 69,
  pitch_curve_cents: [],
  string: 2,
  fret: 10,
  techniques: [],
  confidence: {
    pitch: 0.9,
    onset: 0.7,
    fingering: 0.8,
    technique: 0.9,
  },
  alternatives: [
    { string: 2, fret: 10, label: 'String 2, fret 10', cost: 0 },
    { string: 3, fret: 14, label: 'String 3, fret 14', cost: 1 },
  ],
  user_locked: true,
  reviewed: false,
}

function renderInspector(overrides: Partial<NoteEvent> = {}) {
  const callbacks = {
    onClose: vi.fn(),
    onSave: vi.fn(),
    onAccept: vi.fn(),
    onDelete: vi.fn(),
    onReopen: vi.fn(),
    onAudition: vi.fn(),
  }
  render(
    <NoteInspector
      note={{ ...note, ...overrides }}
      saving={false}
      {...callbacks}
    />,
  )
  return callbacks
}

test('keeps review actions visible and saves edits as reviewed', () => {
  const callbacks = renderInspector()

  fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
  expect(callbacks.onAccept).toHaveBeenCalledWith(note)

  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  expect(callbacks.onSave).toHaveBeenCalledWith(
    expect.objectContaining({ id: note.id, reviewed: true, user_locked: false }),
  )

  fireEvent.click(screen.getByRole('button', { name: 'Delete note' }))
  expect(callbacks.onDelete).toHaveBeenCalledWith(note)
})

test('reviewed notes can be reopened', () => {
  const callbacks = renderInspector({ reviewed: true })

  fireEvent.click(screen.getByRole('button', { name: 'Reopen review' }))

  expect(callbacks.onReopen).toHaveBeenCalledWith(
    expect.objectContaining({ id: note.id, reviewed: true }),
  )
})
