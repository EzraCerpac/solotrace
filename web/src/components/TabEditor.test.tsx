import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import type { Project } from '../types'
import { TabEditor } from './TabEditor'

function longSongProject(): Project {
  return {
    id: 'late-solo',
    title: 'Late Solo',
    artist: '',
    created_at: '',
    updated_at: '',
    duration_s: 300,
    passage: { name: 'Solo 1', start_s: 239, end_s: 250 },
    assets: [],
    tab: {
      revision: 1,
      sample_rate: 48_000,
      ticks_per_quarter: 480,
      tempo_bpm: 120,
      time_signature: [4, 4],
      tuning: [35, 40, 45, 50, 55, 59, 64],
      fret_count: 22,
      sync_anchors: [
        { audio_frame: 239 * 48_000, score_tick: 0 },
        { audio_frame: 250 * 48_000, score_tick: 10_560 },
      ],
      notes: [
        {
          id: 'late-note',
          onset_frame: 240 * 48_000,
          end_frame: 240.5 * 48_000,
          audio_onset_s: 240,
          audio_offset_s: 240.5,
          score_tick: 960,
          duration_ticks: 480,
          midi_pitch: 69,
          pitch_curve_cents: [],
          string: 2,
          fret: 10,
          techniques: [],
          confidence: {
            pitch: 0.9,
            onset: 0.9,
            fingering: 0.9,
            technique: 0.9,
          },
          alternatives: [
            { string: 2, fret: 10, label: 'String 2, fret 10', cost: 0 },
            { string: 3, fret: 14, label: 'String 3, fret 14', cost: 1 },
          ],
          user_locked: false,
        },
      ],
    },
    run: {
      id: 'run',
      state: 'complete',
      stages: [],
      message: '',
      error: null,
      created_at: '',
      updated_at: '',
    },
    source_name: 'song.wav',
    demo: false,
    separation_scope: 'preview',
    waveform_peaks: [0, 1, 0],
    provenance: [],
  }
}

test('scopes a late solo to its passage and renders every configured string', () => {
  render(
    <TabEditor
      project={longSongProject()}
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
