import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  BeatMapValidationError,
  applyBeatMap,
  pickupMidiShift,
  tempoEventsForTab,
  ticksPerMeasure,
} from '../src/beat-map.ts'

const tab = () => ({
  sample_rate: 48_000,
  ticks_per_quarter: 480,
  tempo_bpm: 120,
  time_signature: [4, 4],
  tuning: [40, 45, 50, 55, 59, 64],
  capo_fret: 0,
  fret_count: 22,
  preferred_fret: null,
  sync_anchors: [
    { audio_frame: 0, score_tick: 0 },
    { audio_frame: 48_000, score_tick: 960 },
  ],
  notes: [{
    id: 'note',
    onset_frame: 12_000,
    end_frame: 24_000,
    audio_onset_s: 0.25,
    audio_offset_s: 0.5,
    score_tick: 999,
    duration_ticks: 999,
    midi_pitch: 69,
    pitch_curve_cents: [],
    string: 1,
    fret: 5,
    techniques: [],
    confidence: { pitch: 1, onset: 1, fingering: 1, technique: 1 },
    alternatives: [],
    user_locked: false,
    reviewed: false,
  }],
  chords: {
    engine: 'manual',
    model_revision: null,
    model_sha256: null,
    analyzed_start_s: null,
    analyzed_end_s: null,
    events: [{
      id: 'chord',
      onset_frame: 24_000,
      end_frame: 48_000,
      audio_onset_s: 0.5,
      audio_offset_s: 1,
      score_tick: 999,
      duration_ticks: 999,
      kind: 'chord',
      root: { step: 'A', alter: 0 },
      quality: 'min',
      bass: null,
      model_score: null,
      alternatives: [],
      provenance: 'manual',
      edited: true,
      reviewed: true,
    }],
  },
})

test('applies one beat map to notes and chords without changing audio coordinates', () => {
  const original = tab()
  const changed = applyBeatMap(original, {
    tempo_bpm: 120,
    time_signature: [4, 4],
    bar_offset_ticks: 480,
    sync_anchors: [
      { audio_frame: 0, score_tick: 0 },
      { audio_frame: 48_000, score_tick: 960 },
    ],
  })

  assert.equal(changed.notes[0].score_tick, 240)
  assert.equal(changed.notes[0].duration_ticks, 240)
  assert.equal(changed.chords.events[0].score_tick, 480)
  assert.equal(changed.chords.events[0].duration_ticks, 480)
  assert.equal(changed.notes[0].onset_frame, original.notes[0].onset_frame)
  assert.equal(changed.notes[0].audio_onset_s, original.notes[0].audio_onset_s)
  assert.equal(original.notes[0].score_tick, 999)
  assert.equal(changed.bar_offset_ticks, 480)
  assert.equal(pickupMidiShift(changed), 1_440)
})

test('rejects crossed pins, impossible meter ticks, extreme segments, and invalid pickups', () => {
  const source = tab()
  assert.throws(
    () => applyBeatMap(source, {
      tempo_bpm: 120,
      time_signature: [4, 4],
      bar_offset_ticks: 0,
      sync_anchors: [
        { audio_frame: 10, score_tick: 0 },
        { audio_frame: 9, score_tick: 480 },
      ],
    }),
    (error) => error instanceof BeatMapValidationError && error.code === 'anchor-order',
  )
  assert.throws(() => ticksPerMeasure(481, [3, 16]), /whole score ticks/)
  assert.throws(
    () => applyBeatMap(source, {
      tempo_bpm: 120,
      time_signature: [4, 4],
      bar_offset_ticks: 1_920,
      sync_anchors: source.sync_anchors,
    }),
    /Pickup/,
  )
  assert.throws(
    () => applyBeatMap(source, {
      tempo_bpm: 120,
      time_signature: [4, 4],
      bar_offset_ticks: 0,
      sync_anchors: [
        { audio_frame: 0, score_tick: 0 },
        { audio_frame: 48_000, score_tick: 9_600 },
      ],
    }),
    /use 20–400 BPM/,
  )
})

test('derives deterministic variable-tempo export events', () => {
  const source = tab()
  source.tempo_bpm = 90
  source.sync_anchors = [
    { audio_frame: 0, score_tick: 0 },
    { audio_frame: 48_000, score_tick: 960 },
    { audio_frame: 72_000, score_tick: 1_920 },
  ]
  assert.deepEqual(tempoEventsForTab(source), [
    { scoreTick: 0, bpm: 120 },
    { scoreTick: 960, bpm: 240 },
  ])
})
