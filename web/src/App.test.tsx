import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { vi } from 'vitest'

import { emptyChordTrack } from '@solotrace/editor'
import { makeNote, makeProject } from './test-project'
import type { ChordTrack, Project } from './types'

const project = makeProject()
const apiMock = vi.hoisted(() => ({
  listProjects: vi.fn(),
  capabilities: vi.fn(),
  getProject: vi.fn(),
  patchNotes: vi.fn(),
  patchChords: vi.fn(),
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
  vi.clearAllMocks()
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
      mvsepMaxDurationS: 600,
      consentRequired: true,
    },
    transcription: {
      selected: 'pyin',
      available: { pyin: true, basicPitch: false },
    },
    chords: {
      available: true,
      detail: 'Pinned model verified for offline recognition',
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
    value: vi.fn(() => {
      throw new Error('unsupported')
    }),
  })
  window.localStorage?.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

test('keeps chord recognition with the open project, not every sidebar row', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: 'Late Solo' })

  const projectList = screen.getByRole('navigation', { name: 'Projects' })
  expect(
    within(projectList).queryByRole('button', { name: 'Find chords' }),
  ).not.toBeInTheDocument()

  const projectToolbar = screen.getByRole('region', { name: 'Audio source' })
  expect(
    within(projectToolbar).getByRole('button', { name: 'Find chords' }),
  ).toBeEnabled()
})

test('defaults a song longer than three minutes to full transcription', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: 'Late Solo' })

  const sectionToggle = screen.getByRole('checkbox', {
    name: /Limit to a section/,
  })
  expect(sectionToggle).not.toBeChecked()
  expect(screen.queryByLabelText('Section starts')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Transcribe full song again' })).toBeEnabled()

  fireEvent.click(sectionToggle)

  expect(sectionToggle).toBeChecked()
  expect(screen.getByLabelText('Section starts')).toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: 'Transcribe selected section again' }),
  ).toBeEnabled()
})

test('explains the MVSep service limit without limiting offline transcription', async () => {
  const longProject = { ...project, title: 'Long Song', duration_s: 700 }
  apiMock.listProjects.mockResolvedValue([longProject])
  apiMock.getProject.mockResolvedValue(longProject)
  apiMock.capabilities.mockResolvedValue({
    appVersion: '0.1.0',
    buildId: 'test',
    packaged: false,
    audio: { ffmpeg: true, maxUploadMb: 250 },
    separation: {
      selected: 'mvsep',
      available: { preview: true, mvsep: true },
      notice: '',
      mvsepMaxDurationS: 600,
      consentRequired: true,
    },
    transcription: {
      selected: 'basicPitch',
      available: { pyin: true, basicPitch: true },
    },
    cloudReady: true,
    cloud: { configured: true, ready: true },
    privacy: 'local',
  })

  render(<App />)
  await screen.findByRole('heading', { name: 'Long Song' })
  fireEvent.click(screen.getByRole('button', { name: 'Experimental MVSep' }))

  expect(
    screen.getByText('MVSep supports up to 10 minutes. Select a section or use Offline preview.'),
  ).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Transcribe full song again' })).toBeDisabled()

  fireEvent.click(screen.getByRole('button', { name: 'Offline preview' }))
  expect(screen.getByRole('button', { name: 'Transcribe full song again' })).toBeEnabled()
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

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }))
  })
  expect(document.documentElement.requestFullscreen).toHaveBeenCalled()
})

