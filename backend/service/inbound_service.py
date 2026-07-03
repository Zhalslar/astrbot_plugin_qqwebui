from __future__ import annotations

from aiocqhttp import CQHttp, Event

from ...config import PluginConfig
from ..infra.event import OnebotEvent
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
            "message.private": self._handle_event,
            "message.group": self._handle_event,
            "notice.group_upload": self._handle_event,
            "notice.group_admin": self._handle_event,
            "notice.group_decrease": self._handle_event,
            "notice.group_increase": self._handle_event,
            "notice.group_ban": self._handle_event,
            "notice.friend_add": self._handle_event,
            "notice.group_recall": self._handle_event,
            "notice.friend_recall": self._handle_event,
            "notice.notify.poke": self._handle_event,
            "notice.notify.lucky_king": self._handle_event,
            "notice.notify.honor": self._handle_event,
        }

    async def initialize(self) -> None:
        for event_name, handler in self._handlers.items():
            self.bot.subscribe(event_name, handler)

    async def terminate(self) -> None:
        for event_name, handler in self._handlers.items():
            self.bot.unsubscribe(event_name, handler)

    async def _handle_connect(self, event: Event) -> None:
        pass

    async def _handle_event(self, event: Event) -> None:
        if evt := OnebotEvent.from_event(event):
            self.sessions.cache_event(evt)
