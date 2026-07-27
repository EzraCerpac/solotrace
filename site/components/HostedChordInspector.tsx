"use client";

import {
  deleteChordToUnknown,
  formatChordSymbol,
  mergeChord,
  moveChordBoundary,
  normalizeChordTrack,
  replaceChordSymbol,
  setChordReviewed,
  splitChord,
  type ChordEvent,
  type ChordTrack,
  type TabDocument,
} from "@solotrace/editor";
import { useState } from "react";

export function HostedChordInspector({
  chord,
  track,
  tab,
  currentTime,
  disabled,
  onChange,
}: {
  chord: ChordEvent;
  track: ChordTrack;
  tab: TabDocument;
  currentTime: number;
  disabled: boolean;
  onChange: (track: ChordTrack, message: string) => void;
}) {
  const [symbol, setSymbol] = useState(formatChordSymbol(chord));
  const [start, setStart] = useState(chord.audio_onset_s);
  const [end, setEnd] = useState(chord.audio_offset_s);
  const index = track.events.findIndex((candidate) => candidate.id === chord.id);

  const commit = (next: ChordTrack, message: string) => {
    try {
      onChange(normalizeChordTrack(next, tab), message);
    } catch (error) {
      onChange(track, error instanceof Error ? error.message : "Chord edit failed.");
    }
  };

  return (
    <div className="hosted-chord-editor">
      <h3>Chord review</h3>
      <dl className="example-studio__note-facts">
        <div><dt>Symbol</dt><dd>{formatChordSymbol(chord)}</dd></div>
        <div><dt>Status</dt><dd>{chord.reviewed ? "Reviewed" : "Needs review"}</dd></div>
        <div>
          <dt>Model score</dt>
          <dd>{chord.model_score === null ? "Manual" : Math.round(chord.model_score * 100)}</dd>
        </div>
      </dl>
      <label className="hosted-chord-editor__field">
        Chord symbol
        <input
          value={symbol}
          disabled={disabled}
          onChange={(event) => setSymbol(event.target.value)}
        />
      </label>
      <div className="hosted-chord-editor__timing">
        <label>
          Exact start
          <input
            type="number"
            step="0.001"
            value={Number(start.toFixed(3))}
            disabled={disabled || index === 0}
            onChange={(event) => setStart(Number(event.target.value))}
          />
        </label>
        <label>
          Exact end
          <input
            type="number"
            step="0.001"
            value={Number(end.toFixed(3))}
            disabled={disabled || index === track.events.length - 1}
            onChange={(event) => setEnd(Number(event.target.value))}
          />
        </label>
      </div>
      <div className="example-studio__refinger-actions">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            let next = replaceChordSymbol(track, chord.id, symbol);
            if (index > 0 && start !== chord.audio_onset_s) {
              next = moveChordBoundary(next, track.events[index - 1].id, start);
            }
            if (index < track.events.length - 1 && end !== chord.audio_offset_s) {
              next = moveChordBoundary(next, chord.id, end);
            }
            commit(setChordReviewed(next, chord.id, true), "Chord changes applied.");
          }}
        >
          Save chord
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            commit(
              setChordReviewed(track, chord.id, !chord.reviewed),
              chord.reviewed ? "Chord reopened." : "Chord accepted.",
            )
          }
        >
          {chord.reviewed ? "Reopen" : "Accept"}
        </button>
        <button
          type="button"
          disabled={
            disabled ||
            currentTime <= chord.audio_onset_s ||
            currentTime >= chord.audio_offset_s
          }
          onClick={() =>
            commit(
              splitChord(track, chord.id, currentTime, `chord-${crypto.randomUUID()}`),
              "Chord split at playhead.",
            )
          }
        >
          Split
        </button>
        <button
          type="button"
          disabled={disabled || index === 0}
          onClick={() => commit(mergeChord(track, chord.id, "left"), "Chord merged left.")}
        >
          Merge left
        </button>
        <button
          type="button"
          disabled={disabled || index === track.events.length - 1}
          onClick={() => commit(mergeChord(track, chord.id, "right"), "Chord merged right.")}
        >
          Merge right
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            commit(deleteChordToUnknown(track, chord.id), "Chord changed to unknown.")
          }
        >
          Set unknown
        </button>
      </div>
      {chord.alternatives.length > 0 ? (
        <div className="hosted-chord-editor__alternatives">
          <span>Alternatives</span>
          {chord.alternatives.map((alternative, candidateIndex) => {
            const candidate = { ...chord, ...alternative, bass: null };
            return (
              <button
                type="button"
                key={`${formatChordSymbol(candidate)}-${candidateIndex}`}
                disabled={disabled}
                onClick={() => setSymbol(formatChordSymbol(candidate))}
              >
                {formatChordSymbol(candidate)} · {Math.round(alternative.model_score * 100)}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
