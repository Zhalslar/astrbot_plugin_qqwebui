from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from aiocqhttp import Event

from .models import EventRecord, Sender


@dataclass(slots=True)
class OnebotEvent:
    self_id: str
    user_id: str
    time: int
    message_id: str
    post_type: str
    message_type: str
    sub_type: str
    raw_message: str
    message: list[dict[str, Any]] = field(default_factory=list)
    sender: Sender = field(default_factory=lambda: Sender(user_id=""))
    group_id: str = ""
    group_name: str = ""
    notice_type: str = ""
    notice: dict[str, Any] = field(default_factory=dict)
    _target_id: str = ""

    @classmethod
    def from_event(
        cls,
        event: Event | dict[str, Any],
    ) -> OnebotEvent | None:
        """Build an event from a OneBot payload.

        Args:
            event: Original aiocqhttp event or payload mapping.

        Returns:
            Parsed event when the payload is a supported message or notice event.
        """

        payload = dict(event)
        post_type = str(payload.get("post_type", "")).strip()
        if post_type not in {"message", "notice"}:
            return None

        if post_type == "message":
            if str(payload.get("message_format", "")).strip().lower() != "array":
                return None

            raw_segments = payload.get("message")
            if not isinstance(raw_segments, list):
                return None

            sender = payload.get("sender", {})
            return cls(
                self_id=str(payload.get("self_id", "")),
                user_id=str(payload.get("user_id", "")),
                time=int(payload.get("time", 0) or 0),
                message_id=str(payload.get("message_id", "")),
                post_type="message",
                message_type=str(payload.get("message_type", "")),
                sub_type=str(payload.get("sub_type", "")),
                raw_message=str(payload.get("raw_message", "")),
                message=[dict(item) for item in raw_segments if isinstance(item, dict)],
                sender=(
                    Sender.from_dict(sender)
                    if isinstance(sender, dict)
                    else Sender(user_id="")
                ),
                group_id=str(payload.get("group_id", "")),
                group_name=str(payload.get("group_name", "")),
                _target_id=str(payload.get("target_id", "")),
            )

        notice_type = str(payload.get("notice_type", ""))
        sub_type = str(payload.get("sub_type", ""))
        group_id = str(payload.get("group_id", ""))
        user_id = str(payload.get("user_id", ""))
        target_id = str(payload.get("target_id", ""))
        message_type = "group" if group_id else "private"
        source_message_id = str(payload.get("message_id", ""))
        payload_fingerprint = hashlib.sha1(
            json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()[:12]
        message_id_parts = [
            "notice",
            str(payload.get("time", 0) or 0),
            notice_type,
            sub_type,
            group_id,
            user_id,
            target_id,
            str(payload.get("operator_id", "")),
            source_message_id,
            payload_fingerprint,
        ]
        return cls(
            self_id=str(payload.get("self_id", "")),
            user_id=user_id,
            time=int(payload.get("time", 0) or 0),
            message_id=":".join(message_id_parts),
            post_type="notice",
            message_type=message_type,
            sub_type=sub_type,
            raw_message="",
            message=[],
            sender=Sender(user_id=user_id),
            group_id=group_id,
            group_name=str(payload.get("group_name", "")),
            notice_type=notice_type,
            notice=dict(payload),
            _target_id=target_id,
        )

    @property
    def is_group(self) -> bool:
        return self.message_type == "group" and bool(self.group_id)

    @property
    def is_private(self) -> bool:
        return self.message_type == "private"

    @property
    def is_self(self) -> bool:
        return bool(self.self_id and self.user_id and self.self_id == self.user_id)

    @property
    def sender_name(self) -> str:
        return self.sender.card or self.sender.nickname or self.user_id

    @property
    def target_id(self) -> str:
        if self.is_group:
            return self.group_id
        if self.is_private and self.is_self and self._target_id:
            return self._target_id
        return self.user_id

    @property
    def session_id(self) -> str:
        if self.is_group:
            return f"group:{self.target_id}"
        return f"private:{self.target_id}"

    def _build_summary(self) -> str:
        if self.post_type == "notice":
            return f"[Notice:{self.notice_type or self.sub_type or 'notice'}]"

        summary = ""
        for segment in self.message:
            seg_type = str(segment.get("type", ""))
            data: dict = segment.get("data", {})
            match seg_type:
                case "text":
                    summary += data.get("text") or ""
                case "at":
                    summary += f"@{data.get('name', data.get('qq', ''))} "
                case "file":
                    summary += f"[File:{data.get('name', 'file')}]"
                case "music":
                    summary += data.get("summary") or "[Music]"
                case _:
                    summary += data.get("summary") or f"[{seg_type.capitalize()}]"
        return summary

    def to_event_record(self) -> EventRecord:
        return EventRecord(
            self_id=self.self_id,
            user_id=self.user_id,
            time=self.time,
            message_id=self.message_id,
            post_type=self.post_type,
            message_type=self.message_type,
            sub_type=self.sub_type,
            group_id=self.group_id,
            raw_message=self.raw_message,
            message=self.message,
            sender=self.sender,
            session_id=self.session_id,
            is_self=self.is_self,
            summary=self._build_summary(),
            notice_type=self.notice_type,
            notice=self.notice,
        )
