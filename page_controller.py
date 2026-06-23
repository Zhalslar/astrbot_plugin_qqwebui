from __future__ import annotations

from astrbot.api import logger
from astrbot.api.web import error_response, json_response, request

PLUGIN_NAME = "astrbot_plugin_qqwebui"


class QQWebuiPageController:
    def __init__(self, context, service):
        self.context = context
        self.service = service

    def register_routes(self) -> None:
        routes = [
            ("/page/status", self.page_status, ["GET"], "QQ WebUI status"),
            ("/page/sessions", self.page_sessions, ["GET"], "QQ WebUI sessions"),
            ("/page/messages", self.page_messages, ["GET"], "QQ WebUI messages"),
            ("/page/faces", self.page_faces, ["GET"], "QQ WebUI QQ faces"),
            ("/page/send", self.page_send, ["POST"], "QQ WebUI send message"),
            ("/page/send-face", self.page_send_face, ["POST"], "QQ WebUI send QQ face"),
            ("/page/upload", self.page_upload, ["POST"], "QQ WebUI upload attachment"),
            (
                "/page/media/content",
                self.page_media_content,
                ["GET"],
                "QQ WebUI media content",
            ),
            ("/page/read", self.page_read, ["POST"], "QQ WebUI mark read"),
            ("/page/contacts", self.page_contacts, ["GET"], "QQ WebUI contacts"),
            (
                "/page/contacts/refresh",
                self.page_contacts_refresh,
                ["POST"],
                "QQ WebUI refresh contacts",
            ),
            (
                "/page/group/members",
                self.page_group_members,
                ["GET"],
                "QQ WebUI group members",
            ),
        ]
        for path, handler, methods, desc in routes:
            self.context.register_web_api(
                f"/{PLUGIN_NAME}{path}",
                handler,
                methods,
                desc,
            )

    @staticmethod
    def _ok(data=None, message: str = ""):
        return json_response({"ok": True, "message": message, "data": data or {}})

    @staticmethod
    def _error(message: str, status_code: int = 400):
        return error_response(message, status_code=status_code)

    async def page_status(self):
        try:
            return self._ok(await self.service.get_status())
        except Exception as exc:
            logger.exception("[qqwebui] page_status failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_sessions(self):
        try:
            args = request.query
            data = await self.service.list_sessions(
                keyword=str(args.get("keyword", "")).strip(),
                chat_type=str(args.get("chat_type", "")).strip(),
                limit=max(int(str(args.get("limit", "200")).strip() or "200"), 1),
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
                await self.service.list_messages(session_id, before=before, limit=limit)
            )
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            logger.exception("[qqwebui] page_messages failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_send(self):
        try:
            payload = await request.json(default={}) or {}
            session_id = str(payload.get("session_id", "")).strip()
            text = str(payload.get("text", ""))
            raw_attachments = payload.get("attachments", [])
            attachment_keys = (
                [str(item).strip() for item in raw_attachments]
                if isinstance(raw_attachments, list)
                else []
            )
            return self._ok(
                await self.service.send_message(session_id, text, attachment_keys),
                "sent",
            )
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            logger.exception("[qqwebui] page_send failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_send_face(self):
        try:
            payload = await request.json(default={}) or {}
            session_id = str(payload.get("session_id", "")).strip()
            face_id = int(payload.get("face_id"))
            return self._ok(
                await self.service.send_face(session_id, face_id),
                "sent",
            )
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            logger.exception("[qqwebui] page_send_face failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_upload(self):
        try:
            files = await request.files()
            upload = files.get("file")
            if upload is None:
                return self._error("file is required", 400)
            raw_bytes = await upload.read()
            data = await self.service.upload_attachment(
                raw_bytes,
                upload.filename or "file.bin",
                upload.content_type or "application/octet-stream",
            )
            return self._ok(data, "uploaded")
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            logger.exception("[qqwebui] page_upload failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_media_content(self):
        try:
            key = str(request.query.get("key", "")).strip()
            if not key:
                return self._error("key is required", 400)
            return self._ok(await self.service.get_media_content(key))
        except FileNotFoundError as exc:
            return self._error(str(exc), 404)
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            logger.exception("[qqwebui] page_media_content failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_read(self):
        try:
            payload = await request.json(default={}) or {}
            session_id = str(payload.get("session_id", "")).strip()
            if not session_id:
                return self._error("session_id is required", 400)
            return self._ok(await self.service.mark_session_read(session_id))
        except Exception as exc:
            logger.exception("[qqwebui] page_read failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_contacts(self):
        try:
            args = request.query
            data = await self.service.list_contacts(
                keyword=str(args.get("keyword", "")).strip(),
                scope=str(args.get("scope", "all")).strip() or "all",
            )
            return self._ok({"items": data})
        except Exception as exc:
            logger.exception("[qqwebui] page_contacts failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_contacts_refresh(self):
        try:
            payload = await request.json(default={}) or {}
            force = bool(payload.get("force", True))
            return self._ok(
                await self.service.refresh_contacts(force=force), "refreshed"
            )
        except Exception as exc:
            logger.exception("[qqwebui] page_contacts_refresh failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_group_members(self):
        try:
            args = request.query
            group_id = str(args.get("group_id", "")).strip()
            force = str(args.get("force", "")).strip().lower() in {
                "1",
                "true",
                "yes",
                "on",
            }
            return self._ok(
                await self.service.list_group_members(group_id, force=force)
            )
        except ValueError as exc:
            return self._error(str(exc), 400)
        except Exception as exc:
            logger.exception("[qqwebui] page_group_members failed: %s", exc)
            return self._error(str(exc), 500)

    async def page_faces(self):
        try:
            return self._ok({"items": await self.service.list_faces()})
        except Exception as exc:
            logger.exception("[qqwebui] page_faces failed: %s", exc)
            return self._error(str(exc), 500)
