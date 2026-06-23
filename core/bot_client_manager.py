from __future__ import annotations

from typing import Any

from aiocqhttp import CQHttp


class QQWebuiBotClientManager:
    """Track bound aiocqhttp bot clients for current and future multi-bot usage."""

    def __init__(self, context: Any):
        """Initialize the manager with plugin runtime context.

        Args:
            context: AstrBot runtime context used to resolve the aiocqhttp platform.
        """
        self._context = context
        self._bots_by_self_id: dict[str, CQHttp] = {}
        self._active_self_id = ""
        self._fallback_bot: CQHttp | None = None

    def bind(self, bot: CQHttp | None, *, self_id: str = "") -> None:
        """Remember a bot instance and optionally index it by QQ self ID.

        Args:
            bot: Bot client instance from an incoming event or platform lookup.
            self_id: QQ self ID associated with the bot when known.
        """
        if bot is None:
            return
        normalized_self_id = str(self_id).strip()
        if normalized_self_id:
            self._bots_by_self_id[normalized_self_id] = bot
            self._active_self_id = normalized_self_id
        self._fallback_bot = bot

    def get(self, *, self_id: str = "") -> CQHttp | None:
        """Return the best available bot for the requested or active QQ self ID.

        Args:
            self_id: Preferred QQ self ID for the target bot.

        Returns:
            Resolved bot client if available, otherwise `None`.
        """
        normalized_self_id = str(self_id).strip()
        if normalized_self_id and normalized_self_id in self._bots_by_self_id:
            return self._bots_by_self_id[normalized_self_id]
        if self._active_self_id and self._active_self_id in self._bots_by_self_id:
            return self._bots_by_self_id[self._active_self_id]
        if self._fallback_bot is not None:
            return self._fallback_bot
        try:
            platform = self._context.get_platform("aiocqhttp")
        except Exception:
            platform = None
        bot = getattr(platform, "bot", None) if platform is not None else None
        if isinstance(bot, CQHttp):
            self.bind(bot, self_id=normalized_self_id)
            return bot
        return None

    def require(self, *, self_id: str = "") -> CQHttp:
        """Return a bot client or raise when the adapter is unavailable.

        Args:
            self_id: Preferred QQ self ID for the target bot.

        Returns:
            Resolved bot client.

        Raises:
            RuntimeError: The aiocqhttp adapter is not available yet.
        """
        bot = self.get(self_id=self_id)
        if bot is None:
            raise RuntimeError("aiocqhttp adapter is not available yet")
        return bot
