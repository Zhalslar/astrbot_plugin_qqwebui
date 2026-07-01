from __future__ import annotations

import time
from typing import Any

from aiocqhttp import CQHttp

from astrbot.api import logger

from ...config import PluginConfig
from ..infra.models import GroupMemberProfile, GroupProfile, LoginInfo, UserProfile
from ..infra.store import QQWebuiStore


class ContactService:
    def __init__(
        self,
        cfg: PluginConfig,
        bot: CQHttp,
        store: QQWebuiStore,
    ) -> None:
        self.cfg = cfg
        self.bot = bot
        self.store = store
        self.last_refresh_at = 0.0
        self.group_member_refresh_at: dict[str, float] = {}

    async def refresh_contacts(self, *, force: bool = False):
        now = time.time()
        if force or now - self.last_refresh_at > self.cfg.contact_ttl:
            await self.refresh_self()
            await self.refresh_friends()
            await self.refresh_groups()
            self.last_refresh_at = now

    async def refresh_self(self):
        try:
            info = await self.bot.get_login_info()
        except Exception as exc:
            logger.debug("[qqwebui] get_login_info failed: %s", exc)
            return
        self.store.contacts.login = LoginInfo(
            user_id=str(info["user_id"]),
            nickname=str(info["nickname"]),
        )

    async def refresh_friends(self):
        friends = await self.bot.get_friend_list()
        for user in self.store.contacts.users.values():
            user.is_friend = False
        for f in friends:
            friend = UserProfile.from_dict(dict(f))
            self.store.contacts.upsert_user(friend)

    async def refresh_groups(self):
        groups = await self.bot.get_group_list()
        self.store.contacts.groups.clear()
        for g in groups:
            group = GroupProfile.from_dict(dict(g))
            self.store.contacts.upsert_group(group)

    async def refresh_group_members(self, group_id: str, *, force: bool = False):
        now = time.time()
        last_refresh = self.group_member_refresh_at.get(group_id, 0.0)
        if force or now - last_refresh > self.cfg.group_member_ttl:
            member_list = await self.bot.get_group_member_list(group_id=int(group_id))
            self.store.contacts.members[group_id] = {}
            for m in member_list:
                member = GroupMemberProfile.from_dict(dict(m))
                self.store.contacts.upsert_group_member(group_id, member)
            self.group_member_refresh_at[group_id] = now
            self.store.sessions.update_member_count(
                f"group:{group_id}",
                len(self.store.contacts.members[group_id]),
            )

    async def refresh_contact_profile(
        self,
        user_id: str,
        *,
        group_id: str = "",
        force: bool = False,
    ) -> dict[str, Any]:
        """Refresh one cached profile from upstream OneBot APIs.

        Args:
            user_id: Target QQ user id.
            group_id: Group context for member details when available.
            force: Whether to bypass upstream cache.

        Returns:
            Cached raw user and member snapshots after refresh.

        Raises:
            ValueError: The incoming identifiers are invalid.
        """

        clean_user_id = str(user_id).strip()
        clean_group_id = str(group_id).strip()
        if not clean_user_id:
            raise ValueError("user_id is required")
        if not clean_user_id.isdigit():
            raise ValueError("user_id must be numeric")
        if clean_group_id and not clean_group_id.isdigit():
            raise ValueError("group_id must be numeric")

        stranger_info = await self.bot.get_stranger_info(
            user_id=int(clean_user_id),
            no_cache=force,
        )
        user = UserProfile.from_dict(dict(stranger_info))
        current_user = self.store.contacts.users.get(clean_user_id)
        if current_user is not None:
            user.is_friend = current_user.is_friend
            if not user.remark:
                user.remark = current_user.remark
        self.store.contacts.upsert_user(user)

        if clean_group_id:
            member_info = await self.bot.get_group_member_info(
                group_id=int(clean_group_id),
                user_id=int(clean_user_id),
                no_cache=force,
            )
            member = GroupMemberProfile.from_dict(dict(member_info))
            member.group_id = clean_group_id
            self.store.contacts.upsert_group_member(clean_group_id, member)

        return self.get_contact_profile(clean_user_id, group_id=clean_group_id)

    def get_contact_profile(
        self,
        user_id: str,
        *,
        group_id: str = "",
    ) -> dict[str, Any]:
        """Build a cached raw profile payload for the profile modal.

        Args:
            user_id: Target QQ user id.
            group_id: Group context for member details when available.

        Returns:
            Cached raw data for the profile modal.

        Raises:
            ValueError: The incoming identifiers are invalid.
        """

        clean_user_id = str(user_id).strip()
        clean_group_id = str(group_id).strip()
        if not clean_user_id:
            raise ValueError("user_id is required")
        if clean_group_id and not clean_group_id.isdigit():
            raise ValueError("group_id must be numeric")

        user = self.store.contacts.users.get(clean_user_id)
        member = (
            self.store.contacts.members.get(clean_group_id, {}).get(clean_user_id)
            if clean_group_id
            else None
        )
        if user is None and member is None:
            raise ValueError("contact profile not found in cache")

        return {
            "user_id": clean_user_id,
            "group_id": clean_group_id,
            "user": user.to_dict() if user is not None else None,
            "member": member.to_dict() if member is not None else None,
        }

    async def list_group_members(self, group_id: str) -> list[dict[str, Any]]:
        members = list(self.store.contacts.members.get(group_id, {}).values())
        members.sort(
            key=lambda member: (
                {"owner": 0, "admin": 1}.get(member.role, 2),
                0
                if (
                    member.display_name[:1].isascii()
                    and member.display_name[:1].isalpha()
                )
                else (1 if "\u4e00" <= member.display_name[:1] <= "\u9fff" else 2),
                member.display_name.casefold(),
                member.user_id,
            )
        )
        return [member.to_dict() for member in members]

    async def list_contacts(
        self,
        *,
        keyword: str = "",
        scope: str = "all",
    ) -> list[dict[str, Any]]:
        rows = self.store.contacts.list_contacts(scope=scope, keyword=keyword)
        return [row.to_dict() for row in rows]
