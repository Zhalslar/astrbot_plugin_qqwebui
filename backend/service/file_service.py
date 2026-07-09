from __future__ import annotations

import mimetypes
from pathlib import Path
from time import time
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from astrbot.api.web import PluginUploadFile
from astrbot.core import file_token_service
from astrbot.core.utils.io import download_file
from astrbot.core.utils.media_utils import MediaResolver

from ...config import PluginConfig
from ..infra.store import QQWebuiStore


class _RestorableStagedFiles(dict):
    """Keep qqwebui media file tokens reusable inside AstrBot's token service.

    Args:
        initial: Existing staged token mapping to preserve.
        store: Plugin store that owns restorable media token entries.
        timeout: Restored token lifetime in seconds.
    """

    _MISSING = object()

    def __init__(
        self,
        initial: dict[str, tuple[str, float]],
        store: QQWebuiStore,
        timeout: int,
    ) -> None:
        super().__init__(initial)
        self.store = store
        self.timeout = timeout

    def __contains__(self, key: object) -> bool:
        if dict.__contains__(self, key):
            return True
        if not isinstance(key, str):
            return False
        return self._restore_token(key)

    def pop(self, key: str, default: Any = _MISSING) -> Any:
        if not dict.__contains__(self, key):
            self._restore_token(key)

        if default is self._MISSING:
            value = dict.pop(self, key)
            self._restore_token(key)
            return value

        value = dict.pop(self, key, default)
        if value is not default:
            self._restore_token(key)
        return value

    def _restore_token(self, token: str) -> bool:
        """Restore a persisted qqwebui token if its media file still exists.

        Args:
            token: File token to restore.

        Returns:
            True when the token is available after restoration.
        """

        for entry in self.store.media_tokens.entries:
            if str(entry.get("token", "") or "").strip() != token:
                continue
            file_path = str(entry.get("file_path", "") or "").strip()
            if not file_path:
                return False
            if not Path(file_path).is_file():
                self.store.media_tokens.prune_missing_files()
                self.store.persist()
                return False
            dict.__setitem__(self, token, (file_path, time() + self.timeout))
            return True
        return False


