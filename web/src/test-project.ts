import type { NoteEvent, Project } from './types'
import { emptyChordTrack } from '@solotrace/editor'

export function makeNote(
  id: string,
  onset: number,
  offset: number,
  string = 1,
  fret = 5,
): NoteEvent {
  return {
    id,
    onset_frame: Math.round(onset * 48_000),
    end_frame: Math.round(offset * 48_000),
    audio_onset_s: onset,
    audio_offset_s: offset,
    score_tick: Math.round(onset * 960),
    duration_ticks: Math.max(1, Math.round((offset - onset) * 960)),
    midi_pitch: 64 + fret,
    pitch_curve_cents: [],
    string,
    fret,
    techniques: [],
    confidence: {
      pitch: 0.9,
      onset: 0.9,
      fingering: 0.9,
      technique: 0.9,
    },
    alternatives: [
      { string, fret, label: `String ${string}, fret ${fret}`, cost: 0 },
    ],
    user_locked: false,
    reviewed: false,
  }
}

export function makeProject({
  duration = 300,
  notes = [makeNote('late-note', 240, 240.5, 2, 10)],
  tuning = [40, 45, 50, 55, 59, 64],
  passage = { name: 'Solo 1', start_s: 239, end_s: 250 },
}: {
  duration?: number
  notes?: NoteEvent[]
  tuning?: number[]
  passage?: Project['passage']
} = {}): Project {
  return {
    id: 'test-project',
    title: 'Late Solo',
    artist: 'Test Player',
    created_at: '',
    updated_at: '',
    revision: 1,
    duration_s: duration,
    passage,
    assets: [
      {
        role: 'original',
        url: '/media/original.wav',
        filename: 'original.wav',
        duration_s: duration,
        sample_rate: 48_000,
        method: 'test',
      },
      {
        role: 'lead',
        url: '/media/lead.wav',
        filename: 'lead.wav',
        duration_s: duration,
        sample_rate: 48_000,
        method: 'test',
      },
      {
        role: 'backing',
        url: '/media/backing.wav',
        filename: 'backing.wav',
        duration_s: duration,
        sample_rate: 48_000,
        method: 'test',
      },
    ],
    tab: {
      sample_rate: 48_000,
      ticks_per_quarter: 480,
      tempo_bpm: 120,
      time_signature: [4, 4],
      tuning,
      fret_count: 22,
      sync_anchors: [
        { audio_frame: passage.start_s * 48_000, score_tick: passage.start_s * 960 },
        { audio_frame: passage.end_s * 48_000, score_tick: passage.end_s * 960 },
      ],
      notes,
      chords: emptyChordTrack(),
    },
    versions: [
      {
        id: 'version-original',
        name: 'Original draft',
        source: 'test',
        fingering_mode: 'balanced',
        created_at: '',
        updated_at: '',
        note_count: notes.length,
        needs_review_count: 0,
        chord_count: 0,
        chord_needs_review_count: 0,
      },
    ],
    active_version_id: 'version-original',
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
    trashed_at: null,
    separation_scope: 'exact',
    waveform_peaks: [0, 1, 0],
    provenance: [],
  }
}
