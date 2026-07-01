from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

from ..infra.models import MessageRecord
from ..infra.store import QQWebuiStore


class SseService:
    def __init__(self, store: QQWebuiStore) -> None:
        self.store = store
        self._subscribers: dict[str, asyncio.Queue[dict[str, Any]]] = {}

    @staticmethod
    def _format_event(event_name: str, data: dict[str, Any]) -> str:
        return f"event: {event_name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    def clear(self) -> None:
        self._subscribers.clear()

    async def stream_events(self) -> AsyncIterator[str]:
        subscriber_id = uuid.uuid4().hex
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._subscribers[subscriber_id] = queue
        try:
            yield self._format_event(
                "ready",
                {
                    "last_active_session_id": self.store.last_active_session_id,
                    "started_at": self.store.started_at,
                },
            )
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                yield self._format_event(
                    str(payload.get("event") or "message"),
                    payload.get("data") or {},
                )
        finally:
            self._subscribers.pop(subscriber_id, None)
            if not self._subscribers:
                self.store.view_session_id = ""
                self.store.view_at_bottom = False

    def broadcast(self, event_name: str, data: dict[str, Any]) -> None:
        payload = {"event": event_name, "data": data}
        for queue in list(self._subscribers.values()):
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                continue

    def publish_message(
        self,
        *,
        message: MessageRecord,
        session: dict[str, Any],
        last_active_session_id: str,
    ) -> None:
        self.broadcast(
            "message",
            {
                "message": message.to_dict(),
                "session": session,
                "last_active_session_id": last_active_session_id,
            },
        )

    def publish_session(
        self,
        *,
        session: dict[str, Any],
        last_active_session_id: str,
    ) -> None:
        self.broadcast(
            "session",
            {
                "session": session,
                "last_active_session_id": last_active_session_id,
            },
        )
