import { useEffect, useRef, useState, type FormEvent } from 'react'

import { Icon } from './Icon'
import type { Capabilities, Project } from '../types'

type CookieBrowser = 'none' | 'chrome' | 'safari'
type ImportSource = 'file' | 'youtube'

const RIGHTS_KEY = 'solotrace.youtubeRightsAccepted.v1'
const BROWSER_KEY = 'solotrace.youtubeCookieBrowser'

interface UploadDialogProps {
  open: boolean
  capabilities: Capabilities | null
  onClose: () => void
  onUpload: (file: File, title: string, artist: string) => Promise<Project>
  onYouTubeUpload: (url: string, cookieBrowser: CookieBrowser) => Promise<Project>
}

function readStoredBrowser(available: CookieBrowser[]): CookieBrowser {
  try {
    const stored = window.localStorage.getItem(BROWSER_KEY) as CookieBrowser | null
    if (stored && available.includes(stored)) return stored
  } catch {
    // Browser preference stays optional when storage is unavailable.
  }
  if (available.includes('chrome')) return 'chrome'
  if (available.includes('safari')) return 'safari'
  return 'none'
}

export function UploadDialog({
  open,
  capabilities,
  onClose,
  onUpload,
  onYouTubeUpload,
}: UploadDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [source, setSource] = useState<ImportSource>('file')
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [artist, setArtist] = useState('')
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [cookieBrowser, setCookieBrowser] = useState<CookieBrowser>('none')
  const [rightsAccepted, setRightsAccepted] = useState(false)
  const [rightsConfirmed, setRightsConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const youtubeCapability = capabilities?.imports.youtube
  const cookieBrowsers: CookieBrowser[] = [
    'none',
    ...(youtubeCapability?.cookieBrowsers ?? []),
  ]

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    if (!open) return
    try {
      setRightsAccepted(window.localStorage.getItem(RIGHTS_KEY) === 'true')
    } catch {
      setRightsAccepted(false)
    }
    setCookieBrowser(readStoredBrowser(cookieBrowsers))
  }, [open, youtubeCapability?.cookieBrowsers.join(',')])

  const chooseBrowser = (browser: CookieBrowser) => {
    setCookieBrowser(browser)
    try {
      window.localStorage.setItem(BROWSER_KEY, browser)
    } catch {
      // Browser preference stays optional when storage is unavailable.
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (source === 'file' && (!file || !title.trim())) return
    if (
      source === 'youtube' &&
      (!youtubeUrl.trim() || !youtubeCapability?.available || (!rightsAccepted && !rightsConfirmed))
    ) {
      return
    }
    setBusy(true)
    setError('')
    try {
      if (source === 'file') {
        await onUpload(file!, title.trim(), artist.trim())
        setFile(null)
        setTitle('')
        setArtist('')
      } else {
        await onYouTubeUpload(youtubeUrl.trim(), cookieBrowser)
        try {
          window.localStorage.setItem(BROWSER_KEY, cookieBrowser)
        } catch {
          // Browser preference stays optional when storage is unavailable.
        }
        if (!rightsAccepted) {
          try {
            window.localStorage.setItem(RIGHTS_KEY, 'true')
          } catch {
            // Reconfirm next time when storage is unavailable.
          }
          setRightsAccepted(true)
        }
        setRightsConfirmed(false)
        setYoutubeUrl('')
      }
      onClose()
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Import failed')
    } finally {
      setBusy(false)
    }
  }

  const youtubeReady =
    Boolean(youtubeUrl.trim()) &&
    Boolean(youtubeCapability?.available) &&
    (rightsAccepted || rightsConfirmed)

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

        <div className="import-source-switch" role="group" aria-label="Import source">
          <button
            type="button"
            aria-pressed={source === 'file'}
            onClick={() => {
              setSource('file')
              setError('')
            }}
            disabled={busy}
          >
            Audio file
          </button>
          <button
            type="button"
            aria-pressed={source === 'youtube'}
            onClick={() => {
              setSource('youtube')
              setError('')
            }}
            disabled={busy || !youtubeCapability?.available}
          >
            YouTube link
          </button>
        </div>

        {source === 'file' ? (
          <>
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
              Import stays on this machine. Offline transcription stays local. Choosing MVSep
              later sends only your chosen range after you confirm.
            </p>
          </>
        ) : (
          <div className="youtube-import-fields">
            <label>
              YouTube video link
              <input
                type="url"
                inputMode="url"
                required
                autoFocus
                placeholder="https://www.youtube.com/watch?v=…"
                value={youtubeUrl}
                onChange={(event) => setYoutubeUrl(event.target.value)}
              />
            </label>
            <label>
              YouTube access
              <select
                value={cookieBrowser}
                onChange={(event) => chooseBrowser(event.target.value as CookieBrowser)}
              >
                <option value="none">Anonymous</option>
                {youtubeCapability?.cookieBrowsers.includes('chrome') && (
                  <option value="chrome">Signed-in Chrome</option>
                )}
                {youtubeCapability?.cookieBrowsers.includes('safari') && (
                  <option value="safari">Signed-in Safari</option>
                )}
              </select>
            </label>
            <p className="privacy-note">
              {cookieBrowser === 'none'
                ? 'SoloTrace downloads this video locally without browser cookies.'
                : `SoloTrace reads ${cookieBrowser === 'chrome' ? 'Chrome' : 'Safari'} cookies for this download. Cookies are never saved in SoloTrace.`}
            </p>
            {!rightsAccepted ? (
              <label className="rights-confirmation">
                <input
                  type="checkbox"
                  checked={rightsConfirmed}
                  onChange={(event) => setRightsConfirmed(event.target.checked)}
                />
                <span>
                  I have permission to download and process this video, and understand YouTube
                  may restrict downloads.
                </span>
              </label>
            ) : (
              <p className="rights-reminder">
                Import only videos you have permission to download and process.
              </p>
            )}
            <p className="youtube-source-note">
              One video, up to {Math.round((youtubeCapability?.maxDurationS ?? 1_800) / 60)}
              {' '}minutes. Title and artist come from YouTube and can be edited later.
            </p>
          </div>
        )}

        {!youtubeCapability?.available && youtubeCapability?.disabledReason && (
          <p className="form-error" role="status">
            {youtubeCapability.disabledReason}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={source === 'file' ? !file || !title || busy : !youtubeReady || busy}
          >
            {busy
              ? source === 'youtube'
                ? 'Downloading and decoding…'
                : 'Decoding audio…'
              : 'Import song'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
