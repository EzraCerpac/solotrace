import type { SyncAnchor } from './types'

const pitchClasses = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']

export function pitchName(midi: number): string {
  return `${pitchClasses[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

export function formatTime(seconds: number, precise = false): string {
  if (!Number.isFinite(seconds)) return '00:00'
  const safe = Math.max(0, seconds)
  const scale = precise ? 100 : 1
  const totalUnits = Math.round(safe * scale)
  const minutes = Math.floor(totalUnits / (60 * scale))
  const remaining = (totalUnits - minutes * 60 * scale) / scale
  return `${String(minutes).padStart(2, '0')}:${remaining
    .toFixed(precise ? 2 : 0)
    .padStart(precise ? 5 : 2, '0')}`
}

export function minimumConfidence(confidence: {
  pitch: number
  onset: number
  fingering: number
  technique: number
}): number {
  return Math.min(
    confidence.pitch,
    confidence.onset,
    confidence.fingering,
    confidence.technique,
  )
}

export function audioFrameToScoreTick(
  audioFrame: number,
  anchors: SyncAnchor[],
): number {
  if (anchors.length === 0) return 0
  if (audioFrame <= anchors[0].audio_frame) return anchors[0].score_tick
  for (let index = 1; index < anchors.length; index += 1) {
    const right = anchors[index]
    const left = anchors[index - 1]
    if (audioFrame <= right.audio_frame) {
      const frameSpan = right.audio_frame - left.audio_frame
      if (frameSpan === 0) return right.score_tick
      const progress = (audioFrame - left.audio_frame) / frameSpan
      return Math.round(left.score_tick + progress * (right.score_tick - left.score_tick))
    }
  }
  const last = anchors.at(-1)!
  const previous = anchors.at(-2) ?? last
  const frameSpan = last.audio_frame - previous.audio_frame
  if (frameSpan === 0) return last.score_tick
  const ticksPerFrame = (last.score_tick - previous.score_tick) / frameSpan
  return Math.round(last.score_tick + (audioFrame - last.audio_frame) * ticksPerFrame)
}

export function scoreTickToAudioFrame(
  scoreTick: number,
  anchors: SyncAnchor[],
): number {
  if (anchors.length === 0) return 0
  if (scoreTick <= anchors[0].score_tick) return anchors[0].audio_frame
  for (let index = 1; index < anchors.length; index += 1) {
    const right = anchors[index]
    const left = anchors[index - 1]
    if (scoreTick <= right.score_tick) {
      const tickSpan = right.score_tick - left.score_tick
      if (tickSpan === 0) return right.audio_frame
      const progress = (scoreTick - left.score_tick) / tickSpan
      return Math.round(left.audio_frame + progress * (right.audio_frame - left.audio_frame))
    }
  }
  const last = anchors.at(-1)!
  const previous = anchors.at(-2) ?? last
  const tickSpan = last.score_tick - previous.score_tick
  if (tickSpan === 0) return last.audio_frame
  const framesPerTick = (last.audio_frame - previous.audio_frame) / tickSpan
  return Math.round(last.audio_frame + (scoreTick - last.score_tick) * framesPerTick)
}
