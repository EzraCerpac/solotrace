import { describe, expect, test } from 'vitest'

import { emptyChordTrack } from '@solotrace/editor'
import { makeNote, makeProject } from './test-project'
import { noteReviewReasons, reviewItemsForProject } from './review'

describe('review queue', () => {
  test('combines uncertain notes and unreviewed chords in time order', () => {
    const uncertain = makeNote('uncertain', 2, 2.4)
    uncertain.confidence.pitch = 0.41
    const confident = makeNote('confident', 1, 1.4)
    const reviewed = makeNote('reviewed', 3, 3.4)
    reviewed.confidence.onset = 0.3
    reviewed.reviewed = true
    const project = makeProject({
      duration: 5,
      passage: { name: 'Song', start_s: 0, end_s: 5 },
      notes: [confident, uncertain, reviewed],
    })
    project.tab.chords = {
      ...emptyChordTrack(),
      events: [
        {
          id: 'chord',
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
          model_score: 0.6,
          alternatives: [],
          provenance: 'detected',
          edited: false,
          reviewed: false,
        },
      ],
    }

    expect(reviewItemsForProject(project)).toEqual([
      { id: 'chord', kind: 'chord', time: 1 },
      { id: 'uncertain', kind: 'note', time: 2 },
    ])
  })

  test('names every confidence dimension that needs review', () => {
    const note = makeNote('uncertain', 1, 2)
    note.confidence = {
      pitch: 0.7,
      onset: 0.4,
      fingering: 0.71,
      technique: 0.9,
    }

    expect(noteReviewReasons(note)).toEqual(['timing', 'pitch', 'fingering'])
  })
})
