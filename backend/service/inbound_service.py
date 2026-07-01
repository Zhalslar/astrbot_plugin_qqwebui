from __future__ import annotations

from aiocqhttp import CQHttp, Event

from ...config import PluginConfig
from ..infra.event import MessageEvent
from ..infra.store import QQWebuiStore
from .session_service import SessionService


class InboundService:
    def __init__(
        self,
        cfg: PluginConfig,
        bot: CQHttp,
        store: QQWebuiStore,
        sessions: SessionService,
    ) -> None:
        self.cfg = cfg
        self.bot = bot
        self.store = store
        self.sessions = sessions
        self._handlers = {
            "meta_event.lifecycle.connect": self._handle_connect,
            "message.private": self._handle_message,
            "message.group": self._handle_message,
        }

    async def initialize(self) -> None:
        for event_name, handler in self._handlers.items():
            self.bot.subscribe(event_name, handler)

    async def terminate(self) -> None:
        for event_name, handler in self._handlers.items():
            self.bot.unsubscribe(event_name, handler)

    async def _handle_connect(self, event: Event) -> None:
        pass

    async def _handle_message(self, event: Event) -> None:
        if evt := MessageEvent.from_event(event):
            self.sessions.cache_message(evt)
