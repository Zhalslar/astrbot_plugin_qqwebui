from __future__ import annotations

import base64

from astrbot.api import logger
from astrbot.api.web import (
    PluginUploadFile,
    error_response,
    json_response,
    request,
    stream_response,
)
from astrbot.core.star.context import Context

from ..config import PluginConfig
from .service.action_service import ActionService
from .service.contact_service import ContactService
from .service.file_service import FileService
from .service.outbound_service import OutboundService
from .service.session_service import SessionService
from .service.sse_service import SseService
from .service.status_service import StatusService

PLUGIN_NAME = "astrbot_plugin_qqwebui"


class PageController:
    def __init__(
        self,
        cfg: PluginConfig,
        context: Context,
        sse: SseService,
        status: StatusService,
        contacts: ContactService,
        sessions: SessionService,
        files: FileService,
        outbound: OutboundService,
        actions: ActionService,
    ) -> None:
        self.context = context
        self.sse = sse
        self.status = status
        self.contacts = contacts
        self.sessions = sessions
        self.files = files
        self.outbound = outbound
        self.actions = actions
        self.cfg = cfg
        self.routes = [
            ("/page/status", self.page_status, ["GET"], "status"),
            ("/page/sessions", self.page_sessions, ["GET"], "sessions"),
            ("/page/messages", self.page_messages, ["GET"], "messages"),
            ("/page/events", self.page_events, ["GET"], "SSE updates"),
            ("/page/view", self.page_view, ["POST"], "sync session view"),
            ("/page/session/mute", self.page_session_mute, ["POST"], "mute session"),
            ("/page/session/pin", self.page_session_pin, ["POST"], "pin session"),
            (
                "/page/session/delete",
                self.page_session_delete,
                ["POST"],
                "delete session",
            ),
            ("/page/contacts", self.page_contacts, ["GET"], "contacts"),
            ("/page/contacts/refresh", self.page_contacts_refresh, ["POST"], "..."),
            (
                "/page/contact/profile",
                self.page_contact_profile,
                ["GET"],
                "contact profile",
            ),
            (
                "/page/contact/profile/refresh",
                self.page_contact_profile_refresh,
                ["POST"],
                "refresh contact profile",
            ),
            ("/page/group/members", self.page_group_members, ["GET"], "group members"),
            ("/page/face-index", self.page_face_index, ["GET"], "QQ face catalog"),
            ("/page/send", self.page_send, ["POST"], "send message"),
            ("/page/action/poke", self.page_action_poke, ["POST"], "send poke"),
            ("/page/media/upload", self.page_media_upload, ["POST"], "upload media"),
            ("/page/faces", self.page_faces, ["GET"], "QQ face assets"),
        ]

    def register_routes(self) -> None:
        for path, handler, methods, desc in self.routes:
            self.context.register_web_api(
                f"/{PLUGIN_NAME}{path}", handler, methods, desc
            )

    @staticmethod
    def _ok(data=None, message: str = ""):
        return json_response({"ok": True, "message": message, "data": data or {}})

    @staticmethod
    def _error(message: str, status_code: int = 400):
        return error_response(message, status_code=status_code)

    async def page_status(self):
        try:
            return self._ok(await self.status.get_status())
        except Exception as exc:
            logger.exception("[qqwebui] page_status failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_sessions(self):
        try:
            args = request.query
            data = await self.sessions.list_sessions(
                keyword=str(args.get("keyword", "")),
                message_type=str(args.get("message_type", "")),
                limit=max(int(str(args.get("limit", "200")) or "200"), 1),
            )
            return self._ok({"items": data})
        except Exception as exc:
            logger.exception("[qqwebui] page_sessions failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_messages(self):
        try:
            args = request.query
            session_id = str(args.get("session_id", "")).strip()
            if not session_id:
                return self._error("session_id is required", 400)
            before_raw = str(args.get("before", "")).strip()
            before = int(before_raw) if before_raw else None
            limit = max(int(str(args.get("limit", "50")).strip() or "50"), 1)
            return self._ok(
                await self.sessions.list_messages(
                    session_id, before=before, limit=limit
                )
            )
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            logger.exception("[qqwebui] page_messages failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_events(self):
        try:
            return stream_response(content=self.sse.stream_events())
        except Exception as exc:
            logger.exception("[qqwebui] page_events failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_view(self):
        try:
            payload = await request.json(default={}) or {}
            session_id = str(payload.get("session_id", "")).strip()
            at_bottom = bool(payload.get("at_bottom", False))
            read_mid = str(payload.get("read_mid", "")).strip()
            return self._ok(
                await self.sessions.sync_session_view(session_id, at_bottom, read_mid)
            )
        except Exception as exc:
            logger.exception("[qqwebui] page_view failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_session_mute(self):
        try:
            payload = await request.json(default={}) or {}
            session_id = str(payload.get("session_id", "")).strip()
            muted = bool(payload.get("muted", False))
            return self._ok(await self.sessions.set_session_muted(session_id, muted))
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            logger.exception("[qqwebui] page_session_mute failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_session_pin(self):
        try:
            payload = await request.json(default={}) or {}
            session_id = str(payload.get("session_id", "")).strip()
            pin = bool(payload.get("pin", False))
            return self._ok(await self.sessions.set_session_pin(session_id, pin))
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            logger.exception("[qqwebui] page_session_pin failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_session_delete(self):
        try:
            payload = await request.json(default={}) or {}
            session_id = str(payload.get("session_id", "")).strip()
            return self._ok(await self.sessions.delete_session(session_id))
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            logger.exception("[qqwebui] page_session_delete failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_contacts(self):
        try:
            args = request.query
            data = await self.contacts.list_contacts(
                keyword=str(args.get("keyword", "")),
                scope=str(args.get("scope", "all")) or "all",
            )
            return self._ok({"items": data})
        except Exception as exc:
            logger.exception("[qqwebui] page_contacts failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_contacts_refresh(self):
        try:
            payload = await request.json(default={}) or {}
            force = bool(payload.get("force", False))
            data = await self.contacts.refresh_contacts(force=force)
            return self._ok(data, "refreshed")
        except Exception as exc:
            logger.exception("[qqwebui] page_contacts_refresh failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_contact_profile(self):
        try:
            args = request.query
            data = self.contacts.get_contact_profile(
                str(args.get("user_id", "")),
                group_id=str(args.get("group_id", "")),
            )
            return self._ok(data)
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            logger.exception("[qqwebui] page_contact_profile failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_contact_profile_refresh(self):
        try:
            payload = await request.json(default={}) or {}
            user_id = str(payload.get("user_id", "")).strip()
            group_id = str(payload.get("group_id", "")).strip()
            force = bool(payload.get("force", True))
            await self.contacts.refresh_contact_profile(
                user_id,
                group_id=group_id,
                force=force,
            )
            data = self.contacts.get_contact_profile(user_id, group_id=group_id)
            return self._ok(data, "refreshed")
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            logger.exception("[qqwebui] page_contact_profile_refresh failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_group_members(self):
        try:
            group_id = str(request.query.get("group_id", ""))
            force = str(request.query.get("force", "")).strip().lower() in {
                "1",
                "true",
                "yes",
                "on",
            }
            await self.contacts.refresh_group_members(group_id, force=force)
            data = await self.contacts.list_group_members(group_id)
            return self._ok({"items": data, "group_id": group_id})
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            logger.exception("[qqwebui] page_group_members failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_face_index(self):
        try:
            face_dir = self.cfg.qq_face_dir.resolve(strict=False)
            if not face_dir.is_dir():
                return self._ok({"items": []})

            items: list[str] = []
            for target in face_dir.glob("*.gif"):
                face_id = target.stem.strip()
                if face_id.isdigit():
                    items.append(face_id)
            items.sort(key=lambda face_id: int(face_id))
            return self._ok({"items": items})
        except Exception as exc:
            logger.exception("[qqwebui] page_face_index failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_send(self):
        try:
            payload = await request.json(default={}) or {}
            session_id = str(payload.get("session_id", "")).strip()
            message = payload.get("message", [])
            if not isinstance(message, list):
                return self._error("message must be an array", 400)
            data = await self.outbound.send_message(session_id, message)
            return self._ok(data, "sent")
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            logger.exception("[qqwebui] page_send failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_action_poke(self):
        try:
            payload = await request.json(default={}) or {}
            user_id = str(payload.get("user_id", "")).strip()
            group_id = str(payload.get("group_id", "")).strip()
            data = await self.actions.send_poke(user_id, group_id=group_id)
            return self._ok(data, "sent")
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            logger.exception("[qqwebui] page_action_poke failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_media_upload(self):
        try:
            files = await request.files()
            upload = files.get("file")
            if not isinstance(upload, PluginUploadFile):
                return self._error("file is required", 400)
            data = await self.files.upload_media(upload)
            return self._ok(data, "uploaded")
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            logger.exception("[qqwebui] page_media_upload failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_faces(self):
        try:
            raw_ids = str(request.query.get("ids", "")).strip()
            if not raw_ids:
                return self._ok({"items": {}})

            face_dir = self.cfg.qq_face_dir.resolve(strict=False)
            items: dict[str, str] = {}
            for face_id in raw_ids.split(","):
                clean_face_id = str(face_id).strip()
                if not clean_face_id or not clean_face_id.isdigit():
                    continue
                target = (face_dir / f"{clean_face_id}.gif").resolve(strict=False)
                try:
                    target.relative_to(face_dir.resolve(strict=False))
                except ValueError:
                    continue
                if not target.is_file():
                    continue
                items[clean_face_id] = "data:image/gif;base64," + base64.b64encode(
                    target.read_bytes()
                ).decode("ascii")

            return self._ok({"items": items})
        except Exception as exc:
            logger.exception("[qqwebui] page_faces failed: %s", exc)
            return self._error(str(exc), 500)
