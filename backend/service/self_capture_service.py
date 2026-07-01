from __future__ import annotations

import time
from typing import Any

from aiocqhttp import CQHttp

from ...config import PluginConfig
from ..infra.event import MessageEvent
from ..infra.models import Sender
from ..infra.store import QQWebuiStore
from .file_service import FileService
from .session_service import SessionService


class SelfCaptureService:
    def __init__(
        self,
        cfg: PluginConfig,
        bot: CQHttp,
        store: QQWebuiStore,
        sessions: SessionService,
        files: FileService,
    ) -> None:
        self.cfg = cfg
        self.bot = bot
        self.store = store
        self.sessions = sessions
        self.files = files
        self._original_call_action: Any = None
        self.msg_action = {
            "send_msg",
            "send_private_msg",
            "send_group_msg",
            "send_forward_msg",
            "send_private_forward_msg",
            "send_group_forward_msg",
            "forward_friend_single_msg",
            "forward_group_single_msg",
        }

    async def initialize(self) -> None:
        call_action = self.bot.call_action
        self._original_call_action = call_action

        async def patched_call_action(action: str, **params: Any) -> Any:
            result = await call_action(action, **params)
            if action in self.msg_action:
                await self._handle_outgoing_action(action, params, result)
            return result

        self.bot.call_action = patched_call_action

    async def terminate(self) -> None:
        if self._original_call_action is not None:
            self.bot.call_action = self._original_call_action
            self._original_call_action = None

    async def _handle_outgoing_action(
        self,
        action: str,
        params: dict[str, Any],
        result: dict[str, Any],
    ) -> None:
        print(params)
        print(result)
        message = params.get("message") or params.get("messages")
        if not message:
            return
        if not isinstance(message, list):
            message = [message]
        message = await self._populate_message_urls(message)
        user_id = params.get("user_id", "")
        group_id = params.get("group_id", "")
        message_id = (
            result.get("message_id", "")
            or result.get("data", {}).get("message_id")
            or params.get("message_id", "")
        )
        self_id = self.store.contacts.login.user_id
        nickname = self.store.contacts.login.nickname
        self.sender = Sender(user_id=self_id, nickname=nickname)
        message_type = str(params.get("message_type", "") or "")
        if message_type not in {"private", "group"}:
            if "private" in action:
                message_type = "private"
            elif "group" in action:
                message_type = "group"
            elif user_id:
                message_type = "private"
            elif group_id:
                message_type = "group"
            else:
                return
        event = MessageEvent(
            self_id=self_id,
            user_id=self_id,
            time=int(time.time()),
            message_id=str(message_id),
            post_type="message",
            message_type=message_type,
            sub_type="",
            group_id=str(group_id),
            raw_message="",
            message=message,
            sender=self.sender,
            _target_id=str(user_id or group_id),
        )
        self.sessions.cache_message(event)

    async def _populate_message_urls(
        self, message: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        pending_segments = [message]
        while pending_segments:
            segments = pending_segments.pop()
            for segment in segments:
                if not isinstance(segment, dict):
                    continue
                seg_type = str(segment.get("type", "")).strip().lower()
                data = segment.get("data")
                if not isinstance(data, dict):
                    continue
                if seg_type == "node":
                    content = data.get("content")
                    if isinstance(content, list):
                        pending_segments.append(content)
                    continue
                if seg_type not in {"image", "record", "video", "file"}:
                    continue
                if str(data.get("url", "")).strip():
                    continue
                source = str(data.get("file", "")).strip()
                if not source:
                    continue
                data["url"] = await self.files.build_token_url(source, seg_type)
        return message
