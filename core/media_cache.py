from __future__ import annotations

import base64
import hashlib
import mimetypes
from dataclasses import dataclass
from pathlib import Path

from astrbot.core.utils.media_utils import file_uri_to_path

MAX_CACHEABLE_MEDIA_SIZE = 15 * 1024 * 1024


@dataclass(slots=True)
class CachedMedia:
    key: str
    path: Path
    name: str
    content_type: str
    size: int


class QQWebuiMediaCache:
    """Cache uploaded and local chat media for the plugin page."""

    def __init__(self, base_dir: Path):
        self.base_dir = base_dir

    def resolve_cached_file(self, key: str) -> CachedMedia:
        safe_key = Path(str(key or "")).name
        if not safe_key:
            raise ValueError("media key is required")
        target = (self.base_dir / safe_key).resolve(strict=False)
        target.relative_to(self.base_dir.resolve(strict=False))
        if not target.is_file():
            raise FileNotFoundError("media not found")
        content_type, _ = mimetypes.guess_type(target.name)
        return CachedMedia(
            key=safe_key,
            path=target,
            name=target.name,
            content_type=content_type or "application/octet-stream",
            size=target.stat().st_size,
        )

    def cache_upload(
        self,
        raw_bytes: bytes,
        filename: str,
        content_type: str,
        *,
        max_size: int = MAX_CACHEABLE_MEDIA_SIZE,
    ) -> CachedMedia:
        if not raw_bytes:
            raise ValueError("upload is empty")
        if len(raw_bytes) > max_size:
            raise ValueError(f"upload exceeds {max_size} bytes")
        suffix = Path(str(filename or "")).suffix.lower()
        if not suffix:
            suffix = (
                mimetypes.guess_extension(content_type or "application/octet-stream")
                or ".bin"
            )
        digest = hashlib.sha1(raw_bytes).hexdigest()
        target = self.base_dir / f"{digest}{suffix}"
        if not target.exists():
            target.write_bytes(raw_bytes)
        return self.resolve_cached_file(target.name)

    def cache_message_media(
        self,
        value: str,
        *,
        fallback_name: str = "file",
        content_type: str = "",
        max_size: int = MAX_CACHEABLE_MEDIA_SIZE,
    ) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        try:
            if text.startswith("//"):
                return f"https:{text}"
            if text.startswith("http://"):
                return f"https://{text.removeprefix('http://')}"
            if text.startswith("https://"):
                return text
            if text.startswith("base64://"):
                raw = base64.b64decode(text.removeprefix("base64://"), validate=False)
                cached = self.cache_upload(
                    raw,
                    fallback_name,
                    content_type or "application/octet-stream",
                    max_size=max_size,
                )
                return cached.key
            if text.startswith("data:") and ";base64," in text:
                _, _, encoded = text.partition(";base64,")
                raw = base64.b64decode(encoded, validate=False)
                media_type = text[5:].partition(";")[0]
                cached = self.cache_upload(
                    raw,
                    fallback_name,
                    media_type,
                    max_size=max_size,
                )
                return cached.key
            source = Path(
                file_uri_to_path(text) if text.startswith("file:") else text
            ).expanduser()
            if not source.is_file():
                return ""
            if source.stat().st_size > max_size:
                return ""
            raw = source.read_bytes()
            cached = self.cache_upload(
                raw,
                source.name or fallback_name,
                mimetypes.guess_type(source.name)[0]
                or content_type
                or "application/octet-stream",
                max_size=max_size,
            )
            return cached.key
        except Exception:
            return ""

    def cache_message_image(self, value: str, *, fallback_name: str = "image") -> str:
        return self.cache_message_media(
            value,
            fallback_name=fallback_name,
            content_type="image/png",
        )
