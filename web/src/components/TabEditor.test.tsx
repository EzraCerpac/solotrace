import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import { makeProject } from '../test-project'
import { TabEditor } from './TabEditor'

test('scopes a late solo to its passage and renders every configured string', () => {
  const project = makeProject({ tuning: [35, 40, 45, 50, 55, 59, 64] })
  render(
    <TabEditor
      project={project}
      currentTime={240}
      selectedNoteId={null}
      onSelectNote={vi.fn()}
      onSeek={vi.fn()}
      onFingeringChange={vi.fn()}
    />,
  )

  const svg = screen.getByRole('img')
  expect(svg).toHaveAttribute('width', '1120')
  expect(svg.querySelectorAll('.string-line')).toHaveLength(7)
  const note = screen.getByRole('button', { name: /string 2, fret 10/ })
  const fretBoxX = Number(note.querySelector('rect')?.getAttribute('x'))
  expect(fretBoxX).toBeGreaterThan(64)
  expect(fretBoxX).toBeLessThan(1_000)
})
