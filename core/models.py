from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(slots=True)
class MessageAttachment:
    kind: str
    name: str = ""
    url: str = ""
    media_key: str = ""
    content_type: str = ""
    size: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> MessageAttachment:
        return cls(
            kind=str(data.get("kind", "")),
            name=str(data.get("name", "")),
            url=str(data.get("url", "")),
            media_key=str(data.get("media_key", "")),
            content_type=str(data.get("content_type", "")),
            size=int(data["size"]) if data.get("size") is not None else None,
        )


@dataclass(slots=True)
class ContactRecord:
    id: str
    type: str
    title: str
    subtitle: str = ""
    avatar: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ContactRecord:
        return cls(
            id=str(data.get("id", "")),
            type=str(data.get("type", "")),
            title=str(data.get("title", "")),
            subtitle=str(data.get("subtitle", "")),
            avatar=str(data.get("avatar", "")),
            extra=dict(data.get("extra", {}) or {}),
        )


@dataclass(slots=True)
class MessageRecord:
    message_id: str
    session_id: str
    chat_type: str
    sender_id: str
    sender_name: str
    is_self: bool
    timestamp: int
    plain_text: str
    segments: list[dict[str, Any]] = field(default_factory=list)
    attachments: list[MessageAttachment] = field(default_factory=list)
    quote: dict[str, Any] | None = None
    forward: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "message_id": self.message_id,
            "session_id": self.session_id,
            "chat_type": self.chat_type,
            "sender_id": self.sender_id,
            "sender_name": self.sender_name,
            "is_self": self.is_self,
            "timestamp": self.timestamp,
            "plain_text": self.plain_text,
            "segments": self.segments,
            "attachments": [attachment.to_dict() for attachment in self.attachments],
            "quote": self.quote,
            "forward": self.forward,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> MessageRecord:
        raw_attachments = data.get("attachments", [])
        return cls(
            message_id=str(data.get("message_id", "")),
            session_id=str(data.get("session_id", "")),
            chat_type=str(data.get("chat_type", "")),
            sender_id=str(data.get("sender_id", "")),
            sender_name=str(data.get("sender_name", "")),
            is_self=bool(data.get("is_self", False)),
            timestamp=int(data.get("timestamp", 0) or 0),
            plain_text=str(data.get("plain_text", "")),
            segments=[
                dict(item)
                for item in data.get("segments", [])
                if isinstance(item, dict)
            ],
            attachments=[
                MessageAttachment.from_dict(item)
                for item in raw_attachments
                if isinstance(item, dict)
            ],
            quote=dict(data.get("quote", {}) or {}) if data.get("quote") else None,
            forward=(
                dict(data.get("forward", {}) or {}) if data.get("forward") else None
            ),
        )


@dataclass(slots=True)
class SessionSummary:
    session_id: str
    chat_type: str
    target_id: str
    title: str
    avatar: str = ""
    unread_count: int = 0
    last_message_id: str = ""
    last_message_preview: str = ""
    last_timestamp: int = 0
    member_count: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SessionSummary:
        return cls(
            session_id=str(data.get("session_id", "")),
            chat_type=str(data.get("chat_type", "")),
            target_id=str(data.get("target_id", "")),
            title=str(data.get("title", "")),
            avatar=str(data.get("avatar", "")),
            unread_count=int(data.get("unread_count", 0) or 0),
            last_message_id=str(data.get("last_message_id", "")),
            last_message_preview=str(data.get("last_message_preview", "")),
            last_timestamp=int(data.get("last_timestamp", 0) or 0),
            member_count=(
                int(data["member_count"])
                if data.get("member_count") is not None
                else None
            ),
        )