function makeReviewProject(): Project {
  const uncertain = makeNote('uncertain-note', 2, 2.4)
  uncertain.confidence.pitch = 0.42
  const confident = makeNote('confident-note', 3, 3.4)
  const reviewProject = makeProject({
    duration: 8,
    passage: { name: 'Whole song', start_s: 0, end_s: 8 },
    notes: [uncertain, confident],
  })
  reviewProject.tab.chords = {
    ...emptyChordTrack(),
    analyzed_start_s: 0,
    analyzed_end_s: 8,
    events: [
      {
        id: 'reviewed-opening-chord',
        onset_frame: 0,
        end_frame: 48_000,
        audio_onset_s: 0,
        audio_offset_s: 1,
        score_tick: 0,
        duration_ticks: 960,
        kind: 'chord',
        root: { step: 'C', alter: 0 },
        quality: 'maj',
        bass: null,
        model_score: 0.91,
        alternatives: [],
        provenance: 'detected',
        edited: false,
        reviewed: true,
      },
      {
        id: 'uncertain-chord',
        onset_frame: 48_000,
        end_frame: 96_000,
        audio_onset_s: 1,
        audio_offset_s: 2,
        score_tick: 960,
        duration_ticks: 960,
        kind: 'chord',
        root: { step: 'A', alter: 0 },
        quality: 'min',
        bass: null,
        model_score: 0.61,
        alternatives: [],
        provenance: 'detected',
        edited: false,
        reviewed: false,
      },
      {
        id: 'reviewed-closing-chord',
        onset_frame: 96_000,
        end_frame: 384_000,
        audio_onset_s: 2,
        audio_offset_s: 8,
        score_tick: 1920,
        duration_ticks: 5760,
        kind: 'chord',
        root: { step: 'F', alter: 0 },
        quality: 'maj',
        bass: null,
        model_score: 0.9,
        alternatives: [],
        provenance: 'detected',
        edited: false,
        reviewed: true,
      },
    ],
  }
  return reviewProject
}

function mockReviewPersistence(initial: Project) {
  let serverProject = initial
  apiMock.patchNotes.mockImplementation(
    async (
      _projectId: string,
      _versionId: string,
      _expectedRevision: number,
      notes: Project['tab']['notes'],
    ) => {
      serverProject = {
        ...serverProject,
        revision: serverProject.revision + 1,
        tab: { ...serverProject.tab, notes },
      }
      return serverProject
    },
  )
  apiMock.patchChords.mockImplementation(
    async (
      _projectId: string,
      _versionId: string,
      _expectedRevision: number,
      chords: ChordTrack,
    ) => {
      serverProject = {
        ...serverProject,
        revision: serverProject.revision + 1,
        tab: { ...serverProject.tab, chords },
      }
      return serverProject
    },
  )
}

test('reviews notes and chords in one keyboard-first session, then restores playback state', async () => {
  const reviewProject = makeReviewProject()
  apiMock.listProjects.mockResolvedValue([reviewProject])
  apiMock.getProject.mockResolvedValue(reviewProject)
  mockReviewPersistence(reviewProject)

  render(<App />)
  const start = await screen.findByRole('button', {
    name: 'Review · 2 remaining',
  })
  fireEvent.click(start)

  expect(screen.getByRole('button', { name: 'Lead' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(screen.getByRole('button', { name: /Loop 00:00 to 00:03/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(screen.getByText('Check chord match · 61% confidence')).toBeInTheDocument()

  fireEvent.keyDown(window, { key: 'a' })
  await screen.findByText('Check pitch')
  expect(apiMock.patchChords).toHaveBeenCalledTimes(1)

  const pitchInput = screen.getByLabelText('MIDI pitch')
  fireEvent.keyDown(pitchInput, { key: 'a' })
  expect(apiMock.patchNotes).not.toHaveBeenCalled()

  fireEvent.keyDown(window, { key: 'a' })
  await screen.findByText('Review complete')
  expect(apiMock.patchNotes).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole('button', { name: 'Finish' }))
  expect(screen.getByRole('button', { name: 'Full mix' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(screen.getByRole('button', { name: /Loop 00:00 to 00:08/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
})

test('undoes and redoes alternating note and chord changes through one history', async () => {
  const reviewProject = makeReviewProject()
  apiMock.listProjects.mockResolvedValue([reviewProject])
  apiMock.getProject.mockResolvedValue(reviewProject)
  mockReviewPersistence(reviewProject)

  render(<App />)
  fireEvent.click(
    await screen.findByRole('button', { name: 'Review · 2 remaining' }),
  )
  fireEvent.keyDown(window, { key: 'a' })
  await screen.findByText('Check pitch')
  fireEvent.keyDown(window, { key: 'a' })
  await screen.findByText('Review complete')

  fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
  await waitFor(() => expect(apiMock.patchNotes).toHaveBeenCalledTimes(2))
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
  await waitFor(() => expect(apiMock.patchChords).toHaveBeenCalledTimes(2))

  expect(screen.getByText('2 remaining')).toBeInTheDocument()

  fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true })
  await waitFor(() => expect(apiMock.patchChords).toHaveBeenCalledTimes(3))
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true })
  await waitFor(() => expect(apiMock.patchNotes).toHaveBeenCalledTimes(3))

  expect(screen.getByText('Review complete')).toBeInTheDocument()
})
