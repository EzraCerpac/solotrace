import type { Fingering, FingeringMode, NoteEvent } from './types'

interface Weights {
  movement: number
  stringChange: number
  fretHeight: number
  openString: number
  positionCenter: number
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
  const candidate = { ...note, ...fingering }
  const incoming = connectedTechnique(candidate)
  const previous = notes[noteIndex - 1]
  if (incoming && (!previous || !connectionIsPlayable(incoming, previous, candidate))) {
    return false
  }

  const next = notes[noteIndex + 1]
  const outgoing = next && connectedTechnique(next)
  return !outgoing || connectionIsPlayable(outgoing, candidate, next)
}

export function validateConnectedTechniqueFingerings(notes: readonly NoteEvent[]): void {
  notes.forEach((note, index) => {
    const technique = connectedTechnique(note)
    if (!technique) return
    const previous = notes[index - 1]
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

function handPosition(fingering: Fingering): number {
  return fingering.fret === 0 ? 1 : Math.max(1, fingering.fret - 1)
}

function localCost(fingering: Fingering, weights: Weights): number {
  const openCost = fingering.fret === 0 ? weights.openString : 0
  const positionCost = Math.abs(handPosition(fingering) - 8) * weights.positionCenter
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

/** Deterministic dynamic-programming fingering assignment. Input notes stay untouched. */
export function assignFingerings(
  notes: readonly NoteEvent[],
  tuning: readonly number[],
  fretCount: number,
  mode: FingeringMode = 'balanced',
): NoteEvent[] {
  if (notes.length === 0) return []
  const weights = WEIGHTS[mode]
  const candidates = notes.map((note) => {
    let choices = legalFingerings(note.midi_pitch, tuning, fretCount)
    if (note.user_locked) {
      const locked = choices.find(
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
    throw new Error(`MIDI pitch ${notes[missingIndex].midi_pitch} is outside this guitar range`)
  }

  const costs: number[][] = [candidates[0].map((choice) => localCost(choice, weights))]
  const parents: number[][] = [candidates[0].map(() => -1)]

  const firstTechnique = connectedTechnique(notes[0])
  if (firstTechnique) {
    throw new Error(`Note ${notes[0].id} cannot start with ${firstTechnique}`)
  }

  for (let noteIndex = 1; noteIndex < notes.length; noteIndex += 1) {
    const technique = connectedTechnique(notes[noteIndex])
    const rowCosts: number[] = []
    const rowParents: number[] = []
    for (const current of candidates[noteIndex]) {
      let bestCost = Number.POSITIVE_INFINITY
      let bestParent = -1
      candidates[noteIndex - 1].forEach((previous, parentIndex) => {
        if (technique && !connectionIsPlayable(technique, previous, current)) return
        const cost =
          costs[noteIndex - 1][parentIndex] +
          transitionCost(previous, current, weights) +
          localCost(current, weights)
        if (cost < bestCost) {
          bestCost = cost
          bestParent = parentIndex
        }
      })
      rowCosts.push(bestCost)
      rowParents.push(bestParent)
    }
    if (rowParents.every((parent) => parent < 0)) {
      throw new Error(
        `${technique ?? 'Fingering'} on note ${notes[noteIndex].id} has no playable connection from the previous note`,
      )
    }
    costs.push(rowCosts)
    parents.push(rowParents)
  }

  const selected = Array<number>(notes.length).fill(0)
  selected[selected.length - 1] = costs.at(-1)!.reduce(
    (best, cost, index, row) => (cost < row[best] ? index : best),
    0,
  )
  for (let noteIndex = notes.length - 1; noteIndex > 0; noteIndex -= 1) {
    selected[noteIndex - 1] = parents[noteIndex][selected[noteIndex]]
  }

  const selectedNotes = notes.map((event, index) => ({
    ...event,
    string: candidates[index][selected[index]].string,
    fret: candidates[index][selected[index]].fret,
  }))
  return notes.map((note, noteIndex) => {
    const choice = candidates[noteIndex][selected[noteIndex]]
    const alternatives = candidates[noteIndex]
      .filter((candidate) =>
        fingeringPreservesConnectedTechniques(selectedNotes, noteIndex, candidate),
      )
      .map((candidate) => ({
        ...candidate,
        cost: roundedCost(
          localCost(candidate, weights) + transitionCost(choice, candidate, weights),
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
}
