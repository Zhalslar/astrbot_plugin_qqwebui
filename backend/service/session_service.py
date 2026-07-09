from __future__ import annotations

import asyncio
from typing import Any

from aiocqhttp import CQHttp

from astrbot.api import logger

from ..infra.event import OnebotEvent
from ..infra.models import (
    EventRecord,
    GroupMemberProfile,
    GroupProfile,
    SessionPreview,
    UserProfile,
)
from ..infra.store import QQWebuiStore
from .file_service import FileService
from .sse_service import SseService


class SessionService:
    def __init__(
        self,
        bot: CQHttp,
        store: QQWebuiStore,
        sse: SseService,
        files: FileService,
    ):
        self.bot = bot
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

    async def fetch_history(
        self,
        message_type: str,
        target_id: str,
        *,
        message_seq: int = 0,
        count: int = 50,
    ) -> dict[str, Any]:
        """Fetch historical OneBot messages without mutating the live cache.

        Args:
            message_type: History scope, either ``group`` or ``private``.
            target_id: QQ group id or friend user id.
            message_seq: Upstream message cursor. ``0`` asks for the latest page.
            count: Number of messages to request from upstream.

        Returns:
            WebUI-shaped messages plus the cursor for the next older page.

        Raises:
            ValueError: The target, message type, cursor, or count is invalid.
        """

        clean_message_type = str(message_type).strip()
        clean_target_id = str(target_id).strip()
        if clean_message_type not in {"group", "private"}:
            raise ValueError("message_type must be group or private")
        if not clean_target_id:
            raise ValueError(
                "group_id is required"
                if clean_message_type == "group"
                else "user_id is required"
            )
        if not clean_target_id.isdigit():
            raise ValueError(
                "group_id must be numeric"
                if clean_message_type == "group"
                else "user_id must be numeric"
            )

        try:
            clean_message_seq = int(message_seq)
        except (TypeError, ValueError) as exc:
            raise ValueError("message_seq must be numeric") from exc

        try:
            clean_count = int(count)
        except (TypeError, ValueError) as exc:
            raise ValueError("count must be numeric") from exc
        if clean_count < 1:
            raise ValueError("count must be greater than 0")
        clean_count = min(clean_count, 200)

        if clean_message_type == "group":
            result = await self.bot.get_group_msg_history(
                group_id=int(clean_target_id),
                message_seq=clean_message_seq,
                count=clean_count,
                reverseOrder=True,
            )
        else:
            result = await self.bot.get_friend_msg_history(
                user_id=int(clean_target_id),
                message_seq=clean_message_seq,
                count=clean_count,
                reverseOrder=True,
            )

        raw_messages = []
        if isinstance(result, dict) and isinstance(result.get("messages"), list):
            raw_messages = result["messages"]

        records: list[EventRecord] = []
        for raw_message in raw_messages:
            record = self._history_message_to_record(
                clean_message_type,
                clean_target_id,
                raw_message,
            )
            if record is not None:
                records.append(record)

        current_message_seq = str(clean_message_seq)
        next_message_seq = records[0].message_id if records else current_message_seq
        session_id = f"{clean_message_type}:{clean_target_id}"
        session = self.store.sessions.get(session_id)
        if session is None:
            latest_record = records[-1] if records else None
            title = clean_target_id
            member_count = None
            if clean_message_type == "group":
                group = self.store.contacts.groups.get(clean_target_id)
                title = group.display_name if group else f"Group {clean_target_id}"
                members = self.store.contacts.members.get(clean_target_id, {})
                member_count = len(members) if members else None
            else:
                user = self.store.contacts.users.get(clean_target_id)
                title = user.display_name if user else clean_target_id
            session = SessionPreview(
                session_id=session_id,
                message_type=clean_message_type,
                title=title,
                sender_name=(
                    latest_record.sender.card
                    or latest_record.sender.nickname
                    or latest_record.user_id
                    if latest_record
                    else ""
                ),
                kind=latest_record.post_type if latest_record else "message",
                summary=latest_record.summary if latest_record else "",
                time=latest_record.time if latest_record else 0,
                member_count=member_count,
            )
        return {
            "items": [record.to_dict() for record in records],
            "session": session.to_dict() if session else None,
            "message_seq": current_message_seq,
            "next_message_seq": next_message_seq,
            "has_more": bool(records) and next_message_seq != current_message_seq,
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

    def cache_event(self, event: OnebotEvent) -> None:
        """Cache a OneBot event and publish the updated session.

        Args:
            event: Parsed OneBot event to append to the active session stream.
        """

        message = event.to_event_record()
        title = self._sync_event_profiles(event)
        if message.post_type == "message":
            self._add_at_name(message)
        if message.notice_type in {"group_recall", "friend_recall"}:
            self._apply_recall_notice(message)
        self.store.messages.append(message)
        self.store.sessions.touch_with_event(message, title=title)
        session = self.store.sessions.get(message.session_id)
        if session is None:
            return
        if message.post_type == "message":
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
        if message.post_type == "message":
            asyncio.create_task(self.normalize_message_media_urls(message))

    def _sync_event_profiles(self, event: OnebotEvent) -> str:
        title = event.sender_name
        if event.user_id:
            user = self.store.contacts.users.get(event.user_id)
            if user is None:
                user = UserProfile(user_id=event.user_id)
            user.patch(nickname=event.sender.nickname)
            if event.notice_type == "friend_add":
                user.is_friend = True
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

    def _add_at_name(self, message: EventRecord) -> None:
        for segment in message.message:
            if segment["type"] != "at":
                continue
            data: dict = segment["data"]
            qq = str(data.get("qq", "") or "")
            if not qq:
                continue
            if not data.get("name"):
                data["name"] = self.store.get_user_name(qq, message.group_id)

    def _apply_recall_notice(self, notice: EventRecord) -> None:
        """Apply a recall notice to the cached original message.

        Args:
            notice: Recall notice event that references the original OneBot message id.
        """

        source_message_id = str(notice.notice.get("message_id", "") or "").strip()
        if not source_message_id:
            return
        target_session_id = notice.session_id
        original = self.store.messages.get(target_session_id, source_message_id)
        if original is None:
            found = self.store.messages.find(source_message_id)
            if found is None:
                return
            target_session_id, original = found
        operator_id = str(
            notice.notice.get("operator_id") or notice.user_id or notice.self_id or ""
        ).strip()
        self.store.messages.mark_recalled(
            target_session_id,
            source_message_id,
            operator_id=operator_id,
        )

    async def normalize_message_media_urls(self, message: EventRecord) -> None:
        """Replace cached media URLs in the background.

        Args:
            message: Message record whose media segments should be normalized.
        """

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

    def _history_message_to_record(
        self,
        message_type: str,
        target_id: str,
        raw_message: Any,
    ) -> EventRecord | None:
        """Convert an upstream history row into the WebUI event model.

        Args:
            message_type: Normalized session type, ``group`` or ``private``.
            target_id: QQ group id or friend user id for the session.
            raw_message: OneBot history row returned by upstream.

        Returns:
            Parsed event record, or None when the row cannot be rendered.
        """

        if not isinstance(raw_message, dict):
            return None

        payload = dict(raw_message)
        message_id = str(
            payload.get("message_id") or payload.get("message_seq") or ""
        ).strip()
        if not message_id:
            return None

        raw_segments = payload.get("message", [])
        raw_text = str(payload.get("raw_message", "") or "")
        if isinstance(raw_segments, str):
            raw_text = raw_segments if not raw_text else raw_text
            segments = [{"type": "text", "data": {"text": raw_segments}}]
        elif isinstance(raw_segments, list):
            segments = [dict(item) for item in raw_segments if isinstance(item, dict)]
        else:
            segments = []
        if not segments and raw_text:
            segments = [{"type": "text", "data": {"text": raw_text}}]

        sender = payload.get("sender", {})
        if not isinstance(sender, dict):
            sender = {}
        sender_user_id = str(
            sender.get("user_id") or payload.get("user_id") or ""
        ).strip()
        if not sender_user_id:
            sender_user_id = self.store.contacts.login.user_id or target_id
        sender["user_id"] = sender_user_id

        payload.update(
            {
                "self_id": str(
                    payload.get("self_id") or self.store.contacts.login.user_id or ""
                ),
                "user_id": sender_user_id,
                "time": int(payload.get("time", 0) or 0),
                "message_id": message_id,
                "post_type": "message",
                "message_type": message_type,
                "message_format": "array",
                "sub_type": str(payload.get("sub_type", "") or ""),
                "raw_message": raw_text,
                "message": segments,
                "sender": sender,
                "group_id": target_id if message_type == "group" else "",
                "target_id": target_id,
            }
        )

        event = OnebotEvent.from_event(payload)
        if event is None:
            return None
        record = event.to_event_record()
        self._add_at_name(record)
        return record
