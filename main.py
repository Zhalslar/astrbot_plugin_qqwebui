from __future__ import annotations

from astrbot.api.event import filter
from astrbot.api.star import Context, Star
from astrbot.core.config.astrbot_config import AstrBotConfig
from astrbot.core.platform.astr_message_event import AstrMessageEvent
from astrbot.core.platform.sources.aiocqhttp.aiocqhttp_message_event import (
    AiocqhttpMessageEvent,
)
from astrbot.core.star.filter.event_message_type import EventMessageType

from .config import PluginConfig
from .core.service import QQWebuiService
from .page_controller import QQWebuiPageController


class QQWebui(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.context = context
        self.cfg = PluginConfig(config)
        self.service = QQWebuiService(context, self.cfg)
        self.page_controller = QQWebuiPageController(context, self.service)
        self.page_controller.register_routes()

    async def initialize(self):
        await self.service.initialize()

    async def terminate(self):
        await self.service.terminate()

    @filter.platform_adapter_type(filter.PlatformAdapterType.AIOCQHTTP)
    @filter.event_message_type(EventMessageType.ALL)
    async def on_message(self, event: AiocqhttpMessageEvent):
        """Mirror recent QQ traffic into the local WebUI caches."""
        await self.service.ingest_event(event)

    @filter.on_decorating_result(priority=10)
    async def on_decorating_result(self, event: AstrMessageEvent):
        """Mirror bot outgoing messages into the same session for WebUI preview."""
        if event.get_platform_name() != "aiocqhttp":
            return
        await self.service.capture_outgoing_result(event)
