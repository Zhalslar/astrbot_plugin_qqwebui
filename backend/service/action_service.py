from __future__ import annotations

from aiocqhttp import CQHttp


class ActionService:
    def __init__(self, bot: CQHttp) -> None:
        self.bot = bot

    async def send_poke(self, user_id: str, group_id: str = "") -> dict[str, str]:
        """Send a OneBot poke action.

        Args:
            user_id: Target QQ user ID.
            group_id: Optional QQ group ID when poking inside a group chat.

        Returns:
            Sent poke target metadata.

        Raises:
            ValueError: The target user ID is missing or invalid.
        """

        clean_user_id = str(user_id).strip()
        clean_group_id = str(group_id).strip()
        if not clean_user_id:
            raise ValueError("user_id is required")
        if not clean_user_id.isdigit():
            raise ValueError("user_id must be numeric")
        if clean_group_id and not clean_group_id.isdigit():
            raise ValueError("group_id must be numeric")

        params = {"user_id": int(clean_user_id)}
        if clean_group_id:
            params["group_id"] = int(clean_group_id)
        await self.bot.send_poke(**params)
        return {"user_id": clean_user_id, "group_id": clean_group_id}
