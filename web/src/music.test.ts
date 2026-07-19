import {
  audioFrameToScoreTick,
  formatTime,
  pitchName,
  scoreTickToAudioFrame,
} from './music'

describe('music helpers', () => {
  it('maps audio frames through non-uniform sync anchors', () => {
    const anchors = [
      { audio_frame: 0, score_tick: 0 },
      { audio_frame: 48_000, score_tick: 480 },
      { audio_frame: 100_000, score_tick: 960 },
    ]
    expect(audioFrameToScoreTick(24_000, anchors)).toBe(240)
    expect(audioFrameToScoreTick(74_000, anchors)).toBe(720)
    expect(audioFrameToScoreTick(126_000, anchors)).toBe(1200)
    expect(scoreTickToAudioFrame(720, anchors)).toBe(74_000)
    expect(scoreTickToAudioFrame(1200, anchors)).toBe(126_000)
  })

  it('formats musician-facing pitch and time labels', () => {
    expect(pitchName(69)).toBe('A4')
    expect(formatTime(102.375, true)).toBe('01:42.38')
    expect(formatTime(59.6)).toBe('01:00')
    expect(formatTime(59.999, true)).toBe('01:00.00')
  })
})
