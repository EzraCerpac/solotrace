import assert from 'node:assert/strict'
import { test } from 'vitest'

import { PhrasePlanError, planPhraseFingering } from '../src/phrase.ts'

const note = (id, midiPitch, scoreTick, overrides = {}) => ({
  id,
  onset_frame: scoreTick * 10,
  end_frame: scoreTick * 10 + 100,
  audio_onset_s: scoreTick / 480,
  audio_offset_s: scoreTick / 480 + 0.2,
  score_tick: scoreTick,
  duration_ticks: 192,
  midi_pitch: midiPitch,
  pitch_curve_cents: [],
  string: 1,
  fret: midiPitch - 64,
  techniques: [],
  confidence: { pitch: 0.9, onset: 0.9, fingering: 0.5, technique: 0.8 },
  alternatives: [],
  user_locked: false,
  reviewed: true,
  ...overrides,
})

const tab = (notes, overrides = {}) => ({
  sample_rate: 44_100,
  ticks_per_quarter: 480,
  tempo_bpm: 120,
  time_signature: [4, 4],
  tuning: [40, 45, 50, 55, 59, 64],
  capo_fret: 0,
  fret_count: 22,
  preferred_fret: null,
  sync_anchors: [{ audio_frame: 0, score_tick: 0 }],
  notes,
  chords: {
    engine: 'manual',
    model_revision: null,
    model_sha256: null,
    analyzed_start_s: null,
    analyzed_end_s: null,
    events: [],
  },
  ...overrides,
})

test('phrase plan expands to bars, preserves boundaries, and reopens changed notes', () => {
  const notes = [
    note('before', 64, 0, { string: 2, fret: 5, user_locked: true }),
    note('hammer', 67, 1920, { techniques: ['hammer-on'] }),
    note('middle', 69, 2400),
    note('after', 65, 3840, {
      string: 2,
      fret: 6,
      user_locked: true,
    }),
  ]
  const source = tab(notes)
  const plan = planPhraseFingering(source, {
    range: { startScoreTick: 2000, endScoreTick: 2500 },
    mode: 'position',
    constraints: { allowedStrings: [2], minFret: 5, maxFret: 12 },
  })

  assert.deepEqual(plan.range, { startScoreTick: 1920, endScoreTick: 3840 })
  assert.equal(plan.selectedNoteCount, 2)
  assert.deepEqual([plan.notes[0].string, plan.notes[0].fret], [2, 5])
  assert.deepEqual([plan.notes[3].string, plan.notes[3].fret], [2, 6])
  assert.deepEqual([plan.notes[1].string, plan.notes[1].fret], [2, 8])
  assert.deepEqual([plan.notes[2].string, plan.notes[2].fret], [2, 10])
  assert.equal(plan.notes[1].reviewed, false)
  assert.equal(plan.notes[1].user_locked, false)
  assert.ok(plan.notes[2].alternatives.some(({ string }) => string !== 2))
  assert.deepEqual(source.notes, notes)
})

test('phrase constraints preserve locked corrections and fail with structured errors', () => {
  const locked = note('locked', 69, 1920, {
    string: 1,
    fret: 5,
    user_locked: true,
  })
  const plan = planPhraseFingering(tab([locked]), {
    range: { startScoreTick: 1920, endScoreTick: 3840 },
    mode: 'easiest',
    constraints: { allowedStrings: [2], minFret: 8, maxFret: 12 },
  })
  assert.deepEqual([plan.notes[0].string, plan.notes[0].fret], [1, 5])
  assert.deepEqual(plan.notes[0], locked)
  assert.equal(plan.lockedNoteCount, 1)
  assert.equal(plan.changes.length, 0)

  assert.throws(
    () => planPhraseFingering(tab([]), {
      range: { startScoreTick: 0, endScoreTick: 100 },
      mode: 'balanced',
    }),
    (error) => error instanceof PhrasePlanError && error.code === 'empty-range',
  )
  assert.throws(
    () => planPhraseFingering(tab([locked]), {
      range: { startScoreTick: 1920, endScoreTick: 3840 },
      mode: 'balanced',
      constraints: { allowedStrings: [] },
    }),
    (error) => error instanceof PhrasePlanError && error.code === 'invalid-constraints',
  )
})

test('phrase plan uses sounding tuning and available frets with a capo', () => {
  const source = tab(
    [note('capo-note', 66, 0, { string: 1, fret: 0 })],
    { capo_fret: 2 },
  )
  const plan = planPhraseFingering(source, {
    range: { startScoreTick: 0, endScoreTick: 100 },
    mode: 'easiest',
    constraints: { allowedStrings: [1], minFret: 0, maxFret: 0 },
  })
  assert.deepEqual([plan.notes[0].string, plan.notes[0].fret], [1, 0])
})