class FileService:
    IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"}
    VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
    AUDIO_SUFFIXES = {".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".amr"}
    MEDIA_TOKEN_RESTORE_INTERVAL = 300
    MIN_MEDIA_TOKEN_TTL = 30 * 24 * 60 * 60

    def __init__(self, cfg: PluginConfig, store: QQWebuiStore) -> None:
        self.cfg = cfg
        self.store = store
        self.media_dir = self.cfg.media_dir
        self.media_token_ttl = max(self.cfg.media_token_ttl, self.MIN_MEDIA_TOKEN_TTL)
        self._media_tokens_registered_at = 0.0
        self._staged_files: _RestorableStagedFiles | None = None

    def take_over_staged_files(self) -> None:
        """Install the plugin-owned reusable token map.

        The core file token service intentionally treats tokens as one-shot. The
        qqwebui needs media previews to survive repeated browser reads, so only
        tokens persisted by this plugin are restored after core pops them.
        """

        staged_files = file_token_service.staged_files
        if isinstance(staged_files, _RestorableStagedFiles):
            staged_files.store = self.store
            staged_files.timeout = self.media_token_ttl
            self._staged_files = staged_files
            return
        self._staged_files = _RestorableStagedFiles(
            dict(staged_files),
            self.store,
            self.media_token_ttl,
        )
        file_token_service.staged_files = self._staged_files

    def release_staged_files(self) -> None:
        """Restore AstrBot's normal staged file mapping when the plugin stops."""

        if self._staged_files is None:
            return
        if file_token_service.staged_files is self._staged_files:
            file_token_service.staged_files = dict(self._staged_files)
        self._staged_files = None

    async def upload_media(self, upload: PluginUploadFile) -> dict[str, str | int]:
        filename = Path(upload.filename or "").name
        if not filename:
            raise ValueError("missing filename")
        if (
            upload.content_length is not None
            and upload.content_length > self.cfg.max_media_size
        ):
            raise ValueError(f"upload exceeds {self.cfg.max_media_size} bytes")
        normalized_content_type = upload.content_type or "application/octet-stream"
        suffix = Path(filename).suffix.lower()
        if not suffix:
            suffix = mimetypes.guess_extension(normalized_content_type) or ".bin"
        saved_name = f"{uuid4().hex}{suffix}"
        target = self.media_dir / saved_name
        await upload.save(target)
        size = target.stat().st_size
        if size > self.cfg.max_media_size:
            target.unlink(missing_ok=True)
            raise ValueError(f"upload exceeds {self.cfg.max_media_size} bytes")
        file_token = await self.register_media_token(str(target))
        media_type = self.media_type(filename, normalized_content_type)
        return {
            "key": saved_name,
            "name": filename,
            "type": media_type,
            "size": size,
            "content_type": normalized_content_type,
            "url": f"/api/v1/files/tokens/{file_token}",
        }

    def resolve_cached_media(self, key: str) -> Path:
        safe_key = Path(str(key or "")).name
        if not safe_key:
            raise ValueError("media key is required")
        target = (self.media_dir / safe_key).resolve(strict=False)
        target.relative_to(self.media_dir.resolve(strict=False))
        if not target.is_file():
            raise FileNotFoundError("media not found")
        return target

    async def build_token_url(self, source: str, media_type: str) -> str:
        normalized_source = str(source or "").strip()
        if not normalized_source:
            raise ValueError("media source is required")
        resolved_source = normalized_source
        if normalized_source.startswith(("http://", "https://")):
            resolved_source = await self._cache_remote_media(
                normalized_source, media_type
            )
        else:
            resolved_source = await MediaResolver(
                normalized_source,
                media_type="audio" if media_type == "record" else media_type,
            ).to_path()
        file_token = await self.register_media_token(resolved_source)
        return f"/api/v1/files/tokens/{file_token}"

    async def register_media_token(self, file_path: str) -> str:
        resolved_file_path = str(file_path or "").strip()
        if not resolved_file_path:
            raise ValueError("file path is required")
        file_token = await file_token_service.register_file(
            resolved_file_path,
            timeout=self.media_token_ttl,
        )
        self.store.media_tokens.remember(file_token, resolved_file_path)
        self.store.persist()
        return file_token

    def ensure_media_tokens_registered(self, *, force: bool = False) -> None:
        """Restore cached media file tokens into the shared token service.

        Args:
            force: Whether to bypass the short in-memory throttle.
        """

        now = time()
        if (
            not force
            and now - self._media_tokens_registered_at
            < self.MEDIA_TOKEN_RESTORE_INTERVAL
        ):
            return
        self._media_tokens_registered_at = now
        self.store.media_tokens.prune_missing_files()
        expire_time = now + self.media_token_ttl
        for entry in self.store.media_tokens.entries:
            token = str(entry.get("token", "") or "").strip()
            file_path = str(entry.get("file_path", "") or "").strip()
            if not token or not file_path:
                continue
            file_token_service.staged_files[token] = (file_path, expire_time)

    async def _cache_remote_media(self, source: str, media_type: str) -> str:
        parsed = urlsplit(source)
        hinted_name = Path(parsed.path).name
        hinted_suffix = Path(hinted_name).suffix.lower()
        if not hinted_suffix:
            if media_type == "image":
                hinted_suffix = ".jpg"
            elif media_type == "video":
                hinted_suffix = ".mp4"
            elif media_type == "record":
                hinted_suffix = ".amr"
            else:
                hinted_suffix = ".bin"
        target = self.media_dir / f"{uuid4().hex}{hinted_suffix}"
        try:
            await download_file(source, str(target))
            if target.stat().st_size > self.cfg.max_media_size:
                raise ValueError(f"upload exceeds {self.cfg.max_media_size} bytes")
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return str(target)

    @staticmethod
    def media_type(name: str, content_type: str = "") -> str:
        """Infer the OneBot media segment type for an uploaded file.

        Args:
            name: Original uploaded filename.
            content_type: Browser-provided MIME type.

        Returns:
            One of `image`, `video`, `record`, or `file`.
        """
        suffix = Path(str(name or "")).suffix.lower()
        normalized_content_type = str(content_type or "").lower()
        if normalized_content_type.startswith("image/"):
            return "image"
        if normalized_content_type.startswith("video/"):
            return "video"
        if normalized_content_type.startswith("audio/"):
            return "record"
        if suffix in FileService.IMAGE_SUFFIXES:
            return "image"
        if suffix in FileService.VIDEO_SUFFIXES:
            return "video"
        if suffix in FileService.AUDIO_SUFFIXES:
            return "record"
        return "file"
