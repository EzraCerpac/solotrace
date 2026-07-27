import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  activeVersion,
  applyVersionAction,
  asciiTab,
  assignFingerings,
  createRefingeredVersion,
  deleteChordToUnknown,
  emptyChordTrack,
  exportProject,
  isEditorProject,
  legalFingerings,
  mergeChord,
  midi,
  musicXml,
  normalizeChordTrack,
  parseChordSymbol,
  projectJson,
  replaceChordSymbol,
  splitChord,
  validateConnectedTechniqueFingerings,
} from '../src/index.ts'

const note = (id, midiPitch, onset, overrides = {}) => ({
  id,
  onset_frame: Math.round(onset * 44_100),
  end_frame: Math.round((onset + 0.4) * 44_100),
  audio_onset_s: onset,
  audio_offset_s: onset + 0.4,
  score_tick: Math.round(onset * 480),
  duration_ticks: 192,
  midi_pitch: midiPitch,
  pitch_curve_cents: [],
  string: 1,
  fret: 0,
  techniques: [],
  confidence: { pitch: 0.9, onset: 0.9, fingering: 0.5, technique: 0.8 },
  alternatives: [],
  user_locked: false,
  reviewed: false,
  ...overrides,
})

const project = (notes = [note('a', 64, 0), note('b', 67, 0.5)]) => ({
  id: 'project-test',
  title: 'Northbound Lights',
  artist: 'SoloTrace',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  revision: 1,
  duration_s: 4,
  passage: { name: 'Solo 1', start_s: 0, end_s: 4 },
  assets: [],
  versions: [{
    id: 'balanced',
    name: 'Balanced',
    source: 'example',
    fingering_mode: 'balanced',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    tab: {
      sample_rate: 44_100,
      ticks_per_quarter: 480,
      tempo_bpm: 92,
      time_signature: [4, 4],
      tuning: [40, 45, 50, 55, 59, 64],
      fret_count: 22,
      sync_anchors: [{ audio_frame: 0, score_tick: 0 }],
      notes,
      chords: emptyChordTrack(),
    },
  }],
  active_version_id: 'balanced',
  source_name: 'Synthetic CC0 example',
  origin: 'example',
  example_slug: 'northbound-lights',
  waveform_peaks: [0, 0.5, -0.5],
  provenance: ['CC0 synthetic audio'],
})

test('legal fingerings use standard guitar string numbers', () => {
  const positions = legalFingerings(64, [40, 45, 50, 55, 59, 64], 22)
  assert.deepEqual(
    new Set(positions.map(({ string, fret }) => `${string}:${fret}`)),
    new Set(['1:0', '2:5', '3:9', '4:14', '5:19']),
  )
})

test('deterministic refingering preserves locks and input', () => {
  const locked = note('locked', 69, 0, { string: 2, fret: 10, user_locked: true })
  const input = [locked, note('next', 71, 0.5)]
  const first = assignFingerings(input, [40, 45, 50, 55, 59, 64], 22, 'position')
  const second = assignFingerings(input, [40, 45, 50, 55, 59, 64], 22, 'position')
  assert.deepEqual(first, second)
  assert.deepEqual([first[0].string, first[0].fret], [2, 10])
  assert.equal(input[1].alternatives.length, 0)
  assert.throws(
    () => assignFingerings([note('low', 30, 0)], [40, 45, 50, 55, 59, 64], 22),
    /MIDI pitch 30/,
  )
})

