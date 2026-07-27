import { minimumConfidence } from './music'
import type { NoteEvent, Project } from './types'

export const REVIEW_CONFIDENCE_THRESHOLD = 0.72

export interface ReviewItem {
  id: string
  kind: 'note' | 'chord'
  time: number
}

export function reviewItemsForProject(project: Project): ReviewItem[] {
  return [
    ...project.tab.notes
      .filter(
        (note) =>
          !note.reviewed &&
          minimumConfidence(note.confidence) < REVIEW_CONFIDENCE_THRESHOLD,
      )
      .map((note) => ({
        id: note.id,
        kind: 'note' as const,
        time: note.audio_onset_s,
      })),
    ...project.tab.chords.events
      .filter((chord) => !chord.reviewed)
      .map((chord) => ({
        id: chord.id,
        kind: 'chord' as const,
        time: chord.audio_onset_s,
      })),
  ].sort(
    (left, right) =>
      left.time - right.time ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id),
  )
}

const CONFIDENCE_LABELS: Record<keyof NoteEvent['confidence'], string> = {
  pitch: 'pitch',
  onset: 'timing',
  fingering: 'fingering',
  technique: 'technique',
}

export function noteReviewReasons(note: NoteEvent): string[] {
  return Object.entries(note.confidence)
    .filter(([, confidence]) => confidence < REVIEW_CONFIDENCE_THRESHOLD)
    .sort((left, right) => left[1] - right[1])
    .map(([kind]) => CONFIDENCE_LABELS[kind as keyof NoteEvent['confidence']])
}
