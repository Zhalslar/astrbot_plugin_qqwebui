from __future__ import annotations

from typing import Any

from aiocqhttp import CQHttp

from astrbot.api import logger

from ...config import PluginConfig
from ..infra.store import QQWebuiStore


class StatusService:
    def __init__(
        self,
        cfg: PluginConfig,
        bot: CQHttp,
        store: QQWebuiStore,
    ):
        self.cfg = cfg
        self.store = store
        self.bot = bot

    async def get_status(self) -> dict[str, Any]:
        online = False
        good = False
        try:
            status = await self.bot.get_status()
            online = status.get("online", False)
            good = status.get("good", False)
        except Exception as exc:
            logger.debug("[qqwebui] get_status failed: %s", exc)
        return {
            "adapter": {
                "name": "aiocqhttp",
                "bound": True,
                "online": online,
                "good": good,
            },
            "login": {
                "user_id": self.store.contacts.login.user_id,
                "nickname": self.store.contacts.login.nickname,
            },
            "cache": {
                "sessions": len(self.store.sessions.list_sorted(limit=10000)),
                "friends": sum(
                    1 for item in self.store.contacts.users.values() if item.is_friend
                ),
                "groups": len(self.store.contacts.groups),
                "started_at": self.store.started_at,
            },
            "ui": {
                "last_active_session_id": self.store.last_active_session_id,
            },
            "limits": {
                "session_message_limit": self.cfg.session_message_limit,
            },
        }
