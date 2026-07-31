import type {
  EditorClientAdapter,
  EditorProject,
  ExportArtifact,
  ExportFormat,
  HostedCapabilityFlags,
  ProjectReference,
  SaveProjectRequest,
  TabVersion,
  VersionActionRequest,
  RefingerProjectRequest,
} from '@solotrace/editor'
import { api, ApiError } from './api'
import type { Project } from './types'

const desktopProjectEnvelopes = new WeakMap<EditorProject, Project>()

/**
 * Desktop keeps uploads, processing, settings, diagnostics, Trash, and project
 * bundles in its existing APIs. This adapter is only the small editor seam.
 */
export const DESKTOP_EDITOR_CAPABILITIES = Object.freeze({
  anonymousEditing: false,
  localDrafts: false,
  saveCopies: false,
  uploads: true,
  processing: true,
  chordRecognition: true,
  projectBundles: true,
  maxSavedCopies: 0,
  maxDocumentBytes: 0,
}) satisfies Readonly<HostedCapabilityFlags>

function activeVersion(project: Project): TabVersion {
  const summary = project.versions.find(
    (version) => version.id === project.active_version_id,
  )
  return {
    id: project.active_version_id,
    name: summary?.name ?? 'Active version',
    source: summary?.source ?? 'desktop',
    fingering_mode: summary?.fingering_mode ?? 'balanced',
    created_at: summary?.created_at ?? project.created_at,
    updated_at: summary?.updated_at ?? project.updated_at,
    tab: project.tab,
  }
}

/**
 * The desktop project endpoint returns full tab data for the active version and
 * summaries for the others. The adapter therefore exposes the active version;
 * activating another version reloads its complete tab from the server.
 */
export function toEditorProject(project: Project): EditorProject {
  const editorProject: EditorProject = {
    id: project.id,
    title: project.title,
    artist: project.artist,
    created_at: project.created_at,
    updated_at: project.updated_at,
    revision: project.revision,
    duration_s: project.duration_s,
    passage: project.passage,
    assets: project.assets,
    versions: [activeVersion(project)],
    active_version_id: project.active_version_id,
    source_name: project.source_name,
    origin: 'local',
    waveform_peaks: project.waveform_peaks,
    provenance: project.provenance,
    separation_scope: project.separation_scope,
  }
  desktopProjectEnvelopes.set(editorProject, project)
  return editorProject
}

/** Recover desktop-only state after an operation through the shared seam. */
export function toDesktopProject(project: EditorProject): Project {
  const desktopProject = desktopProjectEnvelopes.get(project)
  if (!desktopProject) {
    throw new Error('This editor project did not come from the desktop adapter')
  }
  return desktopProject
}

function requireLocalReference(reference: ProjectReference): string {
  if (reference.origin !== 'local') {
    throw new Error('The desktop adapter only loads local SoloTrace projects')
  }
  return reference.id
}

function exportMimeType(format: ExportFormat): string {
  if (format === 'json') return 'application/json'
  if (format === 'musicxml') return 'application/vnd.recordare.musicxml+xml'
  if (format === 'midi') return 'audio/midi'
  return 'text/plain'
}

function exportFilename(response: Response, project: EditorProject, format: ExportFormat): string {
  const disposition = response.headers.get('content-disposition') ?? ''
  const match = /filename="?([^";]+)"?/i.exec(disposition)
  if (match?.[1]) return match[1]
  const extension = format === 'musicxml' ? 'musicxml' : format === 'midi' ? 'mid' : format
  return `${project.title.trim() || 'solotrace'}.${extension}`
}

async function readExport(project: EditorProject, format: ExportFormat): Promise<ExportArtifact> {
  const projectId = encodeURIComponent(project.id)
  const versionId = encodeURIComponent(project.active_version_id)
  const response = await fetch(
    `/api/projects/${projectId}/export/${format}?version_id=${versionId}`,
  )
  if (!response.ok) {
    let message = `Export failed (${response.status})`
    try {
      const payload = (await response.json()) as { detail?: string }
      message = payload.detail ?? message
    } catch {
      // Keep the status-based message for non-JSON proxy responses.
    }
    throw new ApiError(message, response.status)
  }
  return {
    format,
    filename: exportFilename(response, project, format),
    mimeType: response.headers.get('content-type') ?? exportMimeType(format),
    bytes: new Uint8Array(await response.arrayBuffer()),
  }
}

export class DesktopEditorClient implements EditorClientAdapter {
  readonly capabilities = DESKTOP_EDITOR_CAPABILITIES

  async loadProject(reference: ProjectReference): Promise<EditorProject> {
    return toEditorProject(await api.getProject(requireLocalReference(reference)))
  }

  async saveProject(request: SaveProjectRequest): Promise<EditorProject> {
    if (request.asCopy || request.project.origin !== 'local') {
      throw new Error('Desktop save-copy is outside the shared editor interface')
    }
    const version = request.project.versions.find(
      (candidate) => candidate.id === request.project.active_version_id,
    )
    if (!version) throw new Error('The active version is missing')

    // Title, passage, and audio lifecycle remain explicit desktop APIs. The
    // shared save operation persists only the active editor document.
    const project = await api.patchNotes(
      request.project.id,
      request.project.active_version_id,
      request.expectedRevision ?? request.project.revision,
      version.tab.notes,
    )
    return toEditorProject(project)
  }

  async refingerProject(request: RefingerProjectRequest): Promise<EditorProject> {
    return toEditorProject(
      await api.createVersion(
        request.projectId,
        request.expectedRevision,
        request.sourceVersionId,
        request.mode,
        request.name,
        request.lockPolicy,
        request.range,
        request.constraints,
      ),
    )
  }

  async applyVersionAction(request: VersionActionRequest): Promise<EditorProject> {
    const { action, expectedRevision, projectId } = request
    if (action.type === 'activate') {
      return toEditorProject(
        await api.activateVersion(projectId, action.versionId, expectedRevision),
      )
    }
    if (action.type === 'rename') {
      return toEditorProject(
        await api.renameVersion(
          projectId,
          action.versionId,
          expectedRevision,
          action.name,
        ),
      )
    }
    if (action.type === 'replace-notes') {
      return toEditorProject(
        await api.patchNotes(
          projectId,
          action.versionId,
          expectedRevision,
          action.notes,
        ),
      )
    }
    if (action.type === 'replace-chords') {
      return toEditorProject(
        await api.patchChords(
          projectId,
          action.versionId,
          expectedRevision,
          action.track,
        ),
      )
    }
    if (action.type === 'replace-beat-map') {
      return toEditorProject(
        await api.patchBeatMap(
          projectId,
          action.versionId,
          expectedRevision,
          action.beatMap,
        ),
      )
    }
    return toEditorProject(
      await api.deleteVersion(projectId, action.versionId, expectedRevision),
    )
  }

  exportProject({ project, format }: { project: EditorProject; format: ExportFormat }) {
    return readExport(project, format)
  }
}

export const desktopEditorClient = new DesktopEditorClient()
