from __future__ import annotations

import asyncio
from typing import Any

from astrbot.api import logger

from ..infra.event import MessageEvent
from ..infra.models import (
    GroupMemberProfile,
    GroupProfile,
    MessageRecord,
    UserProfile,
)
from ..infra.store import QQWebuiStore
from .file_service import FileService
from .sse_service import SseService


class SessionService:
    def __init__(self, store: QQWebuiStore, sse: SseService, files: FileService):
        self.store = store
        self.sse = sse
        self.files = files

    async def list_sessions(
        self,
        *,
        keyword: str = "",
        message_type: str = "",
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        return [
            row.to_dict()
            for row in self.store.sessions.list_sorted(
                keyword=keyword,
                message_type=message_type,
                limit=limit,
            )
        ]

    async def list_messages(
        self,
        session_id: str,
        *,
        before: int | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        self.files.ensure_media_tokens_registered()
        rows = self.store.messages.list(session_id, before=before, limit=limit)
        session = self.store.sessions.get(session_id)
        return {
            "items": [row.to_dict() for row in rows],
            "session": session.to_dict() if session else None,
        }

    async def sync_session_view(
        self,
        session_id: str,
        at_bottom: bool,
        read_mid: str,
    ) -> dict[str, Any]:
        self.store.view_session_id = session_id
        self.store.view_at_bottom = at_bottom and bool(session_id)
        session = self.store.sessions.get(session_id) if session_id else None
        if (
            session is not None
            and at_bottom
            and read_mid
            and self.store.messages.has_message(session_id, read_mid)
        ):
            session = self.store.sessions.mark_read(session_id, read_mid)
        if session is not None and self.store.last_active_session_id != session_id:
            self.store.last_active_session_id = session_id
        return {
            "session": session.to_dict() if session else None,
            "last_active_session_id": self.store.last_active_session_id,
        }

    async def set_session_muted(self, session_id: str, muted: bool) -> dict[str, Any]:
        """Set a session's muted state.

        Args:
            session_id: Session identifier to update.
            muted: Whether the session should be muted.

        Returns:
            The updated session payload.

        Raises:
            ValueError: If the session id is empty or unknown.
        """

        if not session_id:
            raise ValueError("session_id is required")
        session = self.store.sessions.set_muted(session_id, muted)
        if session is None:
            raise ValueError("session not found")
        self.store.persist()
        self.sse.publish_session(
            session=session.to_dict(),
            last_active_session_id=self.store.last_active_session_id,
        )
        return {"session": session.to_dict()}

    async def set_session_pin(self, session_id: str, pin: bool) -> dict[str, Any]:
        """Set a session's pinned state.

        Args:
            session_id: Session identifier to update.
            pin: Whether the session should be pinned.

        Returns:
            The updated session payload.

        Raises:
            ValueError: If the session id is empty or unknown.
        """

        if not session_id:
            raise ValueError("session_id is required")
        session = self.store.sessions.set_pin(session_id, pin)
        if session is None:
            raise ValueError("session not found")
        self.store.persist()
        self.sse.publish_session(
            session=session.to_dict(),
            last_active_session_id=self.store.last_active_session_id,
        )
        return {"session": session.to_dict()}

    async def delete_session(self, session_id: str) -> dict[str, Any]:
        """Delete a cached session and its messages.

        Args:
            session_id: Session identifier to delete.

        Returns:
            The deleted session id payload.

        Raises:
            ValueError: If the session id is empty.
        """

        if not session_id:
            raise ValueError("session_id is required")
        self.store.sessions.delete(session_id)
        self.store.messages.clear_session(session_id)
        if self.store.last_active_session_id == session_id:
            self.store.last_active_session_id = ""
        if self.store.view_session_id == session_id:
            self.store.view_session_id = ""
            self.store.view_at_bottom = False
        self.store.persist()
        payload = {"session_id": session_id, "deleted": True}
        self.sse.publish_session(
            session=payload,
            last_active_session_id=self.store.last_active_session_id,
        )
        return payload

    def cache_message(self, event: MessageEvent) -> None:
        message = event.to_message_record()
        title = self._sync_event_profiles(event)
        self._add_at_name(message)
        self.store.messages.append(message)
        self.store.sessions.touch_with_message(message, title=title)
        session = self.store.sessions.get(message.session_id)
        if session is None:
            return
        if (
            self.store.view_at_bottom
            and self.store.view_session_id == message.session_id
        ):
            session.read_mid = message.message_id
            session.unread = 0
        elif not message.is_self:
            session.unread += 1
        self.sse.publish_message(
            message=message,
            session=session.to_dict(),
            last_active_session_id=self.store.last_active_session_id,
        )
        asyncio.create_task(self.normalize_message_media_urls(message))

    def _sync_event_profiles(self, event: MessageEvent) -> str:
        title = event.sender_name
        if event.user_id:
            user = self.store.contacts.users.get(event.user_id)
            if user is None:
                user = UserProfile(user_id=event.user_id)
            user.patch(nickname=event.sender.nickname)
            self.store.contacts.upsert_user(user)
            title = user.display_name

        if event.is_private:
            peer_id = event.target_id if event.is_self else event.user_id
            if peer_id:
                peer = self.store.contacts.users.get(peer_id)
                if peer is None:
                    peer = UserProfile(user_id=peer_id)
                if peer_id == event.user_id:
                    peer.patch(nickname=event.sender.nickname)
                self.store.contacts.upsert_user(peer)
                title = peer.display_name

        if event.is_group:
            group = self.store.contacts.groups.get(event.group_id)
            if group is None:
                group = GroupProfile(group_id=event.group_id)
            group.patch(group_name=event.group_name)
            if not group.group_name:
                group.group_name = f"Group {event.group_id}"
            self.store.contacts.upsert_group(group)
            title = group.display_name

            if event.user_id:
                members = self.store.contacts.members.setdefault(event.group_id, {})
                member = members.get(event.user_id)
                if member is None:
                    member = GroupMemberProfile(
                        group_id=event.group_id,
                        user_id=event.user_id,
                    )
                member.patch(
                    nickname=event.sender.nickname,
                    card=event.sender.card,
                    role=event.sender.role,
                    level=event.sender.level,
                )
                self.store.contacts.upsert_group_member(event.group_id, member)
        return title

    def _add_at_name(self, message: MessageRecord) -> None:
        for segment in message.message:
            if segment["type"] != "at":
                continue
            data: dict = segment["data"]
            qq = str(data.get("qq", "") or "")
            if not qq:
                continue
            if not data.get("name"):
                data["name"] = self.store.get_user_name(qq, message.group_id)

    async def normalize_message_media_urls(self, message: MessageRecord) -> None:
        """Replace cached media URLs in the background."""
        try:
            pending_segments = [message.message]
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
                    existing_url = str(data.get("url", "")).strip()
                    if existing_url.startswith("/api/v1/files/tokens/"):
                        continue
                    source = existing_url or str(data.get("file", "")).strip()
                    if not source:
                        continue
                    data["url"] = await self.files.build_token_url(source, seg_type)

        except Exception as exc:
            logger.warning(
                "[qqwebui] normalize media urls failed for session=%s message=%s: %s",
                message.session_id,
                message.message_id,
                exc,
            )
