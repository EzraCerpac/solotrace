import { useEffect, useRef, useState, type FormEvent } from 'react'

import { Icon } from './Icon'
import type { Project, TabVersionSummary } from '../types'

interface VersionDialogProps {
  open: boolean
  project: Project
  saving: boolean
  onClose: () => void
  onActivate: (version: TabVersionSummary) => Promise<void>
  onDuplicate: (version: TabVersionSummary) => Promise<void>
  onRename: (version: TabVersionSummary, name: string) => Promise<void>
  onDelete: (version: TabVersionSummary) => Promise<void>
}

export function VersionDialog({
  open,
  project,
  saving,
  onClose,
  onActivate,
  onDuplicate,
  onRename,
  onDelete,
}: VersionDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [selectedId, setSelectedId] = useState(project.active_version_id)
  const selected =
    project.versions.find((version) => version.id === selectedId) ??
    project.versions[0]
  const [name, setName] = useState(selected?.name ?? '')

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      setSelectedId(project.active_version_id)
      dialog.showModal()
    }
    if (!open && dialog.open) dialog.close()
  }, [open, project.active_version_id])

  useEffect(() => {
    if (!project.versions.some((version) => version.id === selectedId)) {
      setSelectedId(project.active_version_id)
    }
  }, [project.active_version_id, project.versions, selectedId])

  useEffect(() => {
    setName(selected?.name ?? '')
  }, [selected?.id, selected?.name])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (selected && name.trim()) void onRename(selected, name.trim())
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog version-dialog"
      onCancel={(event) => {
        event.preventDefault()
        if (!saving) onClose()
      }}
      onClose={onClose}
    >
      <div className="dialog-heading">
        <div>
          <p className="eyebrow">Arrangement shelf</p>
          <h2>Tab versions</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Close tab versions"
          disabled={saving}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="version-workbench">
        <nav aria-label="Tab versions">
          {project.versions.map((version) => (
            <button
              type="button"
              key={version.id}
              className={version.id === selected?.id ? 'active' : ''}
              onClick={() => setSelectedId(version.id)}
            >
              <span>
                {version.name}
                {version.id === project.active_version_id && <small>Current</small>}
              </span>
              <code>{version.note_count} notes</code>
            </button>
          ))}
        </nav>
        {selected && (
          <form onSubmit={submit}>
            <label>
              Version name
              <input
                required
                maxLength={80}
                disabled={saving}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <dl>
              <div>
                <dt>Style</dt>
                <dd>{selected.fingering_mode === 'position' ? 'One position' : selected.fingering_mode}</dd>
              </div>
              <div>
                <dt>Review</dt>
                <dd>{selected.needs_review_count} remaining</dd>
              </div>
            </dl>
            <div className="version-actions">
              <button
                className="button primary"
                type="button"
                disabled={saving || selected.id === project.active_version_id}
                onClick={() => void onActivate(selected)}
              >
                Open version
              </button>
              <button className="button secondary" type="submit" disabled={saving || !name.trim()}>
                Rename
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={saving}
                onClick={() => void onDuplicate(selected)}
              >
                Duplicate
              </button>
              <button
                className="button danger-text"
                type="button"
                disabled={saving || project.versions.length === 1}
                onClick={() => void onDelete(selected)}
              >
                Delete version
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  )
}
