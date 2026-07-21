"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type SavedProjectSummary = {
  id: string;
  exampleSlug: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type SavedProjectQuota = {
  used: number;
  limit: number;
};

type LibraryResponse = {
  projects?: SavedProjectSummary[];
  quota?: SavedProjectQuota;
  error?: string;
};

type LibraryClientProps = {
  displayName: string;
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function LibraryClient({ displayName }: LibraryClientProps) {
  const [projects, setProjects] = useState<SavedProjectSummary[]>([]);
  const [quota, setQuota] = useState<SavedProjectQuota>({ used: 0, limit: 3 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const loadLibrary = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    setMessage("");
    try {
      const response = await fetch("/api/saved-projects", {
        cache: "no-store",
        signal,
      });
      const payload = (await response.json().catch(() => ({}))) as LibraryResponse;
      if (!response.ok || !payload.projects || !payload.quota) {
        throw new Error(payload.error ?? "Could not load your private copies.");
      }
      setProjects(payload.projects);
      setQuota(payload.quota);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadError(error instanceof Error ? error.message : "Could not load your private copies.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void loadLibrary(controller.signal));
    return () => controller.abort();
  }, [loadLibrary]);

  const deleteProject = async (project: SavedProjectSummary) => {
    const confirmed = window.confirm(
      `Permanently delete “${project.title}”? The original example will remain available, but this saved copy cannot be recovered.`,
    );
    if (!confirmed) return;

    setDeletingId(project.id);
    setMessage("");
    try {
      const response = await fetch(
        `/api/saved-projects/${encodeURIComponent(project.id)}`,
        { method: "DELETE" },
      );
      if (!response.ok && response.status !== 404) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Could not delete this saved copy.");
      }
      setProjects((current) => current.filter(({ id }) => id !== project.id));
      setQuota((current) => ({ ...current, used: Math.max(0, current.used - 1) }));
      setMessage(`“${project.title}” was permanently deleted.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not delete this saved copy.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <main id="main-content" tabIndex={-1} className="library-page">
      <p className="eyebrow">Private saved copies</p>
      <h1>My library</h1>
      <p className="library-page__lead">
        Signed in as {displayName}. Each copy starts from a free synthetic example;
        edits here are stored privately and never change the public original.
      </p>

      <p className="quota" aria-live="polite">
        {quota.used} / {quota.limit} saved copies used
      </p>

      {loading ? (
        <p role="status">Loading your library…</p>
      ) : loadError ? (
        <section aria-labelledby="library-error-heading">
          <h2 id="library-error-heading">Library could not be loaded</h2>
          <p>{loadError}</p>
          <button className="button button--quiet" type="button" onClick={() => void loadLibrary()}>
            Try again
          </button>
        </section>
      ) : projects.length === 0 ? (
        <section aria-labelledby="empty-library-heading">
          <h2 id="empty-library-heading">No saved copies yet</h2>
          <p>Open an example, make it yours, then choose “Save a copy.”</p>
          <Link className="button primary" href="/#examples">
            Try an example
          </Link>
        </section>
      ) : (
        <ul className="saved-project-list">
          {projects.map((project) => (
            <li key={project.id}>
              <div>
                <h2>
                  <Link href={`/projects/${encodeURIComponent(project.id)}`}>
                    {project.title}
                  </Link>
                </h2>
                <p>
                  From {project.exampleSlug.replaceAll("-", " ")} · saved {formatDate(project.updatedAt)} · revision {project.revision}
                </p>
              </div>
              <div className="saved-project-list__actions">
                <Link className="button" href={`/projects/${encodeURIComponent(project.id)}`}>
                  Open
                </Link>
                <button
                  className="button button--quiet"
                  type="button"
                  disabled={deletingId === project.id}
                  onClick={() => void deleteProject(project)}
                >
                  {deletingId === project.id ? "Deleting…" : "Delete permanently"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="example-studio__status" role="status" aria-live="polite">
        {message}
      </p>
    </main>
  );
}

export default LibraryClient;
