import type { TabDocument } from './types'

export function soundingTuning(tab: TabDocument): number[] {
  return tab.tuning.map((pitch) => pitch + (tab.capo_fret ?? 0))
}

export function availableFretCount(tab: TabDocument): number {
  return tab.fret_count - (tab.capo_fret ?? 0)
}
