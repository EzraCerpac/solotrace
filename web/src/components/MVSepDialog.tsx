import { useEffect, useRef, useState, type FormEvent } from 'react'

import { Icon } from './Icon'

interface MVSepDialogProps {
  open: boolean
  configured: boolean
  onClose: () => void
  onSave: (token: string) => Promise<void>
  onRemove: () => Promise<void>
}

export function MVSepDialog({
  open,
  configured,
  onClose,
  onSave,
  onRemove,
}: MVSepDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [token, setToken] = useState('')
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
    if (!token.trim()) return
    setBusy(true)
    setError('')
    try {
      await onSave(token.trim())
      setToken('')
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save API key')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setError('')
    try {
      await onRemove()
      setToken('')
      onClose()
    } catch (removeError) {
      setError(
        removeError instanceof Error ? removeError.message : 'Could not remove API key',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      className="upload-dialog token-dialog"
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
            <p className="eyebrow">Cloud lead separation</p>
            <h2>MVSep API key</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close API key"
            onClick={onClose}
            disabled={busy}
          >
            <Icon name="close" />
          </button>
        </div>
        <label>
          API key
          <input
            type="text"
            className="token-input"
            required
            minLength={20}
            maxLength={256}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <p className="privacy-note">
          Saved in macOS Keychain. SoloTrace never writes this key into project files or
          exports.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          {configured && (
            <button
              type="button"
              className="button danger-text"
              onClick={() => void remove()}
              disabled={busy}
            >
              Remove saved key
            </button>
          )}
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!token.trim() || busy}>
            {busy ? 'Saving…' : 'Save API key'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
