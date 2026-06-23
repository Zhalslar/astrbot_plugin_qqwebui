from __future__ import annotations

from collections import deque
from dataclasses import replace
from time import time
from typing import Any

from .models import ContactRecord, MessageRecord, SessionSummary


class MessageCache:
    """Keep a bounded recent message window for active sessions."""

    def __init__(self, *, per_session_limit: int, global_limit: int):
        self._per_session_limit = per_session_limit
        self._global_limit = global_limit
        self._messages_by_session: dict[str, list[MessageRecord]] = {}
        self._messages_by_id: dict[str, MessageRecord] = {}
        self._global_order: deque[tuple[str, str]] = deque()

    def append(self, message: MessageRecord) -> None:
        if message.message_id in self._messages_by_id:
            return
        rows = self._messages_by_session.setdefault(message.session_id, [])
        rows.append(message)
        self._messages_by_id[message.message_id] = message
        self._global_order.append((message.session_id, message.message_id))

        if len(rows) > self._per_session_limit:
            removed = rows.pop(0)
            self._messages_by_id.pop(removed.message_id, None)
            self._discard_global_entry(removed.session_id, removed.message_id)
        while len(self._messages_by_id) > self._global_limit and self._global_order:
            session_id, message_id = self._global_order.popleft()
            if message_id not in self._messages_by_id:
                continue
            self._messages_by_id.pop(message_id, None)
            items = self._messages_by_session.get(session_id, [])
            self._messages_by_session[session_id] = [
                item for item in items if item.message_id != message_id
            ]

    def list(
        self,
        session_id: str,
        *,
        before: int | None = None,
        limit: int = 50,
    ) -> list[MessageRecord]:
        rows = self._messages_by_session.get(session_id, [])
        filtered = [row for row in rows if before is None or row.timestamp < before]
        return filtered[-limit:]

    def clear_session(self, session_id: str) -> None:
        rows = self._messages_by_session.pop(session_id, [])
        for row in rows:
            self._messages_by_id.pop(row.message_id, None)
            self._discard_global_entry(session_id, row.message_id)

    def export_data(self) -> dict[str, list[dict[str, Any]]]:
        return {
            "messages": [
                item.to_dict()
                for rows in self._messages_by_session.values()
                for item in rows
            ]
        }

    def load_data(self, rows: list[dict[str, Any]]) -> None:
        self._messages_by_session.clear()
        self._messages_by_id.clear()
        self._global_order.clear()
        for row in rows:
            self.append(MessageRecord.from_dict(row))

    @staticmethod
    def _rebuild_order_without(
        order: deque[tuple[str, str]],
        session_id: str,
        message_id: str,
    ) -> deque[tuple[str, str]]:
        return deque(item for item in order if item != (session_id, message_id))

    def _discard_global_entry(self, session_id: str, message_id: str) -> None:
        self._global_order = self._rebuild_order_without(
            self._global_order,
            session_id,
            message_id,
        )


class SessionCache:
    """Store conversation summaries and unread counters."""

    def __init__(self):
        self._sessions: dict[str, SessionSummary] = {}

    def upsert(self, session: SessionSummary) -> SessionSummary:
        self._sessions[session.session_id] = session
        return session

    def touch_with_message(
        self, message: MessageRecord, *, title: str, avatar: str
    ) -> None:
        current = self._sessions.get(message.session_id)
        unread_count = current.unread_count if current else 0
        member_count = current.member_count if current else None
        target_id = current.target_id if current else ""
        if not target_id:
            _, _, target_id = message.session_id.partition(":")
        if not target_id:
            target_id = message.sender_id
        self._sessions[message.session_id] = SessionSummary(
            session_id=message.session_id,
            chat_type=message.chat_type,
            target_id=target_id,
            title=title,
            avatar=avatar,
            unread_count=unread_count,
            last_message_id=message.message_id,
            last_message_preview=message.plain_text or self._preview_for_empty(message),
            last_timestamp=message.timestamp,
            member_count=member_count,
        )

    def increment_unread(self, session_id: str) -> None:
        session = self._sessions.get(session_id)
        if not session:
            return
        session.unread_count += 1

    def mark_read(self, session_id: str) -> SessionSummary | None:
        session = self._sessions.get(session_id)
        if session is None:
            return None
        session.unread_count = 0
        return session

    def list_sorted(
        self,
        *,
        keyword: str = "",
        chat_type: str = "",
        limit: int = 200,
    ) -> list[SessionSummary]:
        rows = list(self._sessions.values())
        if chat_type:
            rows = [row for row in rows if row.chat_type == chat_type]
        if keyword:
            lowered = keyword.lower()
            rows = [
                row
                for row in rows
                if lowered in row.title.lower() or lowered in row.target_id.lower()
            ]
        rows.sort(key=lambda row: (row.last_timestamp, row.session_id), reverse=True)
        return rows[:limit]

    def get(self, session_id: str) -> SessionSummary | None:
        return self._sessions.get(session_id)

    def export_data(self) -> dict[str, list[dict[str, Any]]]:
        return {"sessions": [item.to_dict() for item in self._sessions.values()]}

    def load_data(self, rows: list[dict[str, Any]]) -> None:
        self._sessions.clear()
        for row in rows:
            session = SessionSummary.from_dict(row)
            if session.session_id:
                chat_type, _, target_id = session.session_id.partition(":")
                if chat_type in {"private", "group"} and target_id:
                    session.target_id = target_id
                self._sessions[session.session_id] = session

    @staticmethod
    def _preview_for_empty(message: MessageRecord) -> str:
        if message.attachments:
            return f"[{message.attachments[0].kind}]"
        return "[message]"


