from __future__ import annotations

from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from aiocqhttp import CQHttp

from astrbot.core.utils.media_utils import MediaResolver

from .file_service import FileService


class OutboundService:
    def __init__(self, bot: CQHttp, files: FileService) -> None:
        self.bot = bot
        self.files = files

    async def _send(
        self,
        message_type: str,
        target_id: str,
        messages: list[dict[str, Any]],
    ) -> None:
        is_group = message_type == "group"
        await self.bot.send_msg(
            message_type=message_type,
            user_id=int(target_id) if not is_group else None,
            group_id=int(target_id) if is_group else None,
            message=messages,
        )

    async def _forward(
        self,
        message_type: str,
        target_id: str,
        messages: list[dict[str, Any]],
    ) -> None:
        is_group = message_type == "group"
        await self.bot.send_forward_msg(
            message_type=message_type,
            user_id=int(target_id) if not is_group else None,
            group_id=int(target_id) if is_group else None,
            messages=messages,
        )

    async def send_message(
        self,
        session_id: str,
        message: list[dict[str, Any]],
    ) -> dict[str, str]:
        """Send OneBot-style message segments directly.

        Args:
            session_id: Chat route in `private:123` or `group:456` format.
            message: OneBot-style message segment array.

        Raises:
            ValueError: The session or message payload is invalid.
        """

        normalized_message: list[dict[str, Any]] = []
        for raw_segment in message:
            normalized_segment = await self._normalize_segment(raw_segment)
            if normalized_segment is not None:
                normalized_message.append(normalized_segment)
        if not normalized_message:
            raise ValueError("message is required")

        message_type, _, target_id = session_id.partition(":")
        if message_type not in {"private", "group"} or not target_id:
            raise ValueError("invalid session_id")

        if not any(
            segment["type"] in {"node", "file"} for segment in normalized_message
        ):
            await self._send(message_type, target_id, normalized_message)
            return {"session_id": session_id}

        index = 0
        while index < len(normalized_message):
            segment = normalized_message[index]
            if segment["type"] == "node":
                messages = [segment]
                index += 1
                while index < len(normalized_message):
                    next_segment = normalized_message[index]
                    if next_segment["type"] != "node":
                        break
                    messages.append(next_segment)
                    index += 1
                await self._forward(message_type, target_id, messages)
                continue

            await self._send(message_type, target_id, [segment])
            index += 1
        return {"session_id": session_id}

    async def _normalize_segment(
        self, raw_segment: dict[str, Any]
    ) -> dict[str, Any] | None:
        seg_type = raw_segment["type"]
        data = dict(raw_segment.get("data") or {})

        match seg_type:
            case "text":
                if data.get("text", "") == "":
                    return None
                return {"type": "text", "data": {"text": data["text"]}}
            case "image" | "record" | "video" | "file":
                source = data.get("file") or data.get("url")
                if not source:
                    raise ValueError(f"{seg_type} segment file is required")

                if "/" not in source and not source.startswith(
                    ("http://", "https://", "base64://", "file://", "data:")
                ):
                    cached_path = self.files.resolve_cached_media(source)
                    normalized_source = str(cached_path.resolve())
                    if seg_type == "image":
                        normalized_source = f"base64://{await MediaResolver(str(cached_path), media_type='image').to_base64()}"
                    elif seg_type == "record":
                        normalized_source = (
                            "base64://"
                            f"{await MediaResolver(str(cached_path), media_type='audio', default_suffix='.wav').to_base64(target_format='wav')}"
                        )

                    normalized_data: dict[str, Any] = {"file": normalized_source}
                    if seg_type == "file":
                        normalized_data["name"] = data.get("name") or cached_path.name
                    return {"type": seg_type, "data": normalized_data}

                normalized_data = dict(data)
                normalized_data["file"] = source
                if seg_type == "file":
                    normalized_data["name"] = (
                        data.get("name") or Path(urlsplit(source).path).name or "file"
                    )
                return {"type": seg_type, "data": normalized_data}
            case "node":
                content = data.get("content", [])
                if isinstance(content, str):
                    content_segments = (
                        [{"type": "text", "data": {"text": content}}] if content else []
                    )
                else:
                    content_segments = []
                    for item in content:
                        normalized_item = await self._normalize_segment(item)
                        if normalized_item is not None:
                            content_segments.append(normalized_item)
                if not content_segments:
                    raise ValueError("node segment content is required")
                node_data: dict[str, Any] = {"content": content_segments}
                for key in ("id", "user_id", "nickname"):
                    if data.get(key) not in ("", None):
                        node_data[key] = data[key]
                return {"type": "node", "data": node_data}
            case _:
                return {"type": seg_type, "data": data}
