import type { Fingering, FingeringMode, NoteEvent } from './types'

interface Weights {
  movement: number
  stringChange: number
  fretHeight: number
  openString: number
  positionCenter: number
}

export interface FingeringConstraints {
  allowedStrings?: readonly number[]
  minFret?: number | null
  maxFret?: number | null
}

type Voicing = Fingering[]

interface GroupState {
  cost: number
  choices: Voicing
  parentGroupIndex: number
  usedStrings: number
}

const WEIGHTS: Record<FingeringMode, Weights> = {
  balanced: {
    movement: 1,
    stringChange: 0.36,
    fretHeight: 0.018,
    openString: 0.22,
    positionCenter: 0.03,
  },
  easiest: {
    movement: 1.35,
    stringChange: 0.22,
    fretHeight: 0.06,
    openString: -0.2,
    positionCenter: 0.02,
  },
  position: {
    movement: 2.25,
    stringChange: 0.14,
    fretHeight: 0.012,
    openString: 0.4,
    positionCenter: 0.12,
  },
}

export type ConnectedTechnique = 'hammer-on' | 'pull-off' | 'slide'

const SLIDE_TECHNIQUES = new Set(['slide', 'slide-up', 'slide-down'])

/**
 * Connected techniques belong to their destination note: the current note is
 * reached from the immediately preceding note without a new picked attack.
 */
export function connectedTechnique(note: NoteEvent): ConnectedTechnique | undefined {
  const connections = [
    note.techniques.includes('hammer-on') ? 'hammer-on' : undefined,
    note.techniques.includes('pull-off') ? 'pull-off' : undefined,
    note.techniques.some((technique) => SLIDE_TECHNIQUES.has(technique))
      ? 'slide'
      : undefined,
  ].filter((technique): technique is ConnectedTechnique => technique !== undefined)
  if (connections.length > 1) {
    throw new Error(`Note ${note.id} has conflicting connected techniques`)
  }
  return connections[0]
}

function connectionIsPlayable(
  technique: ConnectedTechnique,
  previous: Pick<Fingering, 'string' | 'fret'>,
  current: Pick<Fingering, 'string' | 'fret'>,
): boolean {
  if (previous.string !== current.string) return false
  if (technique === 'hammer-on') return current.fret > previous.fret
  if (technique === 'pull-off') return current.fret < previous.fret
  return current.fret !== previous.fret
}

function chronologicalNotes(
  notes: readonly NoteEvent[],
): Array<{ note: NoteEvent; originalIndex: number }> {
  return notes
    .map((note, originalIndex) => ({ note, originalIndex }))
    .sort(
      (left, right) =>
        left.note.onset_frame - right.note.onset_frame ||
        left.originalIndex - right.originalIndex,
    )
}

/**
 * Check whether replacing one note's position keeps both its incoming
 * connection and the following note's incoming connection playable.
 */
export function fingeringPreservesConnectedTechniques(
  notes: readonly NoteEvent[],
  noteIndex: number,
  fingering: Pick<Fingering, 'string' | 'fret'>,
): boolean {
  const note = notes[noteIndex]
  if (!note) return false
  const chronological = chronologicalNotes(notes)
  const chronologicalIndex = chronological.findIndex(
    ({ originalIndex }) => originalIndex === noteIndex,
  )
  const candidate = { ...note, ...fingering }
  const incoming = connectedTechnique(candidate)
  const previous = chronological[chronologicalIndex - 1]?.note
  if (incoming && (!previous || !connectionIsPlayable(incoming, previous, candidate))) {
    return false
  }

  const next = chronological[chronologicalIndex + 1]?.note
  const outgoing = next && connectedTechnique(next)
  return !outgoing || connectionIsPlayable(outgoing, candidate, next)
}

export function validateConnectedTechniqueFingerings(notes: readonly NoteEvent[]): void {
  const chronological = chronologicalNotes(notes).map(({ note }) => note)
  chronological.forEach((note, index) => {
    const technique = connectedTechnique(note)
    if (!technique) return
    const previous = chronological[index - 1]
    if (!previous) {
      throw new Error(`Note ${note.id} cannot start with ${technique}`)
    }
    if (!connectionIsPlayable(technique, previous, note)) {
      throw new Error(
        `${technique} on note ${note.id} must connect from the previous note on the same string`,
      )
    }
  })
}

export function legalFingerings(
  midiPitch: number,
  tuning: readonly number[],
  fretCount: number,
): Fingering[] {
  const stringCount = tuning.length
  return tuning
    .flatMap((openPitch, lowIndex): Fingering[] => {
      const fret = midiPitch - openPitch
      if (fret < 0 || fret > fretCount) return []
      const string = stringCount - lowIndex
      return [{ string, fret, label: `String ${string}, fret ${fret}`, cost: 0 }]
    })
    .sort((left, right) => left.fret - right.fret || left.string - right.string)
}

