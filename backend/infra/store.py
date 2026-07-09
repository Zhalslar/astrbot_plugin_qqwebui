from __future__ import annotations

import json
from pathlib import Path
from time import time
from typing import Any

from astrbot.api import logger

from ...config import PluginConfig
from .models import (
    ContactPreview,
    EventRecord,
    GroupMemberProfile,
    GroupProfile,
    LoginInfo,
    SessionPreview,
    UserProfile,
)


class EventCache:
    """Keep a bounded recent event window for active sessions."""

    def __init__(self, per_session_limit: int):
        self._per_session_limit = per_session_limit
        self._messages: dict[str, list[EventRecord]] = {}

    def append(self, message: EventRecord) -> None:
        rows = self._messages.setdefault(message.session_id, [])
        if any(item.message_id == message.message_id for item in rows):
            return
        insert_at = len(rows)
        while insert_at > 0 and rows[insert_at - 1].time > message.time:
            insert_at -= 1
        rows.insert(insert_at, message)
        if len(rows) > self._per_session_limit:
            rows.pop(0)

    def list(
        self,
        session_id: str,
        *,
        before: int | None = None,
        limit: int = 50,
    ) -> list[EventRecord]:
        rows = self._messages.get(session_id, [])
        filtered = [row for row in rows if before is None or row.time < before]
        return filtered[-limit:]

    def clear_session(self, session_id: str) -> None:
        self._messages.pop(session_id, None)

    def get(self, session_id: str, message_id: str) -> EventRecord | None:
        """Find a cached event by message id.

        Args:
            session_id: Session identifier that owns the event.
            message_id: OneBot message id to find.

        Returns:
            Cached event record, or None when it is not present.
        """

        return next(
            (
                item
                for item in self._messages.get(session_id, [])
                if item.message_id == message_id
            ),
            None,
        )

    def find(self, message_id: str) -> tuple[str, EventRecord] | None:
        """Find a cached event across all sessions.

        Args:
            message_id: OneBot message id to find.

        Returns:
            Tuple of session id and cached event, or None when it is not present.
        """

        for session_id, rows in self._messages.items():
            for item in rows:
                if item.message_id == message_id:
                    return session_id, item
        return None

    def has_message(self, session_id: str, message_id: str) -> bool:
        return any(
            item.message_id == message_id for item in self._messages.get(session_id, [])
        )

    def remove(self, session_id: str, message_id: str) -> EventRecord | None:
        """Remove a cached event by message id.

        Args:
            session_id: Session identifier that owns the event.
            message_id: OneBot message id to remove.

        Returns:
            Removed event record, or None when it is not present.
        """

        rows = self._messages.get(session_id, [])
        for index, item in enumerate(rows):
            if item.message_id == message_id:
                return rows.pop(index)
        return None

    def mark_recalled(
        self, session_id: str, message_id: str, *, operator_id: str = ""
    ) -> EventRecord | None:
        """Mark a cached event as recalled while keeping its original content.

        Args:
            session_id: Session identifier that owns the event.
            message_id: OneBot message id to mark.
            operator_id: QQ id that performed the recall when known.

        Returns:
            Updated event record, or None when it is not present.
        """

        message = self.get(session_id, message_id)
        if message is None:
            return None
        message.recalled = True
        message.recall_operator_id = operator_id
        return message

    def export_data(self) -> dict[str, list[dict[str, Any]]]:
        return {
            "messages": [
                item.to_dict() for rows in self._messages.values() for item in rows
            ]
        }

    def load_data(self, rows: list[dict[str, Any]]) -> None:
        self._messages.clear()
        for row in rows:
            self.append(EventRecord.from_dict(row))


