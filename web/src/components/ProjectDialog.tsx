import { useEffect, useRef, useState, type FormEvent } from 'react'

import { Icon } from './Icon'
import type { ProjectSummary } from '../types'

interface ProjectDialogProps {
  project: ProjectSummary | null
  saving: boolean
  onClose: () => void
  onRename: (title: string, artist: string) => Promise<void>
  onTrash: () => Promise<void>
}

export function ProjectDialog({
  project,
  saving,
  onClose,
  onRename,
  onTrash,
}: ProjectDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (project && !dialog.open) dialog.showModal()
    if (!project && dialog.open) dialog.close()
  }, [project])

  useEffect(() => {
    setTitle(project?.title ?? '')
    setArtist(project?.artist ?? '')
  }, [project])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (title.trim()) void onRename(title.trim(), artist.trim())
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog project-dialog"
      onCancel={(event) => {
        event.preventDefault()
        if (!saving) onClose()
      }}
      onClose={onClose}
    >
      <div className="dialog-heading">
        <div>
          <p className="eyebrow">Song library</p>
          <h2>Project details</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Close project details"
          disabled={saving}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <form onSubmit={submit}>
        <div className="dialog-fields single-column">
          <label>
            Song title
            <input
              required
              maxLength={120}
              disabled={saving}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            Artist
            <input
              maxLength={120}
              disabled={saving}
              value={artist}
              onChange={(event) => setArtist(event.target.value)}
            />
          </label>
        </div>
        <div className="dialog-actions split-actions">
          <button
            className="button danger-text"
            type="button"
            disabled={saving}
            onClick={() => void onTrash()}
          >
            Move to Trash
          </button>
          <div>
            <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
              Cancel
            </button>
            <button className="button primary" type="submit" disabled={saving || !title.trim()}>
              {saving ? 'Saving…' : 'Save project'}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  )
}
