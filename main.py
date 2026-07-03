from __future__ import annotations

import asyncio

from aiocqhttp import CQHttp

from astrbot.api import logger
from astrbot.api.event import filter
from astrbot.api.star import Context, Star
from astrbot.core.config.astrbot_config import AstrBotConfig
from astrbot.core.platform.sources.aiocqhttp.aiocqhttp_platform_adapter import (
    AiocqhttpAdapter,
)

from .backend.infra.store import QQWebuiStore
from .backend.page_controller import PageController
from .backend.service.action_service import ActionService
from .backend.service.contact_service import ContactService
from .backend.service.file_service import FileService
from .backend.service.inbound_service import InboundService
from .backend.service.outbound_service import OutboundService
from .backend.service.self_capture_service import SelfCaptureService
from .backend.service.session_service import SessionService
from .backend.service.sse_service import SseService
from .backend.service.status_service import StatusService
from .config import PluginConfig


class QQWebui(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.context = context
        self.cfg = PluginConfig(config)
        self.store: QQWebuiStore | None = None
        self.sse: SseService | None = None
        self.self_capture: SelfCaptureService | None = None
        self.inbound: InboundService | None = None
        self.started = False
        self._start_lock = asyncio.Lock()

    @filter.on_platform_loaded()
    async def on_platform_loaded(self):
        asyncio.create_task(self.start_qqwebui())

    async def initialize(self):
        asyncio.create_task(self.start_qqwebui())

    async def terminate(self):
        if self.store:
            self.store.persist()
        if self.sse:
            self.sse.clear()
        if self.self_capture:
            await self.self_capture.terminate()
        if self.inbound:
            await self.inbound.terminate()

    async def start_qqwebui(self):
        if self.started:
            return

        async with self._start_lock:
            if self.started:
                return

            platform = next(
                (
                    inst
                    for inst in self.context.platform_manager.platform_insts
                    if isinstance(inst, AiocqhttpAdapter)
                ),
                None,
            )
            if platform is None:
                logger.warning("[qqwebui] aiocqhttp platform not available")
                return

            bot = platform.get_client()
            if not isinstance(bot, CQHttp):
                logger.warning("[qqwebui] aiocqhttp client not available")
                return

            await self.qqwebui_run(bot)

    async def qqwebui_run(self, bot: CQHttp):
        self.store = QQWebuiStore(self.cfg)
        self.store.load()
        files = FileService(self.cfg, self.store)
        files.ensure_media_tokens_registered()
        self.store.persist()

        self.sse = SseService(self.store)

        status = StatusService(self.cfg, bot, self.store)
        contacts = ContactService(self.cfg, bot, self.store)
        await contacts.refresh_self()
        sessions = SessionService(self.store, self.sse, files)

        self.inbound = InboundService(self.cfg, bot, self.store, sessions)
        await self.inbound.initialize()
        self.self_capture = SelfCaptureService(
            self.cfg, bot, self.store, sessions, files
        )
        await self.self_capture.initialize()

        outbound = OutboundService(bot, files)
        actions = ActionService(bot)

        page_controller = PageController(
            self.cfg,
            self.context,
            self.sse,
            status,
            contacts,
            sessions,
            files,
            outbound,
            actions,
        )
        page_controller.register_routes()

        self.started = True
        logger.info("[qqwebui] started")
