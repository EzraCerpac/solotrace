from __future__ import annotations

import json
import os
import shutil
import sqlite3
import threading
from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

from .models import Project, now_iso

T = TypeVar("T")


class RevisionConflictError(RuntimeError):
    pass


class ProjectStore:
    """SQLite metadata with project media kept as ordinary inspectable files."""

    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.projects_dir = data_dir / "projects"
        self.database_path = data_dir / "solotrace.sqlite3"
        self._lock = threading.RLock()
        self.projects_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.chmod(0o700)
        self.projects_dir.chmod(0o700)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        if self.database_path.exists():
            self.database_path.chmod(0o600)
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    document TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS projects_updated_at
                    ON projects(updated_at DESC);
                CREATE TABLE IF NOT EXISTS revisions (
                    project_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    document TEXT NOT NULL,
                    PRIMARY KEY (project_id, revision),
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
                );
                """
            )
        self.database_path.chmod(0o600)

    def project_dir(self, project_id: str) -> Path:
        allowed = "abcdefghijklmnopqrstuvwxyz0123456789-"
        if not project_id or any(character not in allowed for character in project_id):
            raise ValueError("invalid project id")
        directory = self.projects_dir / project_id
        directory.mkdir(parents=True, exist_ok=True)
        directory.chmod(0o700)
        return directory

    def media_path(self, project_id: str, filename: str) -> Path:
        if Path(filename).name != filename:
            raise ValueError("invalid media filename")
        path = self.project_dir(project_id) / filename
        return path

    @staticmethod
    def _write(
        connection: sqlite3.Connection,
        project: Project,
        reason: str,
    ) -> None:
        document = project.model_dump_json()
        connection.execute(
            """
            INSERT INTO projects (id, title, updated_at, revision, document)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title=excluded.title,
                updated_at=excluded.updated_at,
                revision=excluded.revision,
                document=excluded.document
            """,
            (
                project.id,
                project.title,
                project.updated_at,
                project.revision,
                document,
            ),
        )
        connection.execute(
            """
            INSERT OR REPLACE INTO revisions
                (project_id, revision, created_at, reason, document)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                project.id,
                project.revision,
                project.updated_at,
                reason,
                document,
            ),
        )

    def put(self, project: Project, *, reason: str = "create") -> Project:
        project = Project.model_validate(project.model_dump(mode="python"))
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._write(connection, project, reason)
        return project

    def get(self, project_id: str) -> Project | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT document FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
        return Project.model_validate_json(row["document"]) if row else None

    def list(self) -> list[Project]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT document FROM projects ORDER BY updated_at DESC"
            ).fetchall()
        return [Project.model_validate_json(row["document"]) for row in rows]

    def merge_from(self, source: ProjectStore) -> list[str]:
        """Merge newer projects and their declared media from another library."""
        merged: list[str] = []
        for candidate in source.list():
            current = self.get(candidate.id)
            if current is not None and current.revision >= candidate.revision:
                continue

            media: list[tuple[Path, Path]] = []
            for asset in candidate.assets:
                source_path = source.media_path(candidate.id, asset.filename)
                if not source_path.is_file():
                    raise FileNotFoundError(
                        f"declared {asset.role} asset is missing: {source_path}"
                    )
                media.append(
                    (source_path, self.media_path(candidate.id, asset.filename))
                )

            for source_path, destination_path in media:
                temporary = destination_path.with_suffix(
                    destination_path.suffix + ".merge"
                )
                shutil.copy2(source_path, temporary)
                temporary.replace(destination_path)
                destination_path.chmod(0o600)
            self.put(candidate, reason=f"merge from {source.data_dir}")
            merged.append(candidate.id)
        return merged

    def update(
        self,
        project_id: str,
        update: Callable[[Project], Project],
        *,
        reason: str,
        expected_revision: int | None = None,
        bump_revision: bool = False,
    ) -> Project:
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT document FROM projects WHERE id = ?",
                (project_id,),
            ).fetchone()
            if row is None:
                raise KeyError(project_id)
            project = Project.model_validate_json(row["document"])
            if expected_revision is not None and project.revision != expected_revision:
                raise RevisionConflictError(
                    f"Expected revision {expected_revision}, current revision is "
                    f"{project.revision}"
                )
            updated = update(project)
            if bump_revision:
                updated = updated.model_copy(
                    update={"revision": project.revision + 1}
                )
            updated = updated.model_copy(update={"updated_at": now_iso()})
            updated = Project.model_validate(updated.model_dump(mode="python"))
            self._write(connection, updated, reason)
            return updated

    def write_json_artifact(self, project_id: str, filename: str, value: T) -> Path:
        path = self.media_path(project_id, filename)
        temporary = path.with_suffix(path.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
        return path
