import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import { makeNote, makeProject } from '../test-project'
import { PlayTab } from './PlayTab'

const project = makeProject({
  duration: 10,
  notes: [
    makeNote('opening', 0.2, 0.7),
    makeNote('ending', 8.2, 8.7),
  ],
  passage: { name: 'Solo 1', start_s: 0, end_s: 10 },
})

test('auto-follow waits for playback to cross into another system', () => {
  const scrollIntoView = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  })
  vi.spyOn(window, 'matchMedia').mockImplementation(
    () =>
      ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  )

  const { rerender } = render(
    <PlayTab
      project={project}
      currentTime={0.2}
      playing={false}
      onSeek={vi.fn()}
    />,
  )
  rerender(
    <PlayTab project={project} currentTime={0.2} playing onSeek={vi.fn()} />,
  )
  expect(scrollIntoView).not.toHaveBeenCalled()

  rerender(
    <PlayTab project={project} currentTime={4} playing onSeek={vi.fn()} />,
  )
  expect(scrollIntoView).toHaveBeenCalledWith({
    block: 'start',
    behavior: 'auto',
  })

  vi.restoreAllMocks()
})

test('rhythmic notes seek and use roving keyboard focus', () => {
  const onSeek = vi.fn()
  render(
    <PlayTab
      project={makeProject({
        duration: 2,
        passage: { name: 'Solo 1', start_s: 0, end_s: 2 },
        notes: [
          makeNote('first', 0.2, 0.5),
          makeNote('second', 0.8, 1.1),
        ],
      })}
      currentTime={0}
      playing={false}
      onSeek={onSeek}
    />,
  )
  const notes = screen.getAllByRole('button', { name: /Jump to note/ })
  fireEvent.click(notes[1])
  expect(onSeek).toHaveBeenCalledWith(0.8)

  notes[0].focus()
  fireEvent.keyDown(notes[0], { key: 'ArrowRight' })
  expect(notes[0]).toHaveAttribute('tabindex', '-1')
  expect(notes[1]).toHaveAttribute('tabindex', '0')
})

test('shows clean chord symbols above the tab without the review lane', () => {
  const chordProject = makeProject({
    duration: 2,
    passage: { name: 'Solo 1', start_s: 0, end_s: 2 },
    notes: [makeNote('first', 0.2, 0.5)],
  })
  chordProject.tab.chords.events = [
    {
      id: 'chord-dm7',
      onset_frame: 0,
      end_frame: 48_000,
      audio_onset_s: 0,
      audio_offset_s: 1,
      score_tick: 0,
      duration_ticks: 960,
      kind: 'chord',
      root: { step: 'D', alter: 0 },
      quality: 'min7',
      bass: null,
      model_score: 0.82,
      alternatives: [],
      provenance: 'detected',
      edited: false,
      reviewed: false,
    },
  ]

  render(
    <PlayTab
      project={chordProject}
      currentTime={0.4}
      playing={false}
      onSeek={vi.fn()}
    />,
  )

  expect(screen.queryByRole('group', { name: 'Harmony lane' })).not.toBeInTheDocument()
  expect(screen.queryByText(/model score/)).not.toBeInTheDocument()
  const symbol = screen.getByText('Dm7')
  expect(symbol).toHaveClass('play-chord-symbol', 'active')
  expect(symbol.tagName.toLowerCase()).toBe('text')
})
