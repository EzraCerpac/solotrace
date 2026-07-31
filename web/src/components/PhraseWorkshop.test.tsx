import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import { PhraseWorkshop, type PhrasePreview } from './PhraseWorkshop'

const bars = Array.from({ length: 6 }, (_, index) => ({
  number: index + 1,
  startScoreTick: index * 1920,
  endScoreTick: (index + 1) * 1920,
  noteCount: index === 4 ? 0 : index + 1,
}))

const preview: PhrasePreview = {
  selectedNoteCount: 4,
  lockedNoteCount: 1,
  changes: [{
    noteId: 'note-a',
    pitchLabel: 'A4',
    before: { string: 1, fret: 5 },
    after: { string: 2, fret: 10 },
  }],
}

function renderWorkshop(overrides = {}) {
  const callbacks = {
    onRangeChange: vi.fn(),
    onModeChange: vi.fn(),
    onAllowedStringsChange: vi.fn(),
    onFretRangeChange: vi.fn(),
    onNameChange: vi.fn(),
    onCancel: vi.fn(),
    onSave: vi.fn(),
  }
  render(
    <PhraseWorkshop
      bars={bars}
      startBar={2}
      endBar={3}
      mode="balanced"
      allowedStrings={[1, 2, 3, 4, 5, 6]}
      stringCount={6}
      fretCount={22}
      minFret={null}
      maxFret={null}
      name="Bars 2–3 · Balanced"
      preview={preview}
      saving={false}
      {...callbacks}
      {...overrides}
    />,
  )
  return callbacks
}

test('supports two-click and shift-extend whole-bar selection', () => {
  const callbacks = renderWorkshop()
  fireEvent.click(screen.getByRole('button', { name: 'Bar 4, 4 notes' }))
  expect(callbacks.onRangeChange).toHaveBeenLastCalledWith(4, 4)
  expect(screen.getByText('Now choose the last bar.')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Bar 6, 6 notes' }))
  expect(callbacks.onRangeChange).toHaveBeenLastCalledWith(4, 6)

  fireEvent.click(screen.getByRole('button', { name: 'Bar 1, 1 note' }), { shiftKey: true })
  expect(callbacks.onRangeChange).toHaveBeenLastCalledWith(1, 4)
})

test('exposes playable controls, accessible diff, and save action', () => {
  const callbacks = renderWorkshop()
  fireEvent.click(screen.getByRole('radio', { name: /One position/ }))
  expect(callbacks.onModeChange).toHaveBeenCalledWith('position')

  fireEvent.click(screen.getByRole('checkbox', { name: 'String 6' }))
  expect(callbacks.onAllowedStringsChange).toHaveBeenCalledWith([1, 2, 3, 4, 5])

  expect(screen.getByText(/1 of 4 notes move to a new string or fret/)).toBeInTheDocument()
  expect(screen.getByText('String 1, fret 5')).toBeInTheDocument()
  expect(screen.getByText('String 2, fret 10')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /Save new version/ }))
  expect(callbacks.onSave).toHaveBeenCalledOnce()
})

test('blocks saving zero-change and invalid previews', () => {
  const { rerender } = render(
    <PhraseWorkshop
      bars={bars}
      startBar={2}
      endBar={2}
      mode="balanced"
      allowedStrings={[1]}
      stringCount={1}
      fretCount={22}
      minFret={null}
      maxFret={null}
      name="No movement"
      preview={{ selectedNoteCount: 1, lockedNoteCount: 0, changes: [] }}
      saving={false}
      onRangeChange={vi.fn()}
      onModeChange={vi.fn()}
      onAllowedStringsChange={vi.fn()}
      onFretRangeChange={vi.fn()}
      onNameChange={vi.fn()}
      onCancel={vi.fn()}
      onSave={vi.fn()}
    />,
  )
  expect(screen.getByRole('button', { name: /Save new version/ })).toBeDisabled()
  expect(screen.getByRole('checkbox', { name: 'String 1' })).toBeDisabled()

  rerender(
    <PhraseWorkshop
      bars={bars}
      startBar={2}
      endBar={2}
      mode="balanced"
      allowedStrings={[1]}
      stringCount={1}
      fretCount={22}
      minFret={null}
      maxFret={null}
      name="Failed"
      preview={{ selectedNoteCount: 1, lockedNoteCount: 0, changes: [], error: 'No playable route.' }}
      saving={false}
      onRangeChange={vi.fn()}
      onModeChange={vi.fn()}
      onAllowedStringsChange={vi.fn()}
      onFretRangeChange={vi.fn()}
      onNameChange={vi.fn()}
      onCancel={vi.fn()}
      onSave={vi.fn()}
    />,
  )
  expect(screen.getByRole('alert')).toHaveTextContent('No playable route.')
})