test('connected techniques constrain the path and every offered alternative', () => {
  const phrase = [
    note('picked', 64, 0),
    note('hammer', 67, 0.5, { techniques: ['hammer-on'] }),
    note('pull', 65, 1, { techniques: ['pull-off'] }),
    note('slide', 69, 1.5, { techniques: ['slide'] }),
  ]
  const arranged = assignFingerings(phrase, [40, 45, 50, 55, 59, 64], 22)
  validateConnectedTechniqueFingerings(arranged)
  assert.equal(new Set(arranged.map(({ string }) => string)).size, 1)
  assert.ok(arranged[1].fret > arranged[0].fret)
  assert.ok(arranged[2].fret < arranged[1].fret)
  assert.notEqual(arranged[3].fret, arranged[2].fret)
  arranged.forEach((event) => {
    assert.ok(event.alternatives.length > 0)
    assert.deepEqual(new Set(event.alternatives.map(({ string }) => string)), new Set([event.string]))
  })

  assert.throws(
    () => assignFingerings(
      [note('first', 67, 0, { techniques: ['hammer-on'] })],
      [40, 45, 50, 55, 59, 64],
      22,
    ),
    /cannot start with hammer-on/,
  )
})

test('runtime validation rejects an alternative that cannot play the note pitch', () => {
  const candidate = project()
  candidate.versions[0].tab.notes[0].alternatives = [{
    string: 2,
    fret: 4,
    label: 'S2 4',
    cost: 0,
  }]
  assert.equal(isEditorProject(candidate), false)
})

test('refingering appends and activates a version', () => {
  const original = project()
  const changed = createRefingeredVersion(original, {
    mode: 'easiest',
    versionId: 'easiest',
    name: 'Easiest',
    createdAt: '2026-01-02T00:00:00Z',
  })
  assert.equal(changed.revision, 2)
  assert.equal(changed.active_version_id, 'easiest')
  assert.equal(activeVersion(changed).fingering_mode, 'easiest')
  assert.equal(original.versions.length, 1)

  const renamed = applyVersionAction(
    changed,
    { type: 'rename', versionId: 'easiest', name: 'Low movement' },
    '2026-01-03T00:00:00Z',
  )
  assert.equal(activeVersion(renamed).name, 'Low movement')
})

test('chord aliases, boundaries, shared actions, and MusicXML stay lossless', () => {
  assert.deepEqual(parseChordSymbol('Dbmin7/Gb'), {
    kind: 'chord',
    root: { step: 'D', alter: -1 },
    quality: 'min7',
    bass: { step: 'G', alter: -1 },
  })
  assert.equal(parseChordSymbol('C-').quality, 'min')
  assert.equal(parseChordSymbol('N.C.').kind, 'no-chord')
  assert.equal(parseChordSymbol('X').kind, 'unknown')

  const candidate = project()
  const tab = activeVersion(candidate).tab
  const chord = {
    id: 'chord-a',
    onset_frame: 0,
    end_frame: 1,
    audio_onset_s: 0,
    audio_offset_s: 4,
    score_tick: 0,
    duration_ticks: 1,
    kind: 'chord',
    root: { step: 'C', alter: 0 },
    quality: 'maj',
    bass: null,
    model_score: 0.7,
    alternatives: [],
    provenance: 'detected',
    edited: false,
    reviewed: false,
  }
  let track = normalizeChordTrack({
    engine: 'ChordMini 2E1D ONNX',
    model_revision: 'revision',
    model_sha256: 'a'.repeat(64),
    analyzed_start_s: 0,
    analyzed_end_s: 4,
    events: [chord],
  }, tab)
  track = splitChord(track, 'chord-a', 2, 'chord-b')
  track = replaceChordSymbol(track, 'chord-b', 'Dbm7/Gb')
  track = normalizeChordTrack(track, tab)
  assert.equal(track.events[0].audio_offset_s, track.events[1].audio_onset_s)
  assert.equal(track.events[1].root.alter, -1)

  const changed = applyVersionAction(
    candidate,
    { type: 'replace-chords', versionId: 'balanced', track },
    '2026-01-03T00:00:00Z',
  )
  assert.equal(activeVersion(changed).tab.chords.events.length, 2)
  const xml = musicXml(changed)
  assert.match(xml, /<root-step>D<\/root-step>/)
  assert.match(xml, /<root-alter>-1<\/root-alter>/)
  assert.match(xml, /<bass-step>G<\/bass-step>/)

  track = mergeChord(track, 'chord-b', 'left')
  assert.equal(track.events.length, 1)
  track = deleteChordToUnknown(track, 'chord-b')
  assert.equal(track.events[0].kind, 'unknown')
})

