import { describe, expect, it } from 'vitest'

import { api } from './api'
import {
  DESKTOP_EDITOR_CAPABILITIES,
  desktopEditorClient,
  toDesktopProject,
  toEditorProject,
} from './editor-client'
import { makeProject } from './test-project'

describe('desktop editor client seam', () => {
  it('exposes the active local tab without hosted-only concerns', () => {
    const local = makeProject()
    const editor = toEditorProject(local)

    expect(editor.origin).toBe('local')
    expect(editor.active_version_id).toBe(local.active_version_id)
    expect(editor.versions).toHaveLength(1)
    expect(editor.versions[0].tab).toEqual(local.tab)
    expect(editor.assets).toEqual(local.assets)
    expect(toDesktopProject(editor)).toBe(local)
    expect(DESKTOP_EDITOR_CAPABILITIES.uploads).toBe(true)
    expect(DESKTOP_EDITOR_CAPABILITIES.saveCopies).toBe(false)
  })

  it('maps shared note replacement back to the desktop API envelope', async () => {
    const local = makeProject()
    const notes = local.tab.notes.slice(0, 1)
    const updated = {
      ...local,
      revision: local.revision + 1,
      tab: { ...local.tab, notes },
    }
    const patchNotes = vi.spyOn(api, 'patchNotes').mockResolvedValue(updated)

    const editor = await desktopEditorClient.applyVersionAction({
      projectId: local.id,
      expectedRevision: local.revision,
      action: {
        type: 'replace-notes',
        versionId: local.active_version_id,
        notes,
      },
    })

    expect(patchNotes).toHaveBeenCalledWith(
      local.id,
      local.active_version_id,
      local.revision,
      notes,
    )
    expect(toDesktopProject(editor)).toBe(updated)
  })
})
