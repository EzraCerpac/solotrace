import type {
  Capabilities,
  DraftEngine,
  FingeringMode,
  NoteEvent,
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
      const payload = (await response.json()) as { detail?: string }
      message = payload.detail ?? message
    } catch {
      // Keep status-based fallback when a proxy or server returns non-JSON.
    }
    throw new ApiError(message, response.status)
  }
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
    request<{ stored: boolean; cloudReady: boolean }>('/api/settings/mvsep-token', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_token: apiToken }),
    }),

  createProject: (file: File, title: string, artist: string) => {
    const body = new FormData()
    body.set('file', file)
    body.set('title', title)
    body.set('artist', artist)
    return request<Project>('/api/projects', { method: 'POST', body })
  },

  processProject: (
    projectId: string,
    passage: { start_s: number; end_s: number },
    tuning: number[],
    fretCount: number,
    expectedRevision: number,
    engine: DraftEngine,
    cloudConsent: boolean,
  ) =>
    request<Project>(`/api/projects/${encodeURIComponent(projectId)}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...passage,
        tuning,
        fret_count: fretCount,
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
    request<Project>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_revision: expectedRevision }),
    }),

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
  ) =>
    request<Project>(`/api/projects/${encodeURIComponent(projectId)}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expected_revision: expectedRevision,
        source_version_id: sourceVersionId,
        mode,
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