test('ASCII, MusicXML, MIDI, and JSON exports are parseable', () => {
  const decorated = project([
    note('a', 69, 0, { string: 1, fret: 5 }),
    note('b', 72, 0.5, { string: 1, fret: 8, techniques: ['hammer-on'] }),
    note('c', 69, 1, { string: 1, fret: 5, techniques: ['pull-off', 'vibrato'] }),
    note('d', 74, 1.5, { string: 1, fret: 10, techniques: ['slide-up'] }),
    note('e', 71, 2, { string: 1, fret: 7, techniques: ['slide-down'] }),
    note('f', 72, 2.5, {
      string: 1,
      fret: 8,
      techniques: ['bend'],
      pitch_curve_cents: [-50, 50],
    }),
  ])
  const ascii = asciiTab(decorated, 24)
  assert.match(ascii, /h8/)
  assert.match(ascii, /p5~/)
  assert.match(ascii, /\/10/)
  assert.match(ascii, /\\7/)
  const xml = musicXml(decorated)
  assert.match(xml, /^<\?xml/)
  assert.match(xml, /<score-partwise version="4.0">/)
  assert.match(xml, /<hammer-on type="start">H<\/hammer-on>/)
  assert.match(xml, /<hammer-on type="stop">H<\/hammer-on>/)
  assert.match(xml, /<pull-off type="start">P<\/pull-off>/)
  assert.match(xml, /<pull-off type="stop">P<\/pull-off>/)
  assert.match(xml, /<slide type="start" number="1"\/>/)
  assert.match(xml, /<slide type="stop" number="1"\/>/)
  assert.match(xml, /<other-technical>\\<\/other-technical>/)
  assert.match(xml, /<bend-alter>1<\/bend-alter>/)
  const midiBytes = midi(decorated)
  assert.equal(new TextDecoder().decode(midiBytes.slice(0, 4)), 'MThd')
  assert.equal(new TextDecoder().decode(midiBytes.slice(14, 18)), 'MTrk')
  assert.notEqual(
    Buffer.from(midiBytes).indexOf(Buffer.from([0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08])),
    -1,
  )
  const envelope = JSON.parse(projectJson(decorated))
  assert.equal(envelope.format, 'solotrace-project')
  assert.equal(envelope.project.versions.length, 1)
  assert.deepEqual(
    envelope.project.versions[0].tab.notes[1].techniques,
    ['hammer-on'],
  )

  for (const format of ['json', 'musicxml', 'midi', 'ascii']) {
    const artifact = exportProject(decorated, format)
    assert.ok(artifact.bytes.length > 20)
    assert.ok(artifact.filename.startsWith('northbound-lights'))
  }
})

test('MIDI encodes a compound 6/8 time signature exactly', () => {
  const compound = project()
  activeVersion(compound).tab.time_signature = [6, 8]
  const bytes = midi(compound)
  assert.notEqual(
    Buffer.from(bytes).indexOf(Buffer.from([0xff, 0x58, 0x04, 0x06, 0x03, 0x24, 0x08])),
    -1,
  )
})

test('MusicXML splits cross-measure notes and rejects overlap', () => {
  const crossing = project([
    note('crossing', 64, 0, { score_tick: 1_300, duration_ticks: 3_000 }),
  ])
  activeVersion(crossing).tab.time_signature = [6, 8]
  const xml = musicXml(crossing)
  assert.equal((xml.match(/<measure number=/g) ?? []).length, 3)
  assert.equal((xml.match(/<tie type="start"\/>/g) ?? []).length, 2)
  assert.equal((xml.match(/<tie type="stop"\/>/g) ?? []).length, 2)

  const overlapping = project([
    note('a', 64, 0, { score_tick: 0, duration_ticks: 480 }),
    note('b', 67, 0.2, { score_tick: 240, duration_ticks: 480 }),
  ])
  assert.throws(() => musicXml(overlapping), /monophonic/)
})
