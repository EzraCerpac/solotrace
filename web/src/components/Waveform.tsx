import { useEffect, useRef } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import type { Region } from 'wavesurfer.js/dist/plugins/regions.js'

import { formatTime } from '../music'
import type { Passage } from '../types'

interface WaveformProps {
  audio: HTMLAudioElement | null
  audioUrl: string
  currentTime: number
  duration: number
  peaks: number[]
  passage: Passage
  onPassageChange: (passage: Passage) => void
  onSeek: (seconds: number) => void
}

export function Waveform({
  audio,
  audioUrl,
  currentTime,
  duration,
  peaks,
  passage,
  onPassageChange,
  onSeek,
}: WaveformProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const passageRef = useRef(passage)
  const currentTimeRef = useRef(currentTime)
  const regionRef = useRef<Region | null>(null)
  const peaksRef = useRef(peaks)

  useEffect(() => {
    peaksRef.current = peaks
  }, [audioUrl, peaks])

  useEffect(() => {
    passageRef.current = passage
    const region = regionRef.current
    if (
      region &&
      (Math.abs(region.start - passage.start_s) > 0.001 ||
        Math.abs(region.end - passage.end_s) > 0.001)
    ) {
      region.setOptions({
        start: Math.max(0, passage.start_s),
        end: Math.min(duration, passage.end_s),
      })
    }
  }, [duration, passage])

  useEffect(() => {
    currentTimeRef.current = currentTime
  }, [currentTime])

  useEffect(() => {
    if (!audio || !containerRef.current || !audioUrl) return
    const regions = RegionsPlugin.create()
    const wavesurfer = WaveSurfer.create({
      container: containerRef.current,
      media: audio,
      height: 104,
      waveColor: '#aebbb8',
      progressColor: '#176c66',
      cursorColor: '#a94430',
      cursorWidth: 2,
      barWidth: 2,
      barGap: 2,
      barRadius: 2,
      normalize: true,
      dragToSeek: true,
      autoScroll: false,
      autoCenter: false,
      plugins: [regions],
      peaks: peaksRef.current.length ? [peaksRef.current] : undefined,
      duration,
    })

    let soloRegion: ReturnType<typeof regions.addRegion> | undefined
    const unsubscribeReady = wavesurfer.on('ready', () => {
      audio.currentTime = Math.min(currentTimeRef.current, duration)
      const current = passageRef.current
      soloRegion = regions.addRegion({
        id: 'solo-passage',
        start: Math.max(0, current.start_s),
        end: Math.min(duration, current.end_s),
        color: 'rgba(23, 108, 102, 0.16)',
        drag: true,
        resize: true,
        minLength: 0.2,
      })
      regionRef.current = soloRegion
    })
    const unsubscribeInteraction = wavesurfer.on('interaction', (seconds) => {
      onSeek(seconds)
    })
    const unsubscribeRegion = regions.on('region-updated', (region) => {
      if (region.id !== 'solo-passage') return
      onPassageChange({
        ...passageRef.current,
        start_s: region.start,
        end_s: region.end,
      })
    })

    return () => {
      unsubscribeReady()
      unsubscribeInteraction()
      unsubscribeRegion()
      soloRegion?.remove()
      regionRef.current = null
      wavesurfer.destroy()
    }
  }, [audio, audioUrl, duration, onPassageChange, onSeek])

  return (
    <section className="waveform-panel" aria-label="Song waveform">
      <div className="waveform-ruler" aria-hidden="true">
        <span>{formatTime(0)}</span>
        <span>Drag edges to mark solo</span>
        <span>{formatTime(duration)}</span>
      </div>
      <div className="waveform" ref={containerRef} data-testid="waveform" />
      <div className="passage-fields">
        <label>
          Solo starts
          <input
            type="number"
            min="0"
            max={passage.end_s - 0.1}
            step="0.05"
            value={passage.start_s.toFixed(2)}
            onChange={(event) =>
              onPassageChange({
                ...passage,
                start_s: Number(event.target.value),
              })
            }
          />
        </label>
        <label>
          Solo ends
          <input
            type="number"
            min={passage.start_s + 0.1}
            max={duration}
            step="0.05"
            value={passage.end_s.toFixed(2)}
            onChange={(event) =>
              onPassageChange({
                ...passage,
                end_s: Number(event.target.value),
              })
            }
          />
        </label>
      </div>
    </section>
  )
}