class SessionCache:
    """Store conversation summaries and read cursors."""

    def __init__(self):
        self._sessions: dict[str, SessionPreview] = {}

    def upsert(self, session: SessionPreview) -> SessionPreview:
        self._sessions[session.session_id] = session
        return session

    def touch_with_event(self, message: EventRecord, *, title: str) -> None:
        current = self._sessions.get(message.session_id)
        read_mid = current.read_mid if current else ""
        unread = current.unread if current else 0
        muted = current.muted if current else False
        pin = current.pin if current else False
        pin_at = current.pin_at if current else 0
        member_count = current.member_count if current else None
        sender_name = message.sender.card or message.sender.nickname or message.user_id
        self._sessions[message.session_id] = SessionPreview(
            session_id=message.session_id,
            message_type=message.message_type,
            title=title,
            sender_name=sender_name,
            read_mid=read_mid,
            unread=unread,
            muted=muted,
            pin=pin,
            pin_at=pin_at,
            kind=message.post_type or "message",
            summary=message.summary,
            time=message.time,
            member_count=member_count,
        )

    def update_member_count(self, session_id: str, member_count: int | None) -> None:
        session = self._sessions.get(session_id)
        if session is None:
            return
        session.member_count = member_count

    def mark_read(
        self,
        session_id: str,
        read_mid: str,
    ) -> SessionPreview | None:
        session = self._sessions.get(session_id)
        if session is None:
            return None
        session.read_mid = read_mid
        session.unread = 0
        return session

    def set_muted(self, session_id: str, muted: bool) -> SessionPreview | None:
        session = self._sessions.get(session_id)
        if session is None:
            return None
        session.muted = muted
        return session

    def set_pin(self, session_id: str, pin: bool) -> SessionPreview | None:
        """Set the pinned state for a cached session.

        Args:
            session_id: Session identifier such as ``group:123``.
            pin: Whether the session should be pinned.

        Returns:
            The updated session preview, or None when the session does not exist.
        """

        session = self._sessions.get(session_id)
        if session is None:
            return None
        session.pin = pin
        session.pin_at = int(time()) if pin else 0
        return session

    def delete(self, session_id: str) -> SessionPreview | None:
        """Remove a cached session.

        Args:
            session_id: Session identifier to remove.

        Returns:
            The removed session preview, or None when it does not exist.
        """

        return self._sessions.pop(session_id, None)

    def list_sorted(
        self,
        *,
        keyword: str = "",
        message_type: str = "",
        limit: int = 200,
    ) -> list[SessionPreview]:
        rows = list(self._sessions.values())
        if message_type:
            rows = [row for row in rows if row.message_type == message_type]
        if keyword:
            lowered = keyword.lower()
            rows = [
                row
                for row in rows
                if lowered in row.title.lower() or lowered in row.target_id.lower()
            ]
        rows.sort(
            key=lambda row: (
                row.pin,
                row.pin_at if row.pin else 0,
                row.time,
                row.session_id,
            ),
            reverse=True,
        )
        return rows[:limit]

    def get(self, session_id: str) -> SessionPreview | None:
        return self._sessions.get(session_id)

    def export_data(self) -> dict[str, list[dict[str, Any]]]:
        return {"sessions": [item.to_dict() for item in self._sessions.values()]}

    def load_data(self, rows: list[dict[str, Any]]) -> None:
        self._sessions.clear()
        for row in rows:
            session = SessionPreview.from_dict(row)
            if session.session_id:
                self._sessions[session.session_id] = session


