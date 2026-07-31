import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  activeVersion,
  applyVersionAction,
  createRefingeredVersion,
  emptyChordTrack,
  isEditorProject,
} from '../src/index.ts'

const note = (id, midiPitch, onset, scoreTick) => ({
  id,
  onset_frame: Math.round(onset * 44_100),
  end_frame: Math.round((onset + 0.4) * 44_100),
  audio_onset_s: onset,
  audio_offset_s: onset + 0.4,
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
})

const project = () => ({
  id: 'project-test',
  title: 'Phrase test',
  artist: '',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  revision: 1,
  duration_s: 6,
  passage: { name: 'Full song', start_s: 0, end_s: 6 },
  assets: [],
  versions: [{
    id: 'source',
    name: 'Balanced',
    source: 'example',
    fingering_mode: 'balanced',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    tab: {
      sample_rate: 44_100,
      ticks_per_quarter: 480,
      tempo_bpm: 120,
      time_signature: [4, 4],
      tuning: [40, 45, 50, 55, 59, 64],
      capo_fret: 0,
      fret_count: 22,
      preferred_fret: null,
      sync_anchors: [
        { audio_frame: 0, score_tick: 0 },
        { audio_frame: 264_600, score_tick: 5_760 },
      ],
      notes: [note('inside', 67, 0.5, 480), note('outside', 69, 4, 3_840)],
      chords: emptyChordTrack(),
    },
  }],
  active_version_id: 'source',
  source_name: 'test',
  origin: 'local',
  waveform_peaks: [],
  provenance: [],
})

test('partial refingering creates mixed metadata and leaves outside bars byte-identical', () => {
  const source = project()
  const beforeOutside = structuredClone(source.versions[0].tab.notes[1])
  const changed = createRefingeredVersion(source, {
    mode: 'position',
    range: { startScoreTick: 480, endScoreTick: 481 },
    constraints: { minFret: 0, maxFret: 22 },
    versionId: 'phrase',
    name: 'Bar 1',
    createdAt: '2026-01-02T00:00:00Z',
  })

  assert.equal(activeVersion(changed).fingering_mode, 'mixed')
  assert.equal(activeVersion(changed).source, 'phrase:source')
  assert.deepEqual(activeVersion(changed).tab.notes[1], beforeOutside)
  assert.deepEqual(source, project())
})

test('replace-beat-map retimes one version atomically and legacy validation adds pickup zero', () => {
  const source = project()
  source.versions.push({
    ...structuredClone(source.versions[0]),
    id: 'timing',
    name: 'Timing',
  })
  source.active_version_id = 'timing'
  const originalTab = structuredClone(source.versions[0].tab)
  const changed = applyVersionAction(source, {
    type: 'replace-beat-map',
    versionId: 'timing',
    beatMap: {
      tempo_bpm: 120,
      time_signature: [3, 4],
      bar_offset_ticks: 240,
      sync_anchors: [
        { audio_frame: 0, score_tick: 0 },
        { audio_frame: 264_600, score_tick: 5_760 },
      ],
    },
  }, '2026-01-03T00:00:00Z')

  assert.equal(changed.revision, source.revision + 1)
  assert.deepEqual(changed.versions[0].tab, originalTab)
  assert.equal(activeVersion(changed).tab.bar_offset_ticks, 240)
  assert.deepEqual(activeVersion(changed).tab.time_signature, [3, 4])

  const legacy = project()
  assert.equal(legacy.versions[0].tab.bar_offset_ticks, undefined)
  assert.equal(isEditorProject(legacy), true)
  assert.equal(legacy.versions[0].tab.bar_offset_ticks, 0)
})
