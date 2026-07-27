import type {
  Capabilities,
  DraftEngine,
  FingeringMode,
  NoteEvent,
  Passage,
  Project,
  ProjectSummary,
} from './types'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const payload = (await response.json()) as {
        detail?:
          | string
          | Array<{
              loc?: Array<string | number>
              msg?: string
              type?: string
            }>
      }

      if (typeof payload.detail === 'string') {
        message = payload.detail
      } else if (Array.isArray(payload.detail)) {
        message = payload.detail
          .map((error) => {
            const location = error.loc
              ?.filter((part) => part !== 'body')
              .join('.')

            return location
              ? `${location}: ${error.msg ?? 'Invalid value'}`
              : error.msg ?? 'Invalid request'
          })
          .join('; ')
      }
    } catch {
      // Keep status-based fallback when a proxy or server returns non-JSON.
    }
    throw new ApiError(message, response.status)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const api = {
  listProjects: (includeTrashed = false) =>
    request<ProjectSummary[]>(
      `/api/projects${includeTrashed ? '?include_trashed=true' : ''}`,
    ),

  getProject: (projectId: string) =>
    request<Project>(`/api/projects/${encodeURIComponent(projectId)}`),

  capabilities: () => request<Capabilities>('/api/capabilities'),

  saveMvsepToken: (apiToken: string) =>
    request<{ stored: boolean; cloudReady: boolean }>('/api/settings/mvsep-key', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_token: apiToken }),
    }),

  removeMvsepToken: () =>
    request<void>('/api/settings/mvsep-key', { method: 'DELETE' }),

  createProject: (file: File, title: string, artist: string) => {
    const body = new FormData()
    body.set('file', file)
    body.set('title', title)
    body.set('artist', artist)
    return request<Project>('/api/projects', { method: 'POST', body })
  },

  importProject: (file: File) => {
    const body = new FormData()
    body.set('file', file)
    return request<Project>('/api/projects/import', { method: 'POST', body })
  },

  processProject: (
    projectId: string,
    passage: Pick<Passage, 'start_s' | 'end_s'>,
    tuning: number[],
    capoFret: number,
    fretCount: number,
    preferredFret: number | null,
    expectedRevision: number,
    engine: DraftEngine,
    cloudConsent: boolean,
  ) =>
    request<Project>(`/api/projects/${encodeURIComponent(projectId)}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start_s: passage.start_s,
        end_s: passage.end_s,
        tuning,
        capo_fret: capoFret,
        fret_count: fretCount,
        preferred_fret: preferredFret,
        expected_revision: expectedRevision,
        engine,
        cloud_consent: cloudConsent,
      }),
    }),

  cancelProcess: (projectId: string) =>
    request<Project>(`/api/projects/${encodeURIComponent(projectId)}/process/cancel`, {
      method: 'POST',
    }),

  renameProject: (
    projectId: string,
    expectedRevision: number,
    title: string,
    artist: string,
  ) =>
    request<Project>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_revision: expectedRevision,
        title,
        artist,
      }),
    }),

  trashProject: (projectId: string, expectedRevision: number) =>
    request<Project>(`/api/projects/${encodeURIComponent(projectId)}/trash`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_revision: expectedRevision }),
    }),

  deleteProject: (projectId: string, expectedRevision: number) =>
    request<void>(
      `/api/projects/${encodeURIComponent(projectId)}?expected_revision=${expectedRevision}`,
      { method: 'DELETE' },
    ),

  restoreProject: (projectId: string, expectedRevision: number) =>
    request<Project>(`/api/projects/${encodeURIComponent(projectId)}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_revision: expectedRevision }),
    }),

  patchWorkspace: (
    projectId: string,
    expectedRevision: number,
    passage: { name: string; start_s: number; end_s: number },
  ) =>
    request<Project>(`/api/projects/${encodeURIComponent(projectId)}/workspace`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_revision: expectedRevision, passage }),
    }),

  patchNotes: (
    projectId: string,
    versionId: string,
    expectedRevision: number,
    notes: NoteEvent[],
  ) =>
    request<Project>(
      `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/notes`,
      {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_revision: expectedRevision,
        notes,
      }),
      },
    ),

  createVersion: (
    projectId: string,
    expectedRevision: number,
    sourceVersionId: string,
    mode: FingeringMode | null,
    name?: string,
    lockPolicy: 'preserve' | 'clear' = 'preserve',
  ) =>
    request<Project>(`/api/projects/${encodeURIComponent(projectId)}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_revision: expectedRevision,
        source_version_id: sourceVersionId,
        mode,
        lock_policy: lockPolicy,
        ...(name ? { name } : {}),
      }),
    }),

  activateVersion: (projectId: string, versionId: string, expectedRevision: number) =>
    request<Project>(
      `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/activate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_revision: expectedRevision }),
      },
    ),

  renameVersion: (
    projectId: string,
    versionId: string,
    expectedRevision: number,
    name: string,
  ) =>
    request<Project>(
      `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_revision: expectedRevision, name }),
      },
    ),

  deleteVersion: (projectId: string, versionId: string, expectedRevision: number) =>
    request<Project>(
      `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_revision: expectedRevision }),
      },
    ),
}