function constrainedFingerings(
  fingerings: readonly Fingering[],
  constraints: FingeringConstraints | undefined,
): Fingering[] {
  if (!constraints) return [...fingerings]
  const allowedStrings = constraints.allowedStrings
    ? new Set(constraints.allowedStrings)
    : undefined
  return fingerings.filter(
    ({ string, fret }) =>
      (!allowedStrings || allowedStrings.has(string)) &&
      (constraints.minFret == null || fret >= constraints.minFret) &&
      (constraints.maxFret == null || fret <= constraints.maxFret),
  )
}

function handPosition(fingering: Fingering): number {
  return fingering.fret === 0 ? 1 : Math.max(1, fingering.fret - 1)
}

function localCost(
  fingering: Fingering,
  weights: Weights,
  preferredFret?: number | null,
): number {
  const openCost = fingering.fret === 0 ? weights.openString : 0
  const center = preferredFret ?? 8
  const positionCost = Math.abs(handPosition(fingering) - center) * weights.positionCenter
  return fingering.fret * weights.fretHeight + openCost + positionCost
}

function transitionCost(
  previous: Fingering,
  current: Fingering,
  weights: Weights,
): number {
  const movement = Math.abs(handPosition(previous) - handPosition(current))
  const stringChange = Math.abs(previous.string - current.string)
  const stretch = Math.max(0, Math.abs(previous.fret - current.fret) - 5)
  return (
    movement * weights.movement +
    stringChange * weights.stringChange +
    stretch * 1.4
  )
}

function roundedCost(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000
}

function noteGroups(notes: readonly NoteEvent[]): Array<[number, number]> {
  const groups: Array<[number, number]> = []
  let start = 0
  for (let index = 1; index <= notes.length; index += 1) {
    if (index === notes.length || notes[index].onset_frame !== notes[start].onset_frame) {
      groups.push([start, index])
      start = index
    }
  }
  return groups
}

function keepLowerCost(
  states: Map<string, GroupState>,
  key: string,
  candidate: GroupState,
): void {
  const current = states.get(key)
  if (!current || candidate.cost < current.cost) states.set(key, candidate)
}

function groupStates(
  notes: readonly NoteEvent[],
  candidates: readonly Fingering[][],
  start: number,
  end: number,
  weights: Weights,
  preferredFret?: number | null,
  previousStates?: readonly GroupState[],
): GroupState[] {
  // Each layer keeps only the cheapest path per used-string mask and terminal string.
  const firstTechnique = connectedTechnique(notes[start])
  if (!previousStates && firstTechnique) {
    throw new Error(`Note ${notes[start].id} cannot start with ${firstTechnique}`)
  }

  let layer = new Map<string, GroupState>()
  for (const choice of candidates[start]) {
    const usedStrings = 1 << (choice.string - 1)
    const key = `${usedStrings}:${choice.string}`
    if (!previousStates) {
      keepLowerCost(layer, key, {
        cost: localCost(choice, weights, preferredFret),
        choices: [choice],
        parentGroupIndex: -1,
        usedStrings,
      })
      continue
    }
    previousStates.forEach((previous, parentGroupIndex) => {
      if (
        firstTechnique &&
        !connectionIsPlayable(firstTechnique, previous.choices.at(-1)!, choice)
      ) {
        return
      }
      keepLowerCost(layer, key, {
        cost:
          previous.cost +
          transitionCost(previous.choices.at(-1)!, choice, weights) +
          localCost(choice, weights, preferredFret),
        choices: [choice],
        parentGroupIndex,
        usedStrings,
      })
    })
  }

  if (layer.size === 0) {
    throw new Error(
      `${firstTechnique ?? 'Fingering'} on note ${notes[start].id} has no playable connection from the previous note`,
    )
  }

  for (let noteIndex = start + 1; noteIndex < end; noteIndex += 1) {
    const nextLayer = new Map<string, GroupState>()
    const technique = connectedTechnique(notes[noteIndex])
    for (const state of layer.values()) {
      const { usedStrings } = state
      const previous = state.choices.at(-1)!
      for (const choice of candidates[noteIndex]) {
        const stringBit = 1 << (choice.string - 1)
        if ((usedStrings & stringBit) !== 0) continue
        if (technique && !connectionIsPlayable(technique, previous, choice)) continue
        keepLowerCost(
          nextLayer,
          `${usedStrings | stringBit}:${choice.string}`,
          {
            cost:
              state.cost +
              transitionCost(previous, choice, weights) +
              localCost(choice, weights, preferredFret),
            choices: [...state.choices, choice],
            parentGroupIndex: state.parentGroupIndex,
            usedStrings: usedStrings | stringBit,
          },
        )
      }
    }
    if (nextLayer.size === 0) throw unplayableVoicingError(notes, start, end)
    layer = nextLayer
  }

  const terminalStates = new Map<string, GroupState>()
  for (const state of layer.values()) {
    const terminal = state.choices.at(-1)!
    keepLowerCost(
      terminalStates,
      `${terminal.string}:${terminal.fret}`,
      state,
    )
  }
  return [...terminalStates.values()]
}

