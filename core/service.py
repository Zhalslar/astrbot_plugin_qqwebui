from __future__ import annotations

import base64
import json
import mimetypes
import time
import uuid
from pathlib import Path
from typing import Any

from astrbot.api import logger
from astrbot.api.event import MessageChain
from astrbot.core.message.components import (
    At,
    Face,
    File,
    Forward,
    Image,
    Json,
    Node,
    Nodes,
    Plain,
    Record,
    Reply,
    Video,
)
from astrbot.core.platform.astr_message_event import AstrMessageEvent
from astrbot.core.platform.message_type import MessageType
from astrbot.core.platform.sources.aiocqhttp.aiocqhttp_message_event import (
    AiocqhttpMessageEvent,
)
from astrbot.core.utils.quoted_message.chain_parser import (
    OneBotPayloadParser,
    ReplyChainParser,
)
from astrbot.core.utils.quoted_message.onebot_client import OneBotClient

from ..config import PluginConfig
from .bot_client_manager import QQWebuiBotClientManager
from .media_cache import QQWebuiMediaCache
from .models import ContactRecord, MessageAttachment, MessageRecord
from .store import QQWebuiStore

MAX_ATTACHMENT_SIZE = 15 * 1024 * 1024
IMAGE_SUFFIXES = {
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".bmp",
    ".svg",
    ".heic",
    ".heif",
}
VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
AUDIO_SUFFIXES = {".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".amr"}


class QQWebuiService:
    """Coordinate cache reads, OneBot API calls, and event ingestion."""

    def __init__(self, context, cfg: PluginConfig):
        self.context = context
        self.cfg = cfg
        self.store = QQWebuiStore(
            per_session_limit=cfg.session_message_limit,
            global_limit=cfg.global_message_limit,
        )
        self.media_cache = QQWebuiMediaCache(self.cfg.media_dir)
        self.bot_clients = QQWebuiBotClientManager(context)

    async def initialize(self) -> None:
        self._load_persisted_store()

    async def terminate(self) -> None:
        self._persist_store()
        return None

    async def ingest_event(self, event: AiocqhttpMessageEvent) -> None:
        """Normalize incoming QQ traffic into the session/message caches."""
        if event.get_message_type() not in {
            MessageType.FRIEND_MESSAGE,
            MessageType.GROUP_MESSAGE,
        }:
            return
        self.bot_clients.bind(event.bot, self_id=str(event.get_self_id()))
        message = await self._record_from_event(event)
        if message is None:
            return
        self._refresh_profiles_from_event(event)
        title = await self._resolve_session_title(event)
        avatar = self._resolve_session_avatar(message.session_id)
        self.store.messages.append(message)
        self.store.sessions.touch_with_message(message, title=title, avatar=avatar)
        if not message.is_self:
            self.store.sessions.increment_unread(message.session_id)
        self._persist_store()

    async def capture_outgoing_result(self, event: AstrMessageEvent) -> None:
        """Mirror bot responses into the same session for quick UI validation."""
        result = event.get_result()
        if result is None or not result.chain:
            return
        if event.get_message_type() not in {
            MessageType.FRIEND_MESSAGE,
            MessageType.GROUP_MESSAGE,
        }:
            return
        session_id = self._build_session_id(
            "group" if event.get_group_id() else "private",
            event.get_group_id() or event.get_sender_id(),
        )
        chat_type = "group" if event.get_group_id() else "private"
        login = self.store.contacts.login_info
        sender_id = login.get("user_id") or event.get_self_id()
        sender_name = login.get("nickname") or "AstrBot"
        synthetic = await self._record_from_chain(
            message_id=f"local_out_{uuid.uuid4().hex}",
            session_id=session_id,
            chat_type=chat_type,
            sender_id=str(sender_id),
            sender_name=sender_name,
            is_self=True,
            timestamp=int(time.time()),
            chain=result.chain,
            event=event,
        )
        title = await self._resolve_outgoing_title(event)
        avatar = self._resolve_session_avatar(session_id)
        self.store.messages.append(synthetic)
        self.store.sessions.touch_with_message(synthetic, title=title, avatar=avatar)
        self._persist_store()

    async def get_status(self) -> dict[str, Any]:
        """Return adapter state and cache summary for the page header."""
        bot = self.bot_clients.get()
        online = False
        good = False
        if bot is not None:
            try:
                status = await bot.get_status()
                online = bool(status.get("online"))
                good = bool(status.get("good"))
            except Exception as exc:
                logger.debug("[qqwebui] get_status failed: %s", exc)
        login = await self._ensure_login_info()
        return {
            "adapter": {
                "name": "aiocqhttp",
                "bound": bot is not None,
                "online": online,
                "good": good,
            },
            "login": {
                "user_id": login.get("user_id", ""),
                "nickname": login.get("nickname", ""),
                "avatar": self._build_avatar_url(login.get("user_id", "")),
            },
            "cache": {
                "sessions": len(self.store.sessions.list_sorted(limit=10000)),
                "friends": len(self.store.contacts.friends),
                "groups": len(self.store.contacts.groups),
                "started_at": self.store.started_at,
            },
            "ui": {
                "last_active_session_id": self.store.last_active_session_id,
            },
            "limits": {
                "session_message_limit": self.cfg.session_message_limit,
                "global_message_limit": self.cfg.global_message_limit,
            },
        }

    async def list_sessions(
        self,
        *,
        keyword: str = "",
        chat_type: str = "",
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        self._normalize_session_avatars()
        return [
            row.to_dict()
            for row in self.store.sessions.list_sorted(
                keyword=keyword,
                chat_type=chat_type,
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
        self._normalize_session_avatar(session_id)
        rows = self.store.messages.list(session_id, before=before, limit=limit)
        return {
            "items": [row.to_dict() for row in rows],
            "session": self.store.sessions.get(session_id).to_dict()  # type: ignore
            if self.store.sessions.get(session_id)
            else None,
        }

    async def mark_session_read(self, session_id: str) -> dict[str, Any]:
        session = self.store.sessions.mark_read(session_id)
        if session is not None and self.store.last_active_session_id != session_id:
            self.store.last_active_session_id = session_id
            self._persist_store()
        return {
            "session": session.to_dict() if session else None,
        }

    async def send_message(
        self,
        session_id: str,
        text: str,
        attachment_keys: list[str] | None = None,
    ) -> dict[str, Any]:
        """Send text and optional attachments to a QQ private or group chat session."""
        content = text.strip()
        attachment_keys = [
            str(item).strip() for item in attachment_keys or [] if str(item).strip()
        ]
        if not content and not attachment_keys:
            raise ValueError("message text or attachment is required")
        bot = self.bot_clients.require()
        chat_type, target_id = self._parse_session_id(session_id)
        chain: list[Any] = []
        if content:
            chain.append(Plain(content))
        attachments: list[MessageAttachment] = []
        for attachment_key in attachment_keys:
            cached = self.media_cache.resolve_cached_file(attachment_key)
            chain.append(self._build_outgoing_component(cached))
            attachments.append(self._build_attachment_from_cached_media(cached))
        payload = MessageChain(chain=chain)
        await AiocqhttpMessageEvent.send_message(
            bot=bot,
            message_chain=payload,
            is_group=chat_type == "group",
            session_id=target_id,
        )
        login = await self._ensure_login_info()
        message = await self._record_from_chain(
            message_id=uuid.uuid4().hex,
            session_id=session_id,
            chat_type=chat_type,
            sender_id=str(login.get("user_id", "")),
            sender_name=str(login.get("nickname", "") or "AstrBot"),
            is_self=True,
            timestamp=int(time.time()),
            chain=payload.chain,
        )
        if attachments:
            message.attachments = attachments
            if not message.plain_text:
                message.plain_text = f"[{attachments[0].kind}]"
        title = await self._resolve_title_for_session(session_id)
        avatar = self._resolve_session_avatar(session_id)
        self.store.messages.append(message)
        self.store.sessions.touch_with_message(message, title=title, avatar=avatar)
        self._persist_store()
        return {"message": message.to_dict()}

    async def send_face(self, session_id: str, face_id: int) -> dict[str, Any]:
        """Send a QQ face component to the selected session."""
        session_id = str(session_id).strip()
        if not session_id:
            raise ValueError("session_id is required")
        if face_id < 0:
            raise ValueError("face_id is invalid")
        bot = self.bot_clients.require()
        chat_type, target_id = self._parse_session_id(session_id)
        payload = MessageChain(chain=[Face(id=face_id)])
        await AiocqhttpMessageEvent.send_message(
            bot=bot,
            message_chain=payload,
            is_group=chat_type == "group",
            session_id=target_id,
        )
        login = await self._ensure_login_info()
        message = await self._record_from_chain(
            message_id=uuid.uuid4().hex,
            session_id=session_id,
            chat_type=chat_type,
            sender_id=str(login.get("user_id", "")),
            sender_name=str(login.get("nickname", "") or "AstrBot"),
            is_self=True,
            timestamp=int(time.time()),
            chain=payload.chain,
        )
        title = await self._resolve_title_for_session(session_id)
        avatar = self._resolve_session_avatar(session_id)
        self.store.messages.append(message)
        self.store.sessions.touch_with_message(message, title=title, avatar=avatar)
        self._persist_store()
        return {"message": message.to_dict()}

    async def list_faces(self) -> list[dict[str, Any]]:
        """List available QQ face assets for the dashboard picker."""
        items: list[dict[str, Any]] = []
        face_dir = self.cfg.qq_face_dir
        if not face_dir.is_dir():
            return items
        for path in sorted(
            face_dir.glob("*.gif"),
            key=lambda item: int(item.stem) if item.stem.isdigit() else item.stem,
        ):
            if not path.stem.isdigit():
                continue
            face_ref = self.media_cache.cache_message_image(
                str(path),
                fallback_name=path.name,
            )
            items.append(
                {
                    "id": int(path.stem),
                    "name": path.stem,
                    "media_key": face_ref,
                }
            )
        return items

    async def upload_attachment(
        self,
        raw_bytes: bytes,
        filename: str,
        content_type: str,
    ) -> dict[str, Any]:
        cached = self.media_cache.cache_upload(
            raw_bytes,
            filename,
            content_type,
            max_size=MAX_ATTACHMENT_SIZE,
        )
        return {
            "key": cached.key,
            "name": cached.name,
            "content_type": cached.content_type,
            "size": cached.size,
            "kind": self._attachment_kind(cached.name, cached.content_type),
        }

    async def get_media_content(self, key: str) -> dict[str, Any]:
        cached = self.media_cache.resolve_cached_file(key)
        payload = cached.path.read_bytes()
        return {
            "key": cached.key,
            "name": cached.name,
            "content_type": cached.content_type,
            "content_base64": base64.b64encode(payload).decode("ascii"),
            "size": cached.size,
        }

    async def list_contacts(
        self,
        *,
        keyword: str = "",
        scope: str = "all",
    ) -> list[dict[str, Any]]:
        rows = self.store.contacts.list_contacts(scope=scope, keyword=keyword)
        return [row.to_dict() for row in rows]

    async def refresh_contacts(self, *, force: bool = False) -> dict[str, Any]:
        bot = self.bot_clients.require()
        now = time.time()
        if (
            force
            or now - self.store.contacts.last_friend_refresh_at > self.cfg.contact_ttl
        ):
            friends = await bot.get_friend_list()
            self.store.contacts.friends.clear()
            for row in friends:
                user_id = str(row.get("user_id", "")).strip()
                if not user_id:
                    continue
                nickname = str(row.get("remark") or row.get("nickname") or user_id)
                self.store.contacts.upsert_friend(
                    ContactRecord(
                        id=user_id,
                        type="friend",
                        title=nickname,
                        subtitle=str(row.get("nickname") or ""),
                        avatar=self._build_avatar_url(user_id),
                        extra={"remark": str(row.get("remark") or "")},
                    )
                )
            self.store.contacts.last_friend_refresh_at = now
        if (
            force
            or now - self.store.contacts.last_group_refresh_at > self.cfg.contact_ttl
        ):
            groups = await bot.get_group_list()
            self.store.contacts.groups.clear()
            for row in groups:
                group_id = str(row.get("group_id", "")).strip()
                if not group_id:
                    continue
                self.store.contacts.upsert_group(
                    ContactRecord(
                        id=group_id,
                        type="group",
                        title=str(row.get("group_name") or group_id),
                        subtitle=f"{row.get('member_count', 0)} members",
                        avatar=self._build_group_avatar_url(group_id),
                        extra={
                            "member_count": row.get("member_count"),
                            "max_member_count": row.get("max_member_count"),
                        },
                    )
                )
            self.store.contacts.last_group_refresh_at = now
        await self._ensure_login_info()
        self._persist_store()
        return {
            "friends": len(self.store.contacts.friends),
            "groups": len(self.store.contacts.groups),
        }

    async def list_group_members(
        self,
        group_id: str,
        *,
        force: bool = False,
    ) -> dict[str, Any]:
        bot = self.bot_clients.require()
        group_id = str(group_id).strip()
        if not group_id:
            raise ValueError("group_id is required")
        now = time.time()
        last_refresh = self.store.contacts.group_member_refresh_at.get(group_id, 0.0)
        if force or now - last_refresh > self.cfg.group_member_ttl:
            rows = await bot.get_group_member_list(group_id=int(group_id))
            self.store.contacts.group_members[group_id] = {}
            for row in rows:
                user_id = str(row.get("user_id", "")).strip()
                if not user_id:
                    continue
                display_name = str(row.get("card") or row.get("nickname") or user_id)
                self.store.contacts.upsert_group_member(
                    group_id,
                    ContactRecord(
                        id=user_id,
                        type="group_member",
                        title=display_name,
                        subtitle=str(row.get("role") or "member"),
                        avatar=self._build_avatar_url(user_id),
                        extra={
                            "group_id": group_id,
                            "role": row.get("role"),
                            "card": row.get("card"),
                            "nickname": row.get("nickname"),
                            "title": row.get("title"),
                            "level": row.get("level"),
                        },
                    ),
                )
            self.store.contacts.group_member_refresh_at[group_id] = now
            session = self.store.sessions.get(f"group:{group_id}")
            if session is not None:
                session.member_count = len(self.store.contacts.group_members[group_id])
            self._persist_store()
        members = list(self.store.contacts.group_members.get(group_id, {}).values())
        members.sort(
            key=lambda row: (row.extra.get("role") != "owner", row.title.lower())
        )
        return {
            "items": [row.to_dict() for row in members],
            "group_id": group_id,
        }

    async def _ensure_login_info(self) -> dict[str, str]:
        bot = self.bot_clients.get()
        if bot is None:
            return self.store.contacts.login_info
        if self.store.contacts.login_info:
            return self.store.contacts.login_info
        try:
            info = await bot.get_login_info()
        except Exception as exc:
            logger.debug("[qqwebui] get_login_info failed: %s", exc)
            return self.store.contacts.login_info
        self.store.contacts.login_info = {
            "user_id": str(info.get("user_id", "")),
            "nickname": str(info.get("nickname", "")),
        }
        self._persist_store()
        return self.store.contacts.login_info

    async def _resolve_session_title(self, event: AiocqhttpMessageEvent) -> str:
        raw = self._event_payload(event)
        group_id = str(event.get_group_id() or raw.get("group_id", "")).strip()
        if group_id:
            if str(raw.get("group_name", "")).strip():
                return str(raw.get("group_name")).strip()
            cached = self.store.contacts.groups.get(group_id)
            if cached is not None:
                return cached.title
            return f"Group {group_id}"
        sender_id = str(event.get_sender_id() or raw.get("user_id", "")).strip()
        if sender_id == str(event.get_self_id() or raw.get("self_id", "")).strip():
            sender_id = str(raw.get("target_id") or sender_id).strip()
        cached = self.store.contacts.user_profiles.get(sender_id)
        if cached is not None:
            return cached.title
        return self._sender_display_name(raw, event.get_sender_name() or sender_id)

    async def _resolve_outgoing_title(self, event: AstrMessageEvent) -> str:
        if event.get_group_id():
            return await self._resolve_title_for_session(
                f"group:{event.get_group_id()}"
            )
        return await self._resolve_title_for_session(f"private:{event.get_sender_id()}")

    async def _resolve_title_for_session(self, session_id: str) -> str:
        current = self.store.sessions.get(session_id)
        if current is not None:
            return current.title
        chat_type, target_id = self._parse_session_id(session_id)
        if chat_type == "group":
            cached = self.store.contacts.groups.get(target_id)
            return cached.title if cached else f"Group {target_id}"
        cached = self.store.contacts.user_profiles.get(target_id)
        return cached.title if cached else target_id

    def _refresh_profiles_from_event(self, event: AiocqhttpMessageEvent) -> None:
        raw = self._event_payload(event)
        sender_id = str(event.get_sender_id() or raw.get("user_id", "")).strip()
        if sender_id:
            sender = raw["sender"] if isinstance(raw.get("sender"), dict) else {}
            display_name = self._sender_display_name(
                raw,
                event.get_sender_name() or sender_id,
            )
            subtitle = str(sender.get("nickname") or display_name)
            self.store.contacts.user_profiles[sender_id] = ContactRecord(
                id=sender_id,
                type="profile",
                title=display_name,
                subtitle=subtitle,
                avatar=self._build_avatar_url(sender_id),
                extra={
                    "card": str(sender.get("card") or ""),
                    "role": str(sender.get("role") or ""),
                },
            )
        group_id = str(event.get_group_id() or raw.get("group_id", "")).strip()
        if group_id:
            current_group = self.store.contacts.groups.get(group_id)
            group_name = str(raw.get("group_name") or "").strip()
            if not group_name:
                group_name = current_group.title if current_group else group_id
            self.store.contacts.groups[group_id] = ContactRecord(
                id=group_id,
                type="group",
                title=group_name,
                subtitle=current_group.subtitle if current_group else "",
                avatar=self._build_group_avatar_url(group_id),
                extra=dict(current_group.extra) if current_group else {},
            )

    @staticmethod
    def _event_payload(event: AiocqhttpMessageEvent) -> dict[str, Any]:
        raw = getattr(event, "message_obj", None)
        payload = getattr(raw, "raw_message", None)
        return payload if isinstance(payload, dict) else {}

    @staticmethod
    def _sender_display_name(raw: dict[str, Any], fallback: str) -> str:
        sender = raw["sender"] if isinstance(raw.get("sender"), dict) else {}
        return str(
            sender.get("card")
            or sender.get("nickname")
            or fallback
            or raw.get("user_id")
            or ""
        )

    def _persist_store(self) -> None:
        try:
            self.cfg.cache_store_path.write_text(
                json.dumps(self.store.export_data(), ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception as exc:
            logger.debug("[qqwebui] persist cache failed: %s", exc)

    def _load_persisted_store(self) -> None:
        path = self.cfg.cache_store_path
        if not path.is_file():
            return
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.debug("[qqwebui] load persisted cache failed: %s", exc)
            return
        if isinstance(payload, dict):
            self.store.load_data(payload)
            self._normalize_session_avatars()

    def _normalize_session_avatars(self) -> None:
        for session in self.store.sessions.list_sorted(limit=10000):
            session.avatar = self._resolve_session_avatar(session.session_id)

    def _normalize_session_avatar(self, session_id: str) -> None:
        session = self.store.sessions.get(session_id)
        if session is None:
            return
        session.avatar = self._resolve_session_avatar(session.session_id)

    async def _record_from_event(
        self, event: AiocqhttpMessageEvent
    ) -> MessageRecord | None:
        raw = self._event_payload(event)
        sender_id = str(event.get_sender_id() or raw.get("user_id", "")).strip()
        self_id = str(event.get_self_id() or raw.get("self_id", "")).strip()
        chat_type = (
            "group" if event.get_group_id() or raw.get("group_id") else "private"
        )
        target_id = (
            str(event.get_group_id() or raw.get("group_id", "")).strip()
            if chat_type == "group"
            else str(
                raw.get("target_id")
                if sender_id and sender_id == self_id
                else sender_id
            ).strip()
        )
        if not target_id:
            return None
        return await self._record_from_chain(
            message_id=str(event.message_obj.message_id),
            session_id=self._build_session_id(chat_type, target_id),
            chat_type=chat_type,
            sender_id=sender_id,
            sender_name=self._sender_display_name(
                raw,
                event.get_sender_name() or sender_id,
            ),
            is_self=bool(sender_id and sender_id == self_id),
            timestamp=int(
                raw.get("time")
                or getattr(event.message_obj, "timestamp", 0)
                or int(time.time())
            ),
            chain=event.get_messages(),
            event=event,
        )

    async def _record_from_chain(
        self,
        *,
        message_id: str,
        session_id: str,
        chat_type: str,
        sender_id: str,
        sender_name: str,
        is_self: bool,
        timestamp: int,
        chain: list[Any],
        event: AstrMessageEvent | None = None,
    ) -> MessageRecord:
        plain_parts: list[str] = []
        segments: list[dict[str, Any]] = []
        attachments: list[MessageAttachment] = []
        quote: dict[str, Any] | None = None
        forward: dict[str, Any] | None = None

        for segment in chain:
            if isinstance(segment, Plain):
                text = segment.text
                plain_parts.append(text)
                segments.append({"type": "text", "text": text})
            elif isinstance(segment, At):
                mention = f"@{segment.name or segment.qq} "
                plain_parts.append(mention)
                segments.append(
                    {"type": "at", "name": segment.name, "qq": str(segment.qq)}
                )
            elif isinstance(segment, Face):
                plain_parts.append("[表情]")
                face_segment: dict[str, Any] = {"type": "face", "id": int(segment.id)}
                face_name = f"{int(segment.id)}.gif"
                face_path = self.cfg.qq_face_dir / face_name
                if face_path.is_file():
                    face_ref = self.media_cache.cache_message_image(
                        str(face_path),
                        fallback_name=face_name,
                    )
                    face_url = self._resolve_media_url(face_ref)
                    if face_url:
                        face_segment["url"] = face_url
                    elif face_ref:
                        face_segment["media_key"] = face_ref
                segments.append(face_segment)
            elif isinstance(segment, Reply):
                quote = await self._build_quote_payload(segment, event)
                segments.append({"type": "reply", "quote": quote})
            elif isinstance(segment, Forward):
                forward = await self._build_forward_payload_from_component(
                    segment, event
                )
                segments.append({"type": "forward", "forward": forward})
            elif isinstance(segment, Nodes):
                forward = self._build_forward_payload_from_nodes_component(segment)
                segments.append({"type": "forward", "forward": forward})
            elif isinstance(segment, Node):
                forward = self._build_forward_payload_from_node_component(segment)
                segments.append({"type": "forward", "forward": forward})
            elif isinstance(segment, Json):
                forward = self._build_forward_payload_from_json_component(segment)
                if forward:
                    segments.append({"type": "forward", "forward": forward})
                else:
                    segments.append({"type": "json"})
            elif isinstance(segment, Image):
                image_source = str(segment.url or segment.file or segment.path or "")
                image_ref = self.media_cache.cache_message_image(
                    image_source,
                    fallback_name=Path(
                        str(segment.file or image_source or "image")
                    ).name,
                )
                attachments.append(
                    self._build_image_attachment(
                        image_ref,
                        Path(str(segment.file or image_source or "image")).name,
                    )
                )
                image_segment = {"type": "image"}
                image_url = self._resolve_media_url(image_ref)
                if image_url:
                    image_segment["url"] = image_url
                elif image_ref:
                    image_segment["media_key"] = image_ref
                segments.append(image_segment)
            elif isinstance(segment, Record):
                audio_source = str(segment.url or segment.file or segment.path or "")
                audio_name = Path(str(segment.file or audio_source or "audio")).name
                audio_ref = self.media_cache.cache_message_media(
                    audio_source,
                    fallback_name=audio_name,
                    content_type="audio/wav",
                )
                attachments.append(
                    self._build_media_attachment(
                        "audio",
                        audio_ref,
                        audio_name,
                    )
                )
                audio_segment = {"type": "record", "name": audio_name}
                audio_url = self._resolve_media_url(audio_ref)
                if audio_url:
                    audio_segment["url"] = audio_url
                elif audio_ref:
                    audio_segment["media_key"] = audio_ref
                segments.append(audio_segment)
            elif isinstance(segment, Video):
                video_source = str(segment.url or segment.file or segment.path or "")
                video_name = Path(str(segment.file or video_source or "video")).name
                video_ref = self.media_cache.cache_message_media(
                    video_source,
                    fallback_name=video_name,
                    content_type="video/mp4",
                )
                attachments.append(
                    self._build_media_attachment(
                        "video",
                        video_ref,
                        video_name,
                    )
                )
                video_segment = {"type": "video", "name": video_name}
                video_url = self._resolve_media_url(video_ref)
                if video_url:
                    video_segment["url"] = video_url
                elif video_ref:
                    video_segment["media_key"] = video_ref
                segments.append(video_segment)
            elif isinstance(segment, File):
                raw_value = str(segment.url or segment.file or "")
                file_url = self._resolve_media_url(raw_value)
                file_name = segment.name or Path(raw_value or "file").name or "file"
                suffix = Path(file_name).suffix.lower()
                if suffix in IMAGE_SUFFIXES:
                    image_ref = self.media_cache.cache_message_image(
                        raw_value,
                        fallback_name=file_name,
                    )
                    attachments.append(
                        self._build_image_attachment(image_ref, file_name)
                    )
                    image_segment = {"type": "image", "name": file_name}
                    image_url = self._resolve_media_url(image_ref)
                    if image_url:
                        image_segment["url"] = image_url
                    elif image_ref:
                        image_segment["media_key"] = image_ref
                    segments.append(image_segment)
                    continue
                file_ref = self.media_cache.cache_message_media(
                    raw_value,
                    fallback_name=file_name,
                    content_type=mimetypes.guess_type(file_name)[0]
                    or "application/octet-stream",
                )
                attachment_kind = self._attachment_kind(file_name)
                attachments.append(
                    self._build_media_attachment(
                        attachment_kind,
                        file_ref or file_url,
                        file_name,
                    )
                )
                file_segment = {"type": "file", "name": file_name}
                resolved_file_url = self._resolve_media_url(file_ref or file_url)
                if resolved_file_url:
                    file_segment["url"] = resolved_file_url
                elif file_ref:
                    file_segment["media_key"] = file_ref
                segments.append(file_segment)
            else:
                seg_type = getattr(segment, "type", None)
                segments.append({"type": str(seg_type or "unknown")})

        plain_text = "".join(plain_parts).strip()
        if (
            not plain_text
            and attachments
            and any(item.kind != "image" for item in attachments)
        ):
            plain_text = f"[{attachments[0].kind}]"
        if not plain_text and forward:
            plain_text = str(forward.get("preview") or "").strip() or "[forward]"
        return MessageRecord(
            message_id=message_id,
            session_id=session_id,
            chat_type=chat_type,
            sender_id=sender_id,
            sender_name=sender_name,
            is_self=is_self,
            timestamp=timestamp,
            plain_text=plain_text,
            segments=segments,
            attachments=attachments,
            quote=quote,
            forward=forward,
        )

    async def _build_quote_payload(
        self,
        reply: Reply,
        event: AstrMessageEvent | None,
    ) -> dict[str, Any]:
        """Build preview and detail data for a quoted message.

        Args:
            reply: The reply component carried by the message.
            event: The source event, used to resolve remote OneBot quote payloads.

        Returns:
            A serializable quote payload for the dashboard.
        """
        reply_parser = ReplyChainParser()
        preview_text = (
            reply_parser.extract_text_from_reply_component(reply)
            or str(reply.message_str or "").strip()
        )
        quote: dict[str, Any] = {
            "message_id": str(getattr(reply, "id", "") or ""),
            "sender_name": str(reply.sender_nickname or ""),
            "text": preview_text,
            "preview": preview_text,
            "items": [],
            "item_count": 0,
            "is_forward": bool(
                preview_text
                and reply_parser.is_forward_placeholder_only_text(preview_text)
            ),
        }

        embedded_items = self._extract_forward_items_from_component_chain(
            getattr(reply, "chain", None)
        )
        if embedded_items:
            quote["items"] = embedded_items
            quote["item_count"] = len(embedded_items)
            quote["is_forward"] = True

        reply_id = str(getattr(reply, "id", "") or "").strip()
        if event is not None and reply_id:
            remote_details = await self._fetch_quote_remote_details(event, reply_id)
            if remote_details["items"]:
                quote["items"] = remote_details["items"]
                quote["item_count"] = len(remote_details["items"])
                quote["is_forward"] = True
            if remote_details["is_forward"]:
                quote["is_forward"] = True
            if remote_details["summary"] and (
                not quote["text"]
                or reply_parser.is_forward_placeholder_only_text(str(quote["text"]))
            ):
                quote["text"] = remote_details["summary"]

        quote["preview"] = self._build_quote_preview(quote)
        if not quote["text"]:
            quote["text"] = (
                self._build_forward_preview_text(quote["items"])
                if quote["is_forward"]
                else quote["preview"]
            )
        return quote

    async def _build_forward_payload_from_component(
        self,
        forward: Forward,
        event: AstrMessageEvent | None,
    ) -> dict[str, Any]:
        """Build dashboard payload for a merged-forward component.

        Args:
            forward: The merged-forward component.
            event: The source event, used to resolve OneBot forward nodes.

        Returns:
            Structured preview and node items for UI rendering.
        """
        forward_id = str(getattr(forward, "id", "") or "").strip()
        items: list[dict[str, str]] = []
        if event is not None and forward_id:
            client = OneBotClient(event)
            items = await self._collect_forward_items(client, [forward_id])
        return self._build_forward_payload(items, forward_id=forward_id)

    def _build_forward_payload_from_nodes_component(
        self,
        nodes: Nodes,
    ) -> dict[str, Any]:
        """Build dashboard payload from embedded `Nodes` component."""
        items = self._extract_forward_items_from_component_chain([nodes])
        return self._build_forward_payload(items)

    def _build_forward_payload_from_node_component(
        self,
        node: Node,
    ) -> dict[str, Any]:
        """Build dashboard payload from a single embedded `Node` component."""
        items = self._extract_forward_items_from_component_chain([node])
        return self._build_forward_payload(items)

    def _build_forward_payload_from_json_component(
        self,
        segment: Json,
    ) -> dict[str, Any] | None:
        """Build dashboard payload from QQ multimsg json payload.

        Args:
            segment: The Json component in the message chain.

        Returns:
            Forward payload when the json is a QQ multimsg block, otherwise `None`.
        """
        data = getattr(segment, "data", None)
        raw_json = (
            json.dumps(data, ensure_ascii=False) if isinstance(data, dict) else ""
        )
        preview = self._extract_multimsg_preview(raw_json)
        if not preview:
            return None
        items = []
        for line in preview.splitlines():
            cleaned = line.strip()
            if cleaned:
                items.append({"sender_name": "", "text": cleaned})
        return self._build_forward_payload(items)

    async def _fetch_quote_remote_details(
        self,
        event: AstrMessageEvent,
        reply_id: str,
    ) -> dict[str, Any]:
        """Resolve a quoted message through OneBot APIs when local payload is incomplete.

        Args:
            event: The source event owning the active bot connection.
            reply_id: The quoted message id.

        Returns:
            Quote summary and flattened forwarded-node items.
        """
        client = OneBotClient(event)
        payload_parser = OneBotPayloadParser()
        msg_payload = await client.get_msg(reply_id)
        if not isinstance(msg_payload, dict):
            return {"summary": "", "items": [], "is_forward": False}

        parsed = payload_parser.parse_get_msg_payload(msg_payload)
        items, forward_ids = self._extract_forward_details_from_message_payload(
            msg_payload
        )
        nested_items = await self._collect_forward_items(client, forward_ids)
        if nested_items:
            items.extend(nested_items)
        return {
            "summary": str(parsed["text"] or "").strip(),
            "items": self._dedupe_quote_items(items),
            "is_forward": bool(forward_ids or items),
        }

    async def _collect_forward_items(
        self,
        client: OneBotClient,
        forward_ids: list[str],
    ) -> list[dict[str, str]]:
        """Collect merged-forward node previews recursively.

        Args:
            client: OneBot client bound to the current event.
            forward_ids: Forward ids discovered from `get_msg` or nested nodes.

        Returns:
            Flattened sender/text items for modal display.
        """
        items: list[dict[str, str]] = []
        pending = [str(item).strip() for item in forward_ids if str(item).strip()]
        seen: set[str] = set()
        fetch_count = 0

        while pending and fetch_count < 32:
            current_id = pending.pop(0)
            if current_id in seen:
                continue
            seen.add(current_id)
            fetch_count += 1

            payload = await client.get_forward_msg(current_id)
            if not isinstance(payload, dict):
                continue
            current_items, nested_ids = (
                self._extract_forward_details_from_forward_payload(payload)
            )
            if current_items:
                items.extend(current_items)
            for nested_id in nested_ids:
                if nested_id not in seen:
                    pending.append(nested_id)

        return self._dedupe_quote_items(items)

    def _extract_forward_details_from_message_payload(
        self,
        payload: dict[str, Any],
    ) -> tuple[list[dict[str, str]], list[str]]:
        data = payload["data"] if isinstance(payload.get("data"), dict) else payload
        segments = data.get("message") or data.get("messages") or []
        if not isinstance(segments, list):
            return [], []
        return self._extract_forward_details_from_segments(segments)

    def _extract_forward_details_from_forward_payload(
        self,
        payload: dict[str, Any],
    ) -> tuple[list[dict[str, str]], list[str]]:
        data = payload["data"] if isinstance(payload.get("data"), dict) else payload
        nodes = (
            data.get("messages")
            or data.get("message")
            or data.get("nodes")
            or data.get("nodeList")
            or []
        )
        return self._extract_forward_items_from_nodes(nodes)

    def _extract_forward_details_from_segments(
        self,
        segments: list[Any],
    ) -> tuple[list[dict[str, str]], list[str]]:
        items: list[dict[str, str]] = []
        forward_ids: list[str] = []

        for segment in segments:
            if not isinstance(segment, dict):
                continue
            seg_type = str(segment.get("type", "")).strip().lower()
            seg_data = (
                segment.get("data", {}) if isinstance(segment.get("data"), dict) else {}
            )
            if seg_type in {"forward", "forward_msg"}:
                forward_id = seg_data.get("id") or seg_data.get("message_id")
                if forward_id is not None and str(forward_id).strip():
                    forward_ids.append(str(forward_id).strip())
                nested_items, nested_ids = self._extract_forward_items_from_nodes(
                    seg_data.get("content")
                )
                items.extend(nested_items)
                forward_ids.extend(nested_ids)
            elif seg_type == "nodes":
                nested_items, nested_ids = self._extract_forward_items_from_nodes(
                    seg_data.get("content")
                )
                items.extend(nested_items)
                forward_ids.extend(nested_ids)

        return self._dedupe_quote_items(items), self._dedupe_forward_ids(forward_ids)

    def _extract_forward_items_from_component_chain(
        self,
        chain: list[Any] | None,
    ) -> list[dict[str, str]]:
        items: list[dict[str, str]] = []
        if not isinstance(chain, list):
            return items

        for segment in chain:
            content = getattr(segment, "content", None)
            nodes = getattr(segment, "nodes", None)
            if content is not None and getattr(segment, "name", None) is not None:
                node_text = self._extract_text_from_component_chain(content)
                if node_text:
                    items.append(
                        {
                            "sender_id": str(
                                getattr(segment, "uin", None) or ""
                            ).strip(),
                            "sender_name": str(
                                getattr(segment, "name", None)
                                or getattr(segment, "uin", None)
                                or "Unknown User"
                            ),
                            "text": node_text,
                        }
                    )
            elif isinstance(nodes, list):
                for node in nodes:
                    node_content = getattr(node, "content", None)
                    node_text = self._extract_text_from_component_chain(node_content)
                    if node_text:
                        items.append(
                            {
                                "sender_id": str(
                                    getattr(node, "uin", None) or ""
                                ).strip(),
                                "sender_name": str(
                                    getattr(node, "name", None)
                                    or getattr(node, "uin", None)
                                    or "Unknown User"
                                ),
                                "text": node_text,
                            }
                        )

        return self._dedupe_quote_items(items)

    def _extract_forward_items_from_nodes(
        self,
        nodes: Any,
    ) -> tuple[list[dict[str, str]], list[str]]:
        items: list[dict[str, str]] = []
        forward_ids: list[str] = []
        if not isinstance(nodes, list):
            return items, forward_ids

        for node in nodes:
            if not isinstance(node, dict):
                continue
            sender = node["sender"] if isinstance(node.get("sender"), dict) else {}
            sender_id = str(sender.get("user_id") or "").strip()
            sender_name = str(
                sender.get("nickname")
                or sender.get("card")
                or sender.get("user_id")
                or "Unknown User"
            )
            raw_content = node.get("message") or node.get("content") or []
            segments: list[Any] = []
            if isinstance(raw_content, list):
                segments = raw_content
            elif isinstance(raw_content, str):
                raw_text = raw_content.strip()
                if raw_text:
                    try:
                        parsed = json.loads(raw_text)
                    except Exception:
                        parsed = None
                    if isinstance(parsed, list):
                        segments = parsed
                    else:
                        segments = [{"type": "text", "data": {"text": raw_text}}]

            node_text = self._extract_text_from_onebot_segments(segments)
            if node_text:
                items.append(
                    {
                        "sender_id": sender_id,
                        "sender_name": sender_name,
                        "text": node_text,
                    }
                )
            nested_items, nested_ids = self._extract_forward_details_from_segments(
                segments
            )
            items.extend(nested_items)
            forward_ids.extend(nested_ids)

        return self._dedupe_quote_items(items), self._dedupe_forward_ids(forward_ids)

    def _extract_text_from_component_chain(self, chain: list[Any] | None) -> str:
        parts: list[str] = []
        if not isinstance(chain, list):
            return ""

        for segment in chain:
            if isinstance(segment, Plain):
                if segment.text:
                    parts.append(segment.text)
            elif isinstance(segment, At):
                target = segment.name or segment.qq
                if target:
                    parts.append(f"@{target}")
            elif isinstance(segment, Image):
                parts.append("[Image]")
            elif isinstance(segment, Record):
                parts.append("[Audio]")
            elif isinstance(segment, Video):
                parts.append("[Video]")
            elif isinstance(segment, File):
                parts.append(f"[File:{segment.name or 'file'}]")
            elif isinstance(segment, Reply):
                nested = self._extract_text_from_component_chain(
                    getattr(segment, "chain", None)
                )
                if nested:
                    parts.append(nested)

        return "".join(parts).strip()

    def _extract_text_from_onebot_segments(self, segments: list[Any]) -> str:
        parts: list[str] = []

        for segment in segments:
            if not isinstance(segment, dict):
                continue
            seg_type = str(segment.get("type", "")).strip().lower()
            seg_data = (
                segment.get("data", {}) if isinstance(segment.get("data"), dict) else {}
            )
            if seg_type in {"text", "plain"}:
                value = seg_data.get("text")
                if isinstance(value, str) and value:
                    parts.append(value)
            elif seg_type == "at":
                target = seg_data.get("name") or seg_data.get("qq")
                if target:
                    parts.append(f"@{target}")
            elif seg_type == "image":
                parts.append("[Image]")
            elif seg_type == "record":
                parts.append("[Audio]")
            elif seg_type == "video":
                parts.append("[Video]")
            elif seg_type == "file":
                file_name = (
                    seg_data.get("name")
                    or seg_data.get("file_name")
                    or seg_data.get("file")
                    or "file"
                )
                parts.append(f"[File:{file_name}]")
            elif seg_type in {"forward", "forward_msg", "nodes"}:
                parts.append("[Forward Message]")
            elif seg_type == "json":
                json_preview = self._extract_multimsg_preview(seg_data.get("data"))
                if json_preview:
                    parts.append(json_preview)

        return "".join(parts).strip()

    def _extract_multimsg_preview(self, raw_json: Any) -> str:
        if not isinstance(raw_json, str) or not raw_json.strip():
            return ""
        try:
            parsed = json.loads(raw_json.replace("&#44;", ","))
        except Exception:
            return ""

        if not isinstance(parsed, dict) or parsed.get("app") != "com.tencent.multimsg":
            return ""
        meta = parsed["meta"] if isinstance(parsed.get("meta"), dict) else {}
        detail = meta["detail"] if isinstance(meta.get("detail"), dict) else {}
        news_items = detail.get("news")
        if not isinstance(news_items, list):
            return ""

        previews: list[str] = []
        for item in news_items:
            if not isinstance(item, dict):
                continue
            value = str(item.get("text") or "").replace("[聊天记录]", "").strip()
            if value:
                previews.append(value)
        return "\n".join(previews).strip()

    @staticmethod
    def _dedupe_forward_ids(forward_ids: list[str]) -> list[str]:
        seen: set[str] = set()
        unique: list[str] = []
        for forward_id in forward_ids:
            cleaned = str(forward_id).strip()
            if not cleaned or cleaned in seen:
                continue
            seen.add(cleaned)
            unique.append(cleaned)
        return unique

    @staticmethod
    def _dedupe_quote_items(items: list[dict[str, str]]) -> list[dict[str, str]]:
        seen: set[tuple[str, str, str]] = set()
        unique: list[dict[str, str]] = []
        for item in items:
            sender_id = str(item.get("sender_id") or "").strip()
            sender_name = str(item.get("sender_name") or "").strip()
            text_value = str(item.get("text") or "").strip()
            if not text_value:
                continue
            identity = (sender_id, sender_name, text_value)
            if identity in seen:
                continue
            seen.add(identity)
            unique.append(
                {
                    "sender_id": sender_id,
                    "sender_name": sender_name,
                    "text": text_value,
                }
            )
        return unique

    def _build_quote_preview(self, quote: dict[str, Any]) -> str:
        items = quote.get("items", [])
        item_count = len(items) if isinstance(items, list) else 0
        summary = str(quote.get("text") or "").strip()
        sender_name = str(quote.get("sender_name") or "").strip()

        if quote.get("is_forward"):
            base = f"Forwarded {item_count} message{'s' if item_count != 1 else ''}"
            preview_text = self._build_forward_preview_text(items)
            return f"{base}: {preview_text}" if preview_text else base
        if sender_name and summary:
            return f"{sender_name}: {summary}"
        return summary or sender_name or "Reply"

    def _build_forward_payload(
        self,
        items: list[dict[str, str]],
        *,
        forward_id: str = "",
    ) -> dict[str, Any]:
        """Build a normalized forward payload for message rendering.

        Args:
            items: Forwarded node previews.
            forward_id: Optional OneBot forward id.

        Returns:
            Serializable forward payload for the dashboard.
        """
        normalized_items = self._dedupe_quote_items(items)
        item_count = len(normalized_items)
        preview_text = self._build_forward_preview_text(normalized_items)
        preview = (
            f"Forwarded {item_count} message{'s' if item_count != 1 else ''}: {preview_text}"
            if preview_text
            else f"Forwarded {item_count} message{'s' if item_count != 1 else ''}"
        )
        return {
            "message_id": forward_id,
            "items": normalized_items,
            "item_count": item_count,
            "preview": preview,
            "text": preview_text,
            "is_forward": True,
        }

    @staticmethod
    def _build_forward_preview_text(items: Any) -> str:
        if not isinstance(items, list) or not items:
            return ""
        first = items[0] if isinstance(items[0], dict) else {}
        sender_name = str(first.get("sender_name") or "").strip()
        text_value = str(first.get("text") or "").strip()
        if sender_name and text_value:
            return f"{sender_name}: {text_value}"
        return text_value or sender_name

    @staticmethod
    def _build_session_id(chat_type: str, target_id: str) -> str:
        return f"{chat_type}:{target_id}"

    @staticmethod
    def _parse_session_id(session_id: str) -> tuple[str, str]:
        chat_type, _, target_id = session_id.partition(":")
        if chat_type not in {"private", "group"} or not target_id:
            raise ValueError("invalid session_id")
        return chat_type, target_id

    def _resolve_session_avatar(self, session_id: str) -> str:
        chat_type, target_id = self._parse_session_id(session_id)
        if chat_type == "group":
            return self._build_group_avatar_url(target_id)
        return self._build_avatar_url(target_id)

    @staticmethod
    def _build_avatar_url(user_id: str) -> str:
        user_id = str(user_id).strip()
        if not user_id:
            return ""
        return f"https://q1.qlogo.cn/g?b=qq&nk={user_id}&s=100"

    @staticmethod
    def _build_group_avatar_url(group_id: str) -> str:
        group_id = str(group_id).strip()
        if not group_id:
            return ""
        return f"https://p.qlogo.cn/gh/{group_id}/{group_id}/100"

    @staticmethod
    def _resolve_media_url(value: str) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        if text.startswith("//"):
            return f"https:{text}"
        if text.startswith("http://"):
            return f"https://{text.removeprefix('http://')}"
        if text.startswith("https://"):
            return text
        return ""

    def _build_image_attachment_from_key(self, key: str) -> MessageAttachment:
        cached = self.media_cache.resolve_cached_file(key)
        return MessageAttachment(
            kind="image",
            name=cached.name,
            media_key=cached.key,
            content_type=cached.content_type,
            size=cached.size,
        )

    def _build_image_attachment(
        self,
        media_ref: str,
        fallback_name: str,
    ) -> MessageAttachment:
        media_url = self._resolve_media_url(media_ref)
        if media_url:
            return MessageAttachment(
                kind="image",
                name=fallback_name,
                url=media_url,
            )
        if media_ref:
            return self._build_image_attachment_from_key(media_ref)
        return MessageAttachment(
            kind="image",
            name=fallback_name,
        )

    def _build_attachment_from_cached_media(self, cached) -> MessageAttachment:
        return MessageAttachment(
            kind=self._attachment_kind(cached.name, cached.content_type),
            name=cached.name,
            media_key=cached.key,
            content_type=cached.content_type,
            size=cached.size,
        )

    def _build_outgoing_component(self, cached):
        kind = self._attachment_kind(cached.name, cached.content_type)
        path = str(cached.path)
        if kind == "image":
            return Image.fromFileSystem(path)
        if kind == "audio":
            return Record.fromFileSystem(path)
        if kind == "video":
            return Video.fromFileSystem(path)
        return File(name=cached.name, file=path)

    def _build_media_attachment(
        self,
        kind: str,
        media_ref: str,
        fallback_name: str,
    ) -> MessageAttachment:
        media_url = self._resolve_media_url(media_ref)
        if media_url:
            return MessageAttachment(
                kind=kind,
                name=fallback_name,
                url=media_url,
                content_type=mimetypes.guess_type(fallback_name)[0] or "",
            )
        if media_ref:
            cached = self.media_cache.resolve_cached_file(media_ref)
            return MessageAttachment(
                kind=kind,
                name=cached.name,
                media_key=cached.key,
                content_type=cached.content_type,
                size=cached.size,
            )
        return MessageAttachment(kind=kind, name=fallback_name)

    @staticmethod
    def _attachment_kind(name: str, content_type: str = "") -> str:
        suffix = Path(str(name or "")).suffix.lower()
        content_type = str(content_type or "").lower()
        if content_type.startswith("image/") or suffix in IMAGE_SUFFIXES:
            return "image"
        if content_type.startswith("video/") or suffix in VIDEO_SUFFIXES:
            return "video"
        if content_type.startswith("audio/") or suffix in AUDIO_SUFFIXES:
            return "audio"
        return "file"
