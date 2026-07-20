import { render } from '@testing-library/react'
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