function unplayableVoicingError(
  notes: readonly NoteEvent[],
  start: number,
  end: number,
): Error {
  const noteIds = notes.slice(start, end).map(({ id }) => id).join(', ')
  return new Error(
    `Simultaneous notes ${noteIds} at frame ${notes[start].onset_frame} ` +
      'have no playable voicing on distinct strings',
  )
}

/** Deterministic dynamic-programming fingering assignment. Input notes stay untouched. */
export function assignFingerings(
  notes: readonly NoteEvent[],
  tuning: readonly number[],
  fretCount: number,
  mode: FingeringMode = 'balanced',
  preferredFret?: number | null,
  constraints?: FingeringConstraints,
): NoteEvent[] {
  if (notes.length === 0) return []
  const weights = WEIGHTS[mode]
  const indexedNotes = chronologicalNotes(notes)
  const arrangedNotes = indexedNotes.map(({ note }) => note)
  const unrestrictedCandidates = arrangedNotes.map((note) =>
    legalFingerings(note.midi_pitch, tuning, fretCount),
  )
  const candidates = arrangedNotes.map((note, noteIndex) => {
    const legal = unrestrictedCandidates[noteIndex]
    let choices = constrainedFingerings(legal, constraints)
    if (note.user_locked) {
      const locked = legal.find(
        (choice) => choice.string === note.string && choice.fret === note.fret,
      )
      if (!locked) {
        throw new Error(`Locked position for note ${note.id} is no longer playable`)
      }
      choices = [locked]
    }
    return choices
  })

  const missingIndex = candidates.findIndex((choices) => choices.length === 0)
  if (missingIndex >= 0) {
    throw new Error(
      `MIDI pitch ${arrangedNotes[missingIndex].midi_pitch} is outside this guitar range`,
    )
  }

  const groups = noteGroups(arrangedNotes)
  const groupHistory: GroupState[][] = []
  let previousStates: GroupState[] | undefined
  for (const [start, end] of groups) {
    if (end - start > tuning.length) {
      throw unplayableVoicingError(arrangedNotes, start, end)
    }
    const states = groupStates(
      arrangedNotes,
      candidates,
      start,
      end,
      weights,
      preferredFret,
      previousStates,
    )
    groupHistory.push(states)
    previousStates = states
  }

  const selected = Array<number>(groups.length).fill(0)
  selected[selected.length - 1] = groupHistory.at(-1)!.reduce(
    (best, state, index, row) => (state.cost < row[best].cost ? index : best),
    0,
  )
  for (let groupIndex = groups.length - 1; groupIndex > 0; groupIndex -= 1) {
    selected[groupIndex - 1] =
      groupHistory[groupIndex][selected[groupIndex]].parentGroupIndex
  }

  const selectedChoices = Array<Fingering>(arrangedNotes.length)
  const groupByNote = Array<number>(arrangedNotes.length)
  groups.forEach(([start, end], groupIndex) => {
    const choices = groupHistory[groupIndex][selected[groupIndex]].choices
    for (let noteIndex = start; noteIndex < end; noteIndex += 1) {
      selectedChoices[noteIndex] = choices[noteIndex - start]
      groupByNote[noteIndex] = groupIndex
    }
  })

  const selectedNotes = arrangedNotes.map((event, index) => ({
    ...event,
    string: selectedChoices[index].string,
    fret: selectedChoices[index].fret,
  }))
  const output = arrangedNotes.map((note, noteIndex) => {
    const choice = selectedChoices[noteIndex]
    const [groupStart, groupEnd] = groups[groupByNote[noteIndex]]
    const siblingStrings = new Set(
      selectedChoices
        .slice(groupStart, groupEnd)
        .filter((_, groupNoteIndex) => groupNoteIndex + groupStart !== noteIndex)
        .map(({ string }) => string),
    )
    const alternatives = (constraints && !note.user_locked
      ? unrestrictedCandidates[noteIndex]
      : candidates[noteIndex])
      .filter(
        (candidate) =>
          !siblingStrings.has(candidate.string) &&
          fingeringPreservesConnectedTechniques(selectedNotes, noteIndex, candidate),
      )
      .map((candidate) => ({
        ...candidate,
        cost: roundedCost(
          localCost(candidate, weights, preferredFret) +
            transitionCost(choice, candidate, weights),
        ),
      }))
      .sort((left, right) => left.cost - right.cost)
    const fingering =
      alternatives.length === 1 ? 1 : Math.max(0.62, 0.93 - 0.05 * (alternatives.length - 1))
    return {
      ...note,
      string: choice.string,
      fret: choice.fret,
      alternatives,
      confidence: { ...note.confidence, fingering },
    }
  })
  const restored = Array<NoteEvent>(notes.length)
  indexedNotes.forEach(({ originalIndex }, chronologicalIndex) => {
    restored[originalIndex] = output[chronologicalIndex]
  })
  return restored
}
