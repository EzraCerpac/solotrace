import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import {
  BeatMapEditor,
  type BeatMapEditorProps,
  type BeatMapEditorValue,
} from './BeatMapEditor'

const beatMap: BeatMapEditorValue = {
  tempo_bpm: 120,
  time_signature: [4, 4],
  bar_offset_ticks: 0,
  sync_anchors: [
    { audio_frame: 0, score_tick: 0 },
    { audio_frame: 48_000, score_tick: 960 },
    { audio_frame: 192_000, score_tick: 3_840 },
  ],
}

function renderEditor(overrides: Partial<BeatMapEditorProps> = {}) {
  const props: BeatMapEditorProps = {
    value: beatMap,
    versionName: 'Original draft',
    duration: 4,
    sampleRate: 48_000,
    ticksPerQuarter: 480,
    peaks: [0, 0.4, 1, 0.2, 0],
    currentTime: 1.5,
    isPlaying: false,
    noteOnsets: [0.5, 1.5],
    tabPreview: <div>Tab preview</div>,
    onChange: vi.fn(),
    onApply: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
  render(<BeatMapEditor {...props} />)
  return props
}

test('locks boundary pins and nudges an interior pin by keyboard', () => {
  const props = renderEditor()
  const firstPin = screen.getByRole('button', { name: /locked boundary pin 1/i })
  const middlePin = screen.getByRole('button', { name: /sync pin 2/i })

  expect(firstPin).toHaveClass('beat-map-editor__pin--locked')
  fireEvent.keyDown(firstPin, { key: 'ArrowRight' })
  expect(props.onChange).not.toHaveBeenCalled()

  fireEvent.keyDown(middlePin, { key: 'ArrowRight' })
  expect(props.onChange).toHaveBeenLastCalledWith({
    ...beatMap,
    sync_anchors: [
      beatMap.sync_anchors[0],
      { ...beatMap.sync_anchors[1], audio_frame: 48_240 },
      beatMap.sync_anchors[2],
    ],
  })

  fireEvent.keyDown(middlePin, { key: 'ArrowLeft', shiftKey: true })
  expect(props.onChange).toHaveBeenLastCalledWith({
    ...beatMap,
    sync_anchors: [
      beatMap.sync_anchors[0],
      { ...beatMap.sync_anchors[1], audio_frame: 46_800 },
      beatMap.sync_anchors[2],
    ],
  })
})

test('deletes only interior pins', () => {
  const props = renderEditor()

  fireEvent.keyDown(
    screen.getByRole('button', { name: /sync pin 2/i }),
    { key: 'Delete' },
  )
  expect(props.onChange).toHaveBeenCalledWith({
    ...beatMap,
    sync_anchors: [beatMap.sync_anchors[0], beatMap.sync_anchors[2]],
  })
})

test('T pins the nearest beat at playhead only during playback', () => {
  const value = {
    ...beatMap,
    sync_anchors: [beatMap.sync_anchors[0], beatMap.sync_anchors[2]],
  }
  const onChange = vi.fn()
  renderEditor({ value, onChange })
  fireEvent.keyDown(window, { key: 't' })
  expect(onChange).not.toHaveBeenCalled()

  cleanup()
  renderEditor({
    value,
    currentTime: 1.5,
    isPlaying: true,
    onChange,
  })
  fireEvent.keyDown(window, { key: 't' })
  expect(onChange).toHaveBeenLastCalledWith({
    ...value,
    sync_anchors: [
      beatMap.sync_anchors[0],
      { audio_frame: 72_000, score_tick: 1_440 },
      beatMap.sync_anchors[2],
    ],
  })
})

test('offers staged apply, cancel, meter, pickup, and click-preview controls', () => {
  const props = renderEditor({ dirty: false })

  expect(screen.getByRole('heading', { name: 'Beat Map' })).toBeInTheDocument()
  expect(screen.getByText('Tab preview')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Apply timing' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(props.onCancel).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: '6/8' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Other' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Align downbeat to playhead' })).toBeInTheDocument()
  expect(screen.getByText(/does not renumber the selected point as Bar 1/i)).toBeInTheDocument()
  expect(screen.getByRole('switch', { name: 'Click preview' })).toBeInTheDocument()
})

test('aligns the repeating downbeat phase without claiming to renumber bars', () => {
  const props = renderEditor({ currentTime: 1.5 })

  fireEvent.click(screen.getByRole('button', { name: 'Align downbeat to playhead' }))

  expect(props.onChange).toHaveBeenLastCalledWith({
    ...beatMap,
    bar_offset_ticks: 1_440,
  })
})

test('renders dense note-onset guides as one static SVG path', () => {
  renderEditor({
    noteOnsets: Array.from({ length: 2_000 }, (_, index) => index / 500),
  })

  expect(document.querySelectorAll('.beat-map-editor__note-onset')).toHaveLength(1)
})
