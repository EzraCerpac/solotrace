import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

import { makeProject } from './test-project'

const project = makeProject()
const apiMock = vi.hoisted(() => ({
  listProjects: vi.fn(),
  capabilities: vi.fn(),
  getProject: vi.fn(),
  patchNotes: vi.fn(),
  processProject: vi.fn(),
  refinger: vi.fn(),
  createProject: vi.fn(),
}))

vi.mock('./api', () => ({
  ApiError: class ApiError extends Error {
    status = 500
  },
  api: apiMock,
}))

import App from './App'

beforeEach(() => {
  apiMock.listProjects.mockResolvedValue([project])
  apiMock.getProject.mockResolvedValue(project)
  apiMock.capabilities.mockResolvedValue({
    appVersion: '0.1.0',
    buildId: 'test',
    packaged: false,
    audio: { ffmpeg: true, maxUploadMb: 250 },
    separation: {
      selected: 'preview',
      available: { preview: true, mvsep: false },
      notice: '',
      maxDurationS: 600,
      previewMaxDurationS: 180,
      consentRequired: true,
    },
    transcription: {
      selected: 'pyin',
      available: { pyin: true, basicPitch: false },
    },
    cloudReady: false,
    cloud: { configured: false, ready: false },
    privacy: 'local',
  })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    value: undefined,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('Play mode removes editing controls and keeps seeking, tracks, and keyboard playback', async () => {
  const { container } = render(<App />)
  await screen.findByRole('heading', { name: 'Late Solo' })

  const playModeButton = container.querySelector<HTMLButtonElement>(
    '.edit-mode-switch button:last-child',
  )
  expect(playModeButton).not.toBeNull()
  fireEvent.click(playModeButton!)

  expect(screen.queryByRole('button', { name: 'Rebuild draft' })).not.toBeInTheDocument()
  expect(screen.queryByText('Drag a note across strings.')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeInTheDocument()
  expect(screen.getByText('Full-track tablature')).toBeInTheDocument()

  const note = screen.getByRole('button', { name: /Jump to note/ })
  fireEvent.click(note)
  expect(apiMock.patchNotes).not.toHaveBeenCalled()

  const backing = screen.getByRole('button', { name: 'Backing track' })
  fireEvent.click(backing)
  expect(backing).toHaveAttribute('aria-pressed', 'true')

  fireEvent.keyDown(window, { key: 'ArrowRight' })
  expect(screen.getByText('04:05.00')).toBeInTheDocument()

  fireEvent.keyDown(window, { code: 'Space' })
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))
  await waitFor(() =>
    expect(
      screen.getByText('Fullscreen unavailable. Play mode still fills the window.'),
    ).toBeInTheDocument(),
  )
})
