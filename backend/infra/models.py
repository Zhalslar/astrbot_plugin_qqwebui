from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(slots=True)
class ContactPreview:
    session_id: str
    message_type: str
    target_id: str
    title: str
    summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ContactPreview:
        return cls(
            session_id=str(data.get("session_id", "")),
            message_type=str(data.get("message_type", "")),
            target_id=str(data.get("target_id", "")),
            title=str(data.get("title", "")),
            summary=str(data.get("summary", "")),
        )


@dataclass(slots=True)
class LoginInfo:
    user_id: str = ""
    nickname: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> LoginInfo:
        return cls(
            user_id=str(data.get("user_id", "")),
            nickname=str(data.get("nickname", "")),
        )


@dataclass(slots=True)
class GroupProfile:
    group_id: str
    group_name: str = ""
    member_count: int = 0
    max_member_count: int = 0
    group_all_shut: int = 0
    group_remark: str = ""

    @property
    def display_name(self) -> str:
        return self.group_name or self.group_id

    def patch(self, **values: Any) -> None:
        """Update non-empty fields in place.

        Args:
            **values: Candidate field values keyed by attribute name.
        """

        for key, value in values.items():
            if value is None or value == "":
                continue
            if getattr(self, key) != value:
                setattr(self, key, value)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> GroupProfile:
        return cls(
            group_id=str(data.get("group_id", "")),
            group_name=str(data.get("group_name", "")),
            member_count=int(data.get("member_count", 0) or 0),
            max_member_count=int(data.get("max_member_count", 0) or 0),
            group_all_shut=int(data.get("group_all_shut", 0) or 0),
            group_remark=str(data.get("group_remark", "")),
        )


@dataclass(slots=True)
class UserBrief:
    user_id: str
    nickname: str = ""
    sex: str = "unknown"
    age: int = 0
    area: str = ""

    def patch(self, **values: Any) -> None:
        """Update non-empty fields in place.

        Args:
            **values: Candidate field values keyed by attribute name.
        """

        for key, value in values.items():
            if value is None or value == "":
                continue
            if getattr(self, key) != value:
                setattr(self, key, value)


@dataclass(slots=True)
class UserProfile(UserBrief):
    is_friend: bool = False
    uid: str = ""
    qid: str = ""
    qqLevel: int = 0
    long_nick: str = ""
    reg_time: int = 0
    is_vip: bool = False
    is_years_vip: bool = False
    vip_level: int = 0
    remark: str = ""
    status: int = 0
    login_days: int = 0
    birthday_year: int = 0
    birthday_month: int = 0
    birthday_day: int = 0
    kBloodType: int = 0
    phoneNum: str = ""
    eMail: str = ""
    homeTown: str = ""
    country: str = ""
    province: str = ""
    city: str = ""
    address: str = ""
    makeFriendCareer: int = 0
    labels: str = ""

    @property
    def display_name(self) -> str:
        return self.remark or self.nickname or self.user_id

    def patch(self, **values: Any) -> None:
        """Update non-empty fields in place.

        Args:
            **values: Candidate field values keyed by attribute name.
        """

        for key, value in values.items():
            if value is None or value == "":
                continue
            if getattr(self, key) != value:
                setattr(self, key, value)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> UserProfile:
        return cls(
            user_id=str(data.get("user_id", "")),
            is_friend=bool(data.get("is_friend", False)),
            uid=str(data.get("uid", "")),
            nickname=str(data.get("nickname", "")),
            age=int(data.get("age", 0) or 0),
            area=str(data.get("area", "")),
            qid=str(data.get("qid", "")),
            qqLevel=int(data.get("qqLevel", 0) or 0),
            sex=str(data.get("sex", "unknown") or "unknown"),
            long_nick=str(data.get("long_nick", "")),
            reg_time=int(data.get("reg_time", 0) or 0),
            is_vip=bool(data.get("is_vip", False)),
            is_years_vip=bool(data.get("is_years_vip", False)),
            vip_level=int(data.get("vip_level", 0) or 0),
            remark=str(data.get("remark", "")),
            status=int(data.get("status", 0) or 0),
            login_days=int(data.get("login_days", 0) or 0),
            birthday_year=int(data.get("birthday_year", 0) or 0),
            birthday_month=int(data.get("birthday_month", 0) or 0),
            birthday_day=int(data.get("birthday_day", 0) or 0),
            kBloodType=int(data.get("kBloodType", 0) or 0),
            phoneNum=str(data.get("phoneNum", "")),
            eMail=str(data.get("eMail", "")),
            homeTown=str(data.get("homeTown", "")),
            country=str(data.get("country", "")),
            province=str(data.get("province", "")),
            city=str(data.get("city", "")),
            address=str(data.get("address", "")),
            makeFriendCareer=int(data.get("makeFriendCareer", 0) or 0),
            labels=str(data.get("labels", "")),
        )


