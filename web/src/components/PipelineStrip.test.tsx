import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import type { ProcessingRun } from '../types'
import { PipelineStrip } from './PipelineStrip'

test('shows cloud progress and lets the user cancel an active draft', () => {
  const cancel = vi.fn()
  const run: ProcessingRun = {
    id: 'run-cloud',
    state: 'running',
    message: 'Waiting in MVSep queue · 2 ahead',
    error: null,
    created_at: '',
    updated_at: '',
    stages: [
      {
        id: 'separate',
        label: 'Separate lead guitar',
        status: 'running',
        detail: 'Waiting in MVSep queue · 2 ahead',
      },
    ],
  }

  render(<PipelineStrip run={run} onCancel={cancel} />)

  expect(screen.getAllByText('Waiting in MVSep queue · 2 ahead')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(cancel).toHaveBeenCalledOnce()
})
