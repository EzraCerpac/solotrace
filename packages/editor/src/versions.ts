import { assignFingerings } from './fingering'
import type {
  EditorProject,
  FingeringMode,
  TabVersion,
  VersionAction,
} from './types'

export function activeVersion(project: EditorProject): TabVersion {
  const version = project.versions.find((candidate) => candidate.id === project.active_version_id)
  if (!version) throw new Error(`Active version ${project.active_version_id} does not exist`)
  return version
}

export interface CreateRefingeredVersionOptions {
  sourceVersionId?: string
  mode: FingeringMode
  versionId: string
  name: string
  createdAt: string
}

export function createRefingeredVersion(
  project: EditorProject,
  options: CreateRefingeredVersionOptions,
): EditorProject {
  if (project.versions.some((version) => version.id === options.versionId)) {
    throw new Error(`Version ${options.versionId} already exists`)
  }
  const sourceId = options.sourceVersionId ?? project.active_version_id
  const source = project.versions.find((version) => version.id === sourceId)
  if (!source) throw new Error(`Source version ${sourceId} does not exist`)
  const notes = assignFingerings(
    source.tab.notes,
    source.tab.tuning,
    source.tab.fret_count,
    options.mode,
  )
  const version: TabVersion = {
    id: options.versionId,
    name: options.name,
    source: `refingered:${source.id}`,
    fingering_mode: options.mode,
    created_at: options.createdAt,
    updated_at: options.createdAt,
    tab: {
      ...source.tab,
      tuning: [...source.tab.tuning],
      time_signature: [...source.tab.time_signature],
      sync_anchors: source.tab.sync_anchors.map((anchor) => ({ ...anchor })),
      notes,
      chords: {
        ...source.tab.chords,
        events: source.tab.chords.events.map((event) => ({
          ...event,
          root: event.root ? { ...event.root } : null,
          bass: event.bass ? { ...event.bass } : null,
          alternatives: event.alternatives.map((alternative) => ({
            ...alternative,
            root: alternative.root ? { ...alternative.root } : null,
          })),
        })),
      },
    },
  }
  return {
    ...project,
    revision: project.revision + 1,
    updated_at: options.createdAt,
    versions: [...project.versions, version],
    active_version_id: version.id,
  }
}

export function applyVersionAction(
  project: EditorProject,
  action: VersionAction,
  updatedAt: string,
): EditorProject {
  const target = project.versions.find((version) => version.id === action.versionId)
  if (!target) throw new Error(`Version ${action.versionId} does not exist`)

  let versions = project.versions
  let activeVersionId = project.active_version_id
  if (action.type === 'activate') {
    activeVersionId = action.versionId
  } else if (action.type === 'rename') {
    const name = action.name.trim()
    if (!name) throw new Error('Version name cannot be empty')
    versions = versions.map((version) =>
      version.id === action.versionId ? { ...version, name, updated_at: updatedAt } : version,
    )
  } else if (action.type === 'replace-notes') {
    versions = versions.map((version) =>
      version.id === action.versionId
        ? {
            ...version,
            updated_at: updatedAt,
            tab: { ...version.tab, notes: [...action.notes] },
          }
        : version,
    )
  } else if (action.type === 'replace-chords') {
    versions = versions.map((version) =>
      version.id === action.versionId
        ? {
            ...version,
            updated_at: updatedAt,
            tab: { ...version.tab, chords: action.track },
          }
        : version,
    )
  } else {
    if (versions.length === 1) throw new Error('Cannot delete the only version')
    versions = versions.filter((version) => version.id !== action.versionId)
    if (activeVersionId === action.versionId) activeVersionId = versions[0].id
  }

  return {
    ...project,
    revision: project.revision + 1,
    updated_at: updatedAt,
    versions,
    active_version_id: activeVersionId,
  }
}
