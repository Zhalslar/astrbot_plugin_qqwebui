from __future__ import annotations

from time import time

from aiocqhttp import CQHttp

from ..infra.models import GroupMemberProfile
from ..infra.store import QQWebuiStore


class ActionService:
    RECALL_WINDOW_SECONDS = 120
    ROLE_RANK = {"member": 1, "admin": 2, "owner": 3}

    def __init__(self, bot: CQHttp, store: QQWebuiStore) -> None:
        self.bot = bot
        self.store = store

    async def _get_self_group_role(self, group_id: str) -> str:
        """Resolve the login user's current role in a group.

        Args:
            group_id: Validated numeric QQ group ID.

        Returns:
            Lowercase group role such as ``owner``, ``admin``, or ``member``.

        Raises:
            ValueError: The login user is unknown or role lookup fails.
        """

        self_id = str(self.store.contacts.login.user_id or "").strip()
        if not self_id:
            raise ValueError("login user is unknown")

        member = self.store.contacts.members.get(group_id, {}).get(self_id)
        try:
            member_info = await self.bot.get_group_member_info(
                group_id=int(group_id),
                user_id=int(self_id),
                no_cache=True,
            )
            member = GroupMemberProfile.from_dict(dict(member_info))
            member.group_id = group_id
            self.store.contacts.upsert_group_member(group_id, member)
        except Exception:
            if member is None or not str(member.role).strip():
                raise
        return str(member.role or "").strip().lower()

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

    async def set_group_name(self, group_id: str, group_name: str) -> dict[str, str]:
        """Set a QQ group name after manager permission checks.

        Args:
            group_id: Target QQ group ID.
            group_name: New group name.

        Returns:
            Updated group metadata.

        Raises:
            ValueError: The group ID, group name, or current role is invalid.
        """

        clean_group_id = str(group_id).strip()
        clean_group_name = str(group_name).strip()
        if not clean_group_id:
            raise ValueError("group_id is required")
        if not clean_group_id.isdigit():
            raise ValueError("group_id must be numeric")
        if not clean_group_name:
            raise ValueError("group_name is required")

        self_role = await self._get_self_group_role(clean_group_id)
        if self.ROLE_RANK.get(self_role, 0) < self.ROLE_RANK["admin"]:
            raise ValueError("insufficient permission to edit group name")

        try:
            await self.bot.call_action(
                "set_group_card",
                group_id=int(clean_group_id),
                group_name=clean_group_name,
            )
        except Exception:
            await self.bot.call_action(
                "set_group_name",
                group_id=int(clean_group_id),
                group_name=clean_group_name,
            )

        group = self.store.contacts.groups.get(clean_group_id)
        if group is not None:
            group.group_name = clean_group_name
        session = self.store.sessions.get(f"group:{clean_group_id}")
        if session is not None:
            session.title = clean_group_name
        self.store.persist()
        return {"group_id": clean_group_id, "group_name": clean_group_name}

    async def set_group_card(
        self,
        group_id: str,
        user_id: str,
        card: str,
    ) -> dict[str, str]:
        """Set a group member card after manager permission checks.

        Args:
            group_id: Target QQ group ID.
            user_id: Target QQ user ID.
            card: New member card. Empty string clears the card.

        Returns:
            Updated member card metadata.

        Raises:
            ValueError: The identifiers or current role are invalid.
        """

        clean_group_id = str(group_id).strip()
        clean_user_id = str(user_id).strip()
        clean_card = str(card).strip()
        if not clean_group_id:
            raise ValueError("group_id is required")
        if not clean_group_id.isdigit():
            raise ValueError("group_id must be numeric")
        if not clean_user_id:
            raise ValueError("user_id is required")
        if not clean_user_id.isdigit():
            raise ValueError("user_id must be numeric")

        self_role = await self._get_self_group_role(clean_group_id)
        if self.ROLE_RANK.get(self_role, 0) < self.ROLE_RANK["admin"]:
            raise ValueError("insufficient permission to edit group cards")

        await self.bot.call_action(
            "set_group_card",
            group_id=int(clean_group_id),
            user_id=int(clean_user_id),
            card=clean_card,
        )
        member = self.store.contacts.members.get(clean_group_id, {}).get(clean_user_id)
        if member is not None:
            member.card = clean_card
        self.store.persist()
        return {
            "group_id": clean_group_id,
            "user_id": clean_user_id,
            "card": clean_card,
        }

    async def set_group_special_title(
        self,
        group_id: str,
        user_id: str,
        special_title: str,
    ) -> dict[str, str]:
        """Set a group member special title after owner permission checks.

        Args:
            group_id: Target QQ group ID.
            user_id: Target QQ user ID.
            special_title: New title. Empty string clears the title.

        Returns:
            Updated special title metadata.

        Raises:
            ValueError: The identifiers or current role are invalid.
        """

        clean_group_id = str(group_id).strip()
        clean_user_id = str(user_id).strip()
        clean_special_title = str(special_title).strip()
        if not clean_group_id:
            raise ValueError("group_id is required")
        if not clean_group_id.isdigit():
            raise ValueError("group_id must be numeric")
        if not clean_user_id:
            raise ValueError("user_id is required")
        if not clean_user_id.isdigit():
            raise ValueError("user_id must be numeric")

        self_role = await self._get_self_group_role(clean_group_id)
        if self_role != "owner":
            raise ValueError("insufficient permission to edit special titles")

        await self.bot.call_action(
            "set_group_special_title",
            group_id=int(clean_group_id),
            user_id=int(clean_user_id),
            special_title=clean_special_title,
        )
        member = self.store.contacts.members.get(clean_group_id, {}).get(clean_user_id)
        if member is not None:
            member.title = clean_special_title
        self.store.persist()
        return {
            "group_id": clean_group_id,
            "user_id": clean_user_id,
            "special_title": clean_special_title,
        }

    async def recall_message(self, session_id: str, message_id: str) -> dict[str, str]:
        """Recall a cached OneBot message after permission checks.

        Args:
            session_id: Chat route in `private:123` or `group:456` format.
            message_id: OneBot message id to recall.

        Returns:
            Recalled message metadata.

        Raises:
            ValueError: The message is missing, expired, or not recallable.
        """

        clean_session_id = str(session_id).strip()
        clean_message_id = str(message_id).strip()
        if not clean_session_id:
            raise ValueError("session_id is required")
        if not clean_message_id:
            raise ValueError("message_id is required")
        if not clean_message_id.isdigit():
            raise ValueError("message_id must be numeric")

        message = self.store.messages.get(clean_session_id, clean_message_id)
        if message is None:
            raise ValueError("message not found")
        if message.post_type != "message":
            raise ValueError("only messages can be recalled")
        if message.recalled:
            raise ValueError("message already recalled")

        self_id = str(self.store.contacts.login.user_id or "").strip()
        if not self_id:
            raise ValueError("login user is unknown")

        message_type, _, target_id = clean_session_id.partition(":")
        if message_type not in {"private", "group"} or not target_id:
            raise ValueError("invalid session_id")
        group_id = ""
        if message_type == "group":
            group_id = message.group_id or target_id
        members = self.store.contacts.members.get(group_id, {}) if group_id else {}
        self_member = members.get(self_id)
        self_role = str(
            (self_member.role if self_member else "") or message.sender.role
        ).strip().lower()
        is_own_message = message.is_self or message.user_id == self_id
        if is_own_message:
            is_group_manager = (
                message_type == "group" and self.ROLE_RANK.get(self_role, 0) >= 2
            )
            if (
                not is_group_manager
                and int(time()) - int(message.time or 0) > self.RECALL_WINDOW_SECONDS
            ):
                raise ValueError("message recall window expired")
        elif message_type == "private":
            raise ValueError("cannot recall peer private messages")
        elif message_type == "group":
            target_member = members.get(message.user_id)
            target_role = str(
                message.sender.role or (target_member.role if target_member else "")
            ).strip().lower()
            if (
                self.ROLE_RANK.get(self_role, 0) <= 0
                or self.ROLE_RANK.get(target_role, 0) <= 0
                or self.ROLE_RANK[self_role] <= self.ROLE_RANK[target_role]
            ):
                raise ValueError("insufficient permission to recall this message")
        await self.bot.delete_msg(message_id=int(clean_message_id))
        self.store.messages.mark_recalled(
            clean_session_id,
            clean_message_id,
            operator_id=self_id,
        )
        self.store.persist()
        return {
            "session_id": clean_session_id,
            "message_id": clean_message_id,
            "recall_state": "marked",
        }
