import { buildPlayMeasures, buildPlaySystems, timeForSystemX } from './tab-layout'
import { makeNote, makeProject } from './test-project'

describe('Play tab layout', () => {
  it('collapses long empty regions around a late solo and renders each note once', () => {
    const project = makeProject()
    const systems = buildPlaySystems(project, 1200)

    expect(systems[0]).toMatchObject({
      kind: 'rest',
      start_bar: 1,
      end_bar: 120,
      measure_count: 120,
    })
    expect(systems.at(-1)).toMatchObject({
      kind: 'rest',
      start_bar: 122,
      end_bar: 150,
      measure_count: 29,
    })
    const noteIds = systems.flatMap((system) =>
      system.kind === 'tab'
        ? system.measures.flatMap((measure) => measure.notes.map((note) => note.id))
        : [],
    )
    expect(noteIds).toEqual(['late-note'])
  })

  it('caps desktop lines at four measures and uses one measure per phone line', () => {
    const notes = [0, 2, 4, 6, 8].map((start, index) =>
      makeNote(`note-${index}`, start + 0.25, start + 0.75),
    )
    const project = makeProject({
      duration: 10,
      notes,
      passage: { name: 'Solo 1', start_s: 0, end_s: 10 },
    })

    const desktop = buildPlaySystems(project, 1500).filter(
      (system) => system.kind === 'tab',
    )
    const phone = buildPlaySystems(project, 340).filter(
      (system) => system.kind === 'tab',
    )
    const tablet = buildPlaySystems(project, 700).filter(
      (system) => system.kind === 'tab',
    )

    expect(desktop).toHaveLength(2)
    expect(desktop[0].kind === 'tab' && desktop[0].measures).toHaveLength(4)
    expect(phone).toHaveLength(5)
    phone.forEach((system) => {
      expect(system.kind === 'tab' && system.measures).toHaveLength(1)
    })
    expect(tablet[0].kind === 'tab' && tablet[0].measures).toHaveLength(2)
  })

  it('marks short quantized gaps with standard sixteenth rests', () => {
    const project = makeProject({
      duration: 2,
      notes: [makeNote('held-note', 0, 1.875)],
      passage: { name: 'Solo 1', start_s: 0, end_s: 2 },
    })

    const measures = buildPlayMeasures(project)
    expect(measures[0].rests.at(-1)?.value).toBe('sixteenth')
  })

  it('keeps a partial final measure and maps staff positions to its shorter time span', () => {
    const project = makeProject({
      duration: 2.5,
      notes: [makeNote('final-note', 2.1, 2.4)],
      passage: { name: 'Solo 1', start_s: 2.1, end_s: 2.4 },
    })

    const measures = buildPlayMeasures(project)
    expect(measures).toHaveLength(2)
    expect(measures[1]).toMatchObject({ start_s: 2, end_s: 2.5 })

    const system = buildPlaySystems(project, 1200).find(
      (candidate) => candidate.kind === 'tab',
    )
    expect(system?.kind).toBe('tab')
    if (system?.kind !== 'tab') return
    const finalMeasure = system.measures[0]
    expect(timeForSystemX(system, finalMeasure.x + finalMeasure.width)).toBeCloseTo(2.5)
  })

  it('gives an exceptionally dense measure local overflow instead of shrinking it', () => {
    const notes = Array.from({ length: 16 }, (_, index) =>
      makeNote(`dense-${index}`, index * 0.1, index * 0.1 + 0.08),
    )
    const project = makeProject({
      duration: 2,
      notes,
      passage: { name: 'Solo 1', start_s: 0, end_s: 2 },
    })

    const system = buildPlaySystems(project, 340)[0]
    expect(system.kind).toBe('tab')
    expect(system.width).toBeGreaterThan(340)
  })

  it('aligns passage-local sync ticks with song-wide bar numbers', () => {
    const project = makeProject()
    project.tab.sync_anchors = [
      { audio_frame: 239 * 48_000, score_tick: 0 },
      { audio_frame: 250 * 48_000, score_tick: 10_560 },
    ]

    const systems = buildPlaySystems(project, 1200)
    expect(systems[0]).toMatchObject({
      kind: 'rest',
      start_bar: 1,
      end_bar: 120,
    })
    const noteSystem = systems.find(
      (system) =>
        system.kind === 'tab' &&
        system.measures.some((measure) =>
          measure.notes.some((note) => note.id === 'late-note'),
        ),
    )
    expect(noteSystem?.kind).toBe('tab')
    expect(
      noteSystem?.kind === 'tab'
        ? noteSystem.measures.find((measure) => measure.notes.length)?.number
        : null,
    ).toBe(121)
  })
})