class ContactCache:
    """Keep cached contact profiles and expose lightweight contact previews."""

    def __init__(self):
        self.login = LoginInfo()
        self.users: dict[str, UserProfile] = {}
        self.groups: dict[str, GroupProfile] = {}
        self.members: dict[str, dict[str, GroupMemberProfile]] = {}

    def upsert_user(self, item: UserProfile) -> None:
        current = self.users.get(item.user_id)
        if current is None:
            self.users[item.user_id] = item
            return
        current.patch(**item.to_dict())

    def upsert_group(self, item: GroupProfile) -> None:
        self.groups[item.group_id] = item

    def upsert_group_member(self, group_id: str, item: GroupMemberProfile) -> None:
        members = self.members.setdefault(group_id, {})
        current_member = members.get(item.user_id)
        if current_member is None:
            members[item.user_id] = item
        else:
            current_member.patch(**item.to_dict())
        current = self.users.get(item.user_id)
        merged = UserProfile(
            user_id=item.user_id,
            nickname=item.nickname or (current.nickname if current else ""),
            sex=item.sex or (current.sex if current else "unknown"),
            age=item.age or (current.age if current else 0),
            area=item.area or (current.area if current else ""),
            is_friend=current.is_friend if current else False,
            uid=current.uid if current else "",
            qid=current.qid if current else "",
            qqLevel=current.qqLevel if current else 0,
            long_nick=current.long_nick if current else "",
            reg_time=current.reg_time if current else 0,
            is_vip=current.is_vip if current else False,
            is_years_vip=current.is_years_vip if current else False,
            vip_level=current.vip_level if current else 0,
            remark=current.remark if current else "",
            status=current.status if current else 0,
            login_days=current.login_days if current else 0,
            birthday_year=current.birthday_year if current else 0,
            birthday_month=current.birthday_month if current else 0,
            birthday_day=current.birthday_day if current else 0,
            kBloodType=current.kBloodType if current else 0,
            phoneNum=current.phoneNum if current else "",
            eMail=current.eMail if current else "",
            homeTown=current.homeTown if current else "",
            country=current.country if current else "",
            province=current.province if current else "",
            city=current.city if current else "",
            address=current.address if current else "",
            makeFriendCareer=current.makeFriendCareer if current else 0,
            labels=current.labels if current else "",
        )
        self.upsert_user(merged)

    @staticmethod
    def _user_item(item: UserProfile) -> ContactPreview:
        return ContactPreview(
            session_id=f"private:{item.user_id}",
            message_type="private",
            target_id=item.user_id,
            title=item.display_name,
            summary=f"Private {item.user_id}",
        )

    @staticmethod
    def _group_item(item: GroupProfile) -> ContactPreview:
        return ContactPreview(
            session_id=f"group:{item.group_id}",
            message_type="group",
            target_id=item.group_id,
            title=item.display_name,
            summary=f"Group {item.group_id}",
        )

    def list_contacts(
        self,
        *,
        scope: str = "all",
        keyword: str = "",
    ) -> list[ContactPreview]:
        rows: list[ContactPreview] = []
        if scope in {"all", "friends"}:
            rows.extend(
                self._user_item(item)
                for item in self.users.values()
                if scope == "all" or item.is_friend
            )
        if scope in {"all", "groups"}:
            rows.extend(self._group_item(item) for item in self.groups.values())
        if keyword:
            lowered = keyword.lower()
            rows = [
                row
                for row in rows
                if lowered in row.title.lower()
                or lowered in row.target_id.lower()
                or lowered in row.summary.lower()
            ]
        seen: set[tuple[str, str]] = set()
        deduped: list[ContactPreview] = []
        for row in rows:
            key = (row.message_type, row.target_id)
            if key in seen:
                continue
            seen.add(key)
            deduped.append(row)
        return deduped

    def export_data(self) -> dict[str, Any]:
        return {
            "login": self.login.to_dict(),
            "groups": [item.to_dict() for item in self.groups.values()],
            "users": [item.to_dict() for item in self.users.values()],
            "group_members": {
                group_id: [item.to_dict() for item in members.values()]
                for group_id, members in self.members.items()
            },
        }

    def load_data(self, data: dict[str, Any]) -> None:
        raw_login_info = data.get("login", {})
        if not isinstance(raw_login_info, dict):
            raw_login_info = {}
        self.login = LoginInfo.from_dict(raw_login_info)
        self.groups = {
            item.group_id: item
            for item in (
                GroupProfile.from_dict(row)
                for row in data.get("groups", [])
                if isinstance(row, dict)
            )
            if item.group_id
        }
        self.users = {
            item.user_id: item
            for item in (
                UserProfile.from_dict(row)
                for row in data.get("users", [])
                if isinstance(row, dict)
            )
            if item.user_id
        }
        self.members = {}
        raw_group_members = data.get("group_members", {})
        if isinstance(raw_group_members, dict):
            for group_id, rows in raw_group_members.items():
                if not isinstance(rows, list):
                    continue
                members = {
                    item.user_id: item
                    for item in (
                        GroupMemberProfile.from_dict(row)
                        for row in rows
                        if isinstance(row, dict)
                    )
                    if item.user_id
                }
                if members:
                    self.members[str(group_id)] = members


