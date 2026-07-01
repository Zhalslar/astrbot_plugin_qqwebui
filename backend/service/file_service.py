from __future__ import annotations

import mimetypes
from pathlib import Path
from time import time
from urllib.parse import urlsplit
from uuid import uuid4

from astrbot.api.web import PluginUploadFile
from astrbot.core import file_token_service
from astrbot.core.utils.io import download_file
from astrbot.core.utils.media_utils import MediaResolver

from ...config import PluginConfig
from ..infra.store import QQWebuiStore


class FileService:
    IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"}
    VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
    AUDIO_SUFFIXES = {".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".amr"}

    def __init__(self, cfg: PluginConfig, store: QQWebuiStore) -> None:
        self.cfg = cfg
        self.store = store
        self.media_dir = self.cfg.media_dir

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
            timeout=self.cfg.media_token_ttl,
        )
        self.store.media_tokens.remember(file_token, resolved_file_path)
        return file_token

    def ensure_media_tokens_registered(self) -> None:
        self.store.media_tokens.prune_missing_files()
        expire_time = time() + self.cfg.media_token_ttl
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
        suffix = Path(str(name or "")).suffix.lower()
        normalized_content_type = str(content_type or "").lower()
        if (
            normalized_content_type.startswith("image/")
            or suffix in FileService.IMAGE_SUFFIXES
        ):
            return "image"
        if (
            normalized_content_type.startswith("video/")
            or suffix in FileService.VIDEO_SUFFIXES
        ):
            return "video"
        if (
            normalized_content_type.startswith("audio/")
            or suffix in FileService.AUDIO_SUFFIXES
        ):
            return "record"
        return "file"