class ContactCache:
    """Keep lightweight contact and member metadata with TTL markers."""

    def __init__(self):
        self.login_info: dict[str, str] = {}
        self.friends: dict[str, ContactRecord] = {}
        self.groups: dict[str, ContactRecord] = {}
        self.group_members: dict[str, dict[str, ContactRecord]] = {}
        self.user_profiles: dict[str, ContactRecord] = {}
        self.last_friend_refresh_at = 0.0
        self.last_group_refresh_at = 0.0
        self.group_member_refresh_at: dict[str, float] = {}

    def upsert_friend(self, item: ContactRecord) -> None:
        self.friends[item.id] = item
        self.user_profiles[item.id] = item

    def upsert_group(self, item: ContactRecord) -> None:
        self.groups[item.id] = item

    def upsert_group_member(self, group_id: str, item: ContactRecord) -> None:
        self.group_members.setdefault(group_id, {})[item.id] = item
        self.user_profiles[item.id] = replace(item, type="group_member")

    def list_contacts(
        self, *, scope: str = "all", keyword: str = ""
    ) -> list[ContactRecord]:
        rows: list[ContactRecord] = []
        if scope in {"all", "friends"}:
            rows.extend(self.friends.values())
        if scope in {"all", "groups"}:
            rows.extend(self.groups.values())
        if scope in {"all", "members"}:
            for members in self.group_members.values():
                rows.extend(members.values())
        if keyword:
            lowered = keyword.lower()
            rows = [
                row
                for row in rows
                if lowered in row.title.lower()
                or lowered in row.id.lower()
                or lowered in row.subtitle.lower()
            ]
        seen: set[tuple[str, str]] = set()
        deduped: list[ContactRecord] = []
        for row in rows:
            key = (row.type, row.id)
            if key in seen:
                continue
            seen.add(key)
            deduped.append(row)
        return deduped

    def export_data(self) -> dict[str, Any]:
        return {
            "login_info": dict(self.login_info),
            "friends": [item.to_dict() for item in self.friends.values()],
            "groups": [item.to_dict() for item in self.groups.values()],
            "user_profiles": [item.to_dict() for item in self.user_profiles.values()],
            "group_members": {
                group_id: [item.to_dict() for item in members.values()]
                for group_id, members in self.group_members.items()
            },
            "last_friend_refresh_at": self.last_friend_refresh_at,
            "last_group_refresh_at": self.last_group_refresh_at,
            "group_member_refresh_at": dict(self.group_member_refresh_at),
        }

    def load_data(self, data: dict[str, Any]) -> None:
        self.login_info = {
            "user_id": str((data.get("login_info") or {}).get("user_id", "")),
            "nickname": str((data.get("login_info") or {}).get("nickname", "")),
        }
        self.friends = {
            item.id: item
            for item in (
                ContactRecord.from_dict(row)
                for row in data.get("friends", [])
                if isinstance(row, dict)
            )
            if item.id
        }
        self.groups = {
            item.id: item
            for item in (
                ContactRecord.from_dict(row)
                for row in data.get("groups", [])
                if isinstance(row, dict)
            )
            if item.id
        }
        self.user_profiles = {
            item.id: item
            for item in (
                ContactRecord.from_dict(row)
                for row in data.get("user_profiles", [])
                if isinstance(row, dict)
            )
            if item.id
        }
        self.group_members = {}
        for group_id, rows in (data.get("group_members") or {}).items():
            if not isinstance(rows, list):
                continue
            self.group_members[str(group_id)] = {
                item.id: item
                for item in (
                    ContactRecord.from_dict(row)
                    for row in rows
                    if isinstance(row, dict)
                )
                if item.id
            }
        self.last_friend_refresh_at = float(
            data.get("last_friend_refresh_at", 0.0) or 0.0
        )
        self.last_group_refresh_at = float(
            data.get("last_group_refresh_at", 0.0) or 0.0
        )
        self.group_member_refresh_at = {
            str(group_id): float(value or 0.0)
            for group_id, value in (data.get("group_member_refresh_at") or {}).items()
        }


class QQWebuiStore:
    """Compose the caches used by the first WebUI validation build."""

    def __init__(self, *, per_session_limit: int, global_limit: int):
        self.messages = MessageCache(
            per_session_limit=per_session_limit,
            global_limit=global_limit,
        )
        self.sessions = SessionCache()
        self.contacts = ContactCache()
        self.started_at = int(time())
        self.last_active_session_id = ""

    def export_data(self) -> dict[str, Any]:
        return {
            "started_at": self.started_at,
            "last_active_session_id": self.last_active_session_id,
            **self.messages.export_data(),
            **self.sessions.export_data(),
            "contacts": self.contacts.export_data(),
        }

    def load_data(self, data: dict[str, Any]) -> None:
        self.started_at = int(
            data.get("started_at", self.started_at) or self.started_at
        )
        self.last_active_session_id = str(data.get("last_active_session_id", "") or "")
        self.messages.load_data(
            [row for row in data.get("messages", []) if isinstance(row, dict)]
        )
        self.sessions.load_data(
            [row for row in data.get("sessions", []) if isinstance(row, dict)]
        )
        contacts = data.get("contacts")
        if isinstance(contacts, dict):
            self.contacts.load_data(contacts)
