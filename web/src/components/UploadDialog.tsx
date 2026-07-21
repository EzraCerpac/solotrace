import { useEffect, useRef, useState, type FormEvent } from 'react'

import { Icon } from './Icon'
import type { Capabilities, Project } from '../types'

interface UploadDialogProps {
  open: boolean
  capabilities: Capabilities | null
  onClose: () => void
  onUpload: (file: File, title: string, artist: string) => Promise<Project>
}

export function UploadDialog({
  open,
  capabilities,
  onClose,
  onUpload,
}: UploadDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!file || !title.trim()) return
    setBusy(true)
    setError('')
    try {
      await onUpload(file, title.trim(), artist.trim())
      setFile(null)
      setTitle('')
      setArtist('')
      onClose()
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Import failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      className="upload-dialog"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      onClose={() => {
        if (open && !busy) onClose()
      }}
    >
      <form onSubmit={submit}>
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">Private library</p>
            <h2>Choose a song</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close import"
            onClick={onClose}
            disabled={busy}
          >
            <Icon name="close" />
          </button>
        </div>
        <label className="file-drop">
          <Icon name="upload" />
          <strong>{file ? file.name : 'Drop audio here or choose a file'}</strong>
          <span>
            WAV, MP3, M4A, FLAC, OGG, Opus, AIFF, or WebM
            {capabilities ? ` · up to ${capabilities.audio.maxUploadMb} MB` : ''}
          </span>
          <input
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.opus,.aif,.aiff,.webm"
            required
            onChange={(event) => {
              const nextFile = event.target.files?.[0] ?? null
              setFile(nextFile)
              if (nextFile && !title) {
                setTitle(nextFile.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '))
              }
            }}
          />
        </label>
        <div className="dialog-fields">
          <label>
            Song title
            <input
              type="text"
              required
              maxLength={120}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            Artist <span>optional</span>
            <input
              type="text"
              maxLength={120}
              value={artist}
              onChange={(event) => setArtist(event.target.value)}
            />
          </label>
        </div>
        <p className="privacy-note">
          Import stays on this machine. Offline transcription stays local. Choosing
          MVSep later sends only your chosen range after you confirm.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!file || !title || busy}>
            {busy ? 'Decoding audio…' : 'Import song'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