class MediaTokenCache:
    """Persist reusable media token entries for file-token restoration."""

    def __init__(self) -> None:
        self.entries: list[dict[str, str]] = []
        self._file_paths_by_token: dict[str, str] = {}

    def export_data(self) -> list[dict[str, str]]:
        return self.entries

    def load_data(self, rows: list[dict[str, Any]]) -> None:
        self.entries = []
        self._file_paths_by_token = {}
        for entry in rows:
            if not isinstance(entry, dict):
                continue
            token = str(entry.get("token", "") or "").strip()
            file_path = str(entry.get("file_path", "") or "").strip()
            if not token or not file_path:
                continue
            self.entries.append({"token": token, "file_path": file_path})
        self._file_paths_by_token = {
            entry["token"]: entry["file_path"] for entry in self.entries
        }

    def remember(self, token: str, file_path: str) -> None:
        normalized_token = str(token or "").strip()
        normalized_path = str(file_path or "").strip()
        if not normalized_token or not normalized_path:
            return
        self.entries = [
            entry
            for entry in self.entries
            if entry.get("token") != normalized_token
            and entry.get("file_path") != normalized_path
        ]
        self.entries.append({"token": normalized_token, "file_path": normalized_path})
        self._file_paths_by_token = {
            entry["token"]: entry["file_path"] for entry in self.entries
        }

    def prune_missing_files(self) -> None:
        self.entries = [
            entry
            for entry in self.entries
            if Path(str(entry.get("file_path", "") or "")).is_file()
        ]
        self._file_paths_by_token = {
            entry["token"]: entry["file_path"] for entry in self.entries
        }

    def file_path_for_token(self, token: str) -> str:
        """Return the cached file path for a media token.

        Args:
            token: File token to look up.

        Returns:
            Cached media file path, or an empty string when unknown.
        """

        return self._file_paths_by_token.get(str(token or "").strip(), "")


class QQWebuiStore:
    """Compose the caches used by the first WebUI validation build."""

    def __init__(self, cfg: PluginConfig):
        self.cfg = cfg
        self.messages = EventCache(self.cfg.session_message_limit)
        self.sessions = SessionCache()
        self.contacts = ContactCache()
        self.media_tokens = MediaTokenCache()
        self.started_at = int(time())
        self.last_active_session_id = ""
        self.view_session_id = ""
        self.view_at_bottom = False

    def export_data(self) -> dict[str, Any]:
        return {
            "started_at": self.started_at,
            "last_active_session_id": self.last_active_session_id,
            "media_token_entries": self.media_tokens.export_data(),
            **self.messages.export_data(),
            **self.sessions.export_data(),
            "contacts": self.contacts.export_data(),
        }

    def load_data(self, data: dict[str, Any]) -> None:
        self.started_at = int(
            data.get("started_at", self.started_at) or self.started_at
        )
        self.last_active_session_id = str(data.get("last_active_session_id", "") or "")
        raw_media_token_entries = data.get("media_token_entries", [])
        if isinstance(raw_media_token_entries, list):
            self.media_tokens.load_data(raw_media_token_entries)
        self.messages.load_data(
            [row for row in data.get("messages", []) if isinstance(row, dict)]
        )
        self.sessions.load_data(
            [row for row in data.get("sessions", []) if isinstance(row, dict)]
        )
        contacts = data.get("contacts")
        if isinstance(contacts, dict):
            self.contacts.load_data(contacts)

    def persist(self) -> None:
        """Persist the current store snapshot to the configured cache file."""

        try:
            self.cfg.cache_store_path.write_text(
                json.dumps(self.export_data(), ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception as exc:
            logger.debug("[qqwebui] persist cache failed: %s", exc)

    def load(self) -> None:
        """Load the persisted store snapshot from the configured cache file."""

        path = self.cfg.cache_store_path
        if not path.is_file():
            return
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.debug("[qqwebui] load persisted cache failed: %s", exc)
            return
        if isinstance(payload, dict):
            self.load_data(payload)

    def get_user_name(self, user_id: str, group_id: str = "") -> str:
        name = ""
        if not name and group_id:
            member = self.contacts.members.get(group_id, {}).get(user_id)
            if member is not None:
                name = member.display_name
        if not name:
            user = self.contacts.users.get(user_id)
            if user is not None:
                name = user.display_name
        if not name:
            login = self.contacts.login
            if user_id == login.user_id:
                name = login.nickname
        return name or user_id