@dataclass(slots=True)
class GroupMemberProfile(UserBrief):
    group_id: str = ""
    card: str = ""
    join_time: int = 0
    last_sent_time: int = 0
    level: str = ""
    role: str = "member"
    unfriendly: bool = False
    is_robot: bool = False
    title: str = ""
    title_expire_time: int = 0
    card_changeable: bool = False

    @property
    def display_name(self) -> str:
        return self.card or self.nickname or self.user_id

    def patch(self, **values: Any) -> None:
        """Update non-empty fields in place.

        Args:
            **values: Candidate field values keyed by attribute name.
        """

        for key, value in values.items():
            if value is None or value == "":
                continue
            if getattr(self, key) != value:
                setattr(self, key, value)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> GroupMemberProfile:
        return cls(
            group_id=str(data.get("group_id", "")),
            user_id=str(data.get("user_id", "")),
            nickname=str(data.get("nickname", "")),
            card=str(data.get("card", "")),
            sex=str(data.get("sex", "unknown") or "unknown"),
            age=int(data.get("age", 0) or 0),
            area=str(data.get("area", "")),
            join_time=int(data.get("join_time", 0) or 0),
            last_sent_time=int(data.get("last_sent_time", 0) or 0),
            level=str(data.get("level", "")),
            role=str(data.get("role", "member") or "member"),
            unfriendly=bool(data.get("unfriendly", False)),
            is_robot=bool(data.get("is_robot", False)),
            title=str(data.get("title", "")),
            title_expire_time=int(data.get("title_expire_time", 0) or 0),
            card_changeable=bool(data.get("card_changeable", False)),
        )


@dataclass(slots=True)
class Sender:
    user_id: str
    nickname: str = ""
    card: str = ""
    role: str = ""
    level: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Sender:
        return cls(
            user_id=str(data.get("user_id", "")),
            nickname=str(data.get("nickname", "")),
            card=str(data.get("card", "")),
            role=str(data.get("role", "")),
            level=str(data.get("level", "")),
        )


@dataclass(slots=True)
class MessageRecord:
    self_id: str
    user_id: str
    time: int
    is_self: bool
    message_id: str
    post_type: str
    message_type: str
    sub_type: str
    group_id: str
    raw_message: str
    message: list[dict[str, Any]] = field(default_factory=list)
    sender: Sender = field(default_factory=lambda: Sender(user_id=""))
    session_id: str = ""
    summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "self_id": self.self_id,
            "user_id": self.user_id,
            "time": self.time,
            "message_id": self.message_id,
            "post_type": self.post_type,
            "message_type": self.message_type,
            "sub_type": self.sub_type,
            "group_id": self.group_id,
            "raw_message": self.raw_message,
            "message": self.message,
            "sender": self.sender.to_dict(),
            "session_id": self.session_id,
            "is_self": self.is_self,
            "summary": self.summary,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> MessageRecord:
        sender = data.get("sender", {})
        if not isinstance(sender, dict):
            sender = {}
        message = data.get("message", [])
        if not isinstance(message, list):
            message = []
        return cls(
            self_id=str(data.get("self_id", "")),
            user_id=str(data.get("user_id", "")),
            time=int(data.get("time", 0) or 0),
            message_id=str(data.get("message_id", "")),
            post_type=str(data.get("post_type", "")),
            message_type=str(data.get("message_type", "")),
            sub_type=str(data.get("sub_type", "")),
            group_id=str(data.get("group_id", "")),
            raw_message=str(data.get("raw_message", "")),
            message=[dict(item) for item in message if isinstance(item, dict)],
            sender=(
                Sender.from_dict(sender)
                if isinstance(sender, dict)
                else Sender(user_id="")
            ),
            session_id=str(data.get("session_id", "")),
            is_self=bool(data.get("is_self", False)),
            summary=str(data.get("summary", "")),
        )


@dataclass(slots=True)
class SessionPreview:
    session_id: str
    message_type: str
    title: str
    sender_name: str = ""
    read_mid: str = ""
    unread: int = 0
    muted: bool = False
    kind: str = "message"
    summary: str = ""
    time: int = 0
    member_count: int | None = None

    @property
    def target_id(self) -> str:
        return self.session_id.partition(":")[2]

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "message_type": self.message_type,
            "target_id": self.target_id,
            "title": self.title,
            "sender_name": self.sender_name,
            "read_mid": self.read_mid,
            "unread": self.unread,
            "muted": self.muted,
            "kind": self.kind,
            "summary": self.summary,
            "time": self.time,
            "member_count": self.member_count,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SessionPreview:
        return cls(
            session_id=str(data.get("session_id", "")),
            message_type=str(data.get("message_type", "")),
            title=str(data.get("title", "")),
            sender_name=str(data.get("sender_name", "")),
            read_mid=str(data.get("read_mid", "")),
            unread=int(data.get("unread", 0) or 0),
            muted=bool(data.get("muted", False)),
            kind=str(data.get("kind", "message") or "message"),
            summary=str(data.get("summary", "")),
            time=int(data.get("time", 0) or 0),
            member_count=(
                int(data["member_count"])
                if data.get("member_count") is not None
                else None
            ),
        )
