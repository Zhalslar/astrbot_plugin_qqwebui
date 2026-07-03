import { els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { setStatus } from "../core/status.js";
import { avatarUrl, formatTime, setAvatar, text } from "../core/utils.js";

let sessionOpenHandler = null;
let sessionMuteHandler = null;
let sessionPinHandler = null;
let sessionDeleteHandler = null;

function renderLeftListTabs() {
  for (const button of els.leftListTabs.querySelectorAll(".left-list-tab")) {
    const mode = text(button.dataset.mode).trim();
    const active = mode === state.leftListMode;
    if (mode === "sessions") {
      button.textContent = t("pages.dashboard.left_tabs.sessions");
    } else if (mode === "friends") {
      button.textContent = t("pages.dashboard.left_tabs.friends");
    } else if (mode === "groups") {
      button.textContent = t("pages.dashboard.left_tabs.groups");
    }
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  }
}

function sessionPreviewText(session) {
  const summary = text(session.summary).trim();
  if (!summary) {
    return t("pages.dashboard.sessions.no_preview", "No preview");
  }
  if (session.kind === "notice") {
    const noticeType = summary.match(/^\[Notice:([^\]]+)\]$/)?.[1] || "notice";
    return t("pages.dashboard.notices.generic", "Notice: {type}").replace(
      "{type}",
      noticeType
    );
  }
  if (session.message_type !== "group") {
    return summary;
  }
  const senderName = text(session.sender_name).trim();
  if (!senderName) {
    return summary;
  }
  const cleanSummary = summary.startsWith(`${senderName}: `)
    ? summary.slice(senderName.length + 2)
    : summary;
  return `${senderName}: ${cleanSummary}`;
}

export function renderSessionList(openSession) {
  if (typeof openSession === "function") {
    sessionOpenHandler = openSession;
  }
  renderLeftListTabs();
  const sessions = [];
  const seenSessionIds = new Set();
  for (const session of state.sessions) {
    const sessionId = text(session?.session_id).trim();
    if (!sessionId || seenSessionIds.has(sessionId)) {
      continue;
    }
    seenSessionIds.add(sessionId);
    sessions.push(session);
  }
  const visible = state.leftListMode === "sessions";
  els.sessionList.classList.toggle("is-hidden", !visible);
  els.contactList.classList.toggle("is-hidden", visible);
  if (!visible) {
    return;
  }
  els.leftListCount.textContent = String(sessions.length);
  els.sessionSearchInput.placeholder = t(
    "pages.dashboard.sessions.search_placeholder",
    "Group name / QQ"
  );
  if (!sessions.length) {
    els.sessionList.className = "session-list empty-state";
    els.sessionList.textContent = t(
      "pages.dashboard.sessions.empty",
      "No QQ traffic yet. Send or receive a message first."
    );
    return;
  }
  els.sessionList.className = "session-list";
  els.sessionList.replaceChildren();
  for (const session of sessions) {
    const unread =
      session.session_id === state.activeSessionId ? 0 : Number(session.unread || 0);
    const item = document.createElement("div");
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    item.dataset.sessionId = session.session_id;
    item.addEventListener("click", () => {
      if (sessionOpenHandler) {
        void sessionOpenHandler(session.session_id);
      }
    });
    item.addEventListener("keydown", (event) => {
      if (event.target !== item) {
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      if (sessionOpenHandler) {
        void sessionOpenHandler(session.session_id);
      }
    });

    const avatar = document.createElement("div");
    avatar.className = "avatar";

    const main = document.createElement("div");
    main.className = "session-main";
    const title = document.createElement("strong");
    const preview = document.createElement("span");
    main.append(title, preview);

    const meta = document.createElement("div");
    meta.className = "session-meta";
    const when = document.createElement("span");
    meta.append(when);

    item.append(avatar, main, meta);
    item.className = `session-item${
      session.session_id === state.activeSessionId ? " active" : ""
    }${session.pin ? " is-pinned" : ""}`;

    setAvatar(
      avatar,
      avatarUrl(session.target_id, session.message_type),
      text(session.title).slice(0, 1).toUpperCase()
    );

    title.textContent = session.title || session.target_id;
    preview.textContent = sessionPreviewText(session);

    when.textContent = formatTime(session.time);
    if (session.muted || unread > 0) {
      const stateButton = document.createElement("button");
      const nextMuted = !Boolean(session.muted);
      const pending = state.sessionMutePendingIds.has(session.session_id);
      const label = session.muted
        ? t("pages.dashboard.sessions.unmute", "Turn off Do Not Disturb")
        : t("pages.dashboard.sessions.mute", "Turn on Do Not Disturb");
      stateButton.type = "button";
      stateButton.className = `session-state-button${
        session.muted ? " is-muted" : " is-unread"
      }${pending ? " is-pending" : ""}`;
      stateButton.disabled = pending;
      stateButton.title = label;
      stateButton.setAttribute("aria-label", label);
      if (session.muted) {
        stateButton.innerHTML =
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.5 14.5 20 16m-1.5-1.5L15 11m3.5 3.5 3-3M4 4l16 16M9.4 5.4A6 6 0 0 1 18 10.8v3.7l1.6 2.2H8.9M6 15.2V10.8A6 6 0 0 1 8 6.3M10 19a2.5 2.5 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
      } else {
        stateButton.textContent = String(unread);
      }
      stateButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!sessionMuteHandler) {
          return;
        }
        try {
          await sessionMuteHandler(session.session_id, nextMuted);
        } catch (error) {
          setStatus(
            error?.message ||
              t(
                "pages.dashboard.status.session_mute_failed",
                "Failed to update session."
              )
          );
        }
      });
      meta.append(stateButton);
    }

    const actions = document.createElement("div");
    actions.className = "session-actions";

    const pinButton = document.createElement("button");
    const nextPinned = !Boolean(session.pin);
    const pinPending = state.sessionPinPendingIds.has(session.session_id);
    const pinLabel = session.pin
      ? t("pages.dashboard.sessions.unpin", "Unpin session")
      : t("pages.dashboard.sessions.pin", "Pin session");
    pinButton.type = "button";
    pinButton.tabIndex = -1;
    pinButton.className = `session-action-button session-action-pin${
      session.pin ? " is-active" : ""
    }${pinPending ? " is-pending" : ""}`;
    pinButton.disabled = pinPending;
    pinButton.title = pinLabel;
    pinButton.setAttribute("aria-label", pinLabel);
    pinButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 3 7 7-3 1-4 4v4l-2 2-3.5-3.5L4 22l4.5-4.5L5 14l2-2h4l4-4 1-3Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
    pinButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!sessionPinHandler) {
        return;
      }
      try {
        await sessionPinHandler(session.session_id, nextPinned);
      } catch (error) {
        setStatus(
          error?.message ||
            t("pages.dashboard.status.session_pin_failed", "Failed to update session.")
        );
      }
    });

    const deleteButton = document.createElement("button");
    const deletePending = state.sessionDeletePendingIds.has(session.session_id);
    const deleteLabel = t("pages.dashboard.sessions.delete", "Delete session");
    deleteButton.type = "button";
    deleteButton.tabIndex = -1;
    deleteButton.className = `session-action-button session-action-delete${
      deletePending ? " is-pending" : ""
    }`;
    deleteButton.disabled = deletePending;
    deleteButton.title = deleteLabel;
    deleteButton.setAttribute("aria-label", deleteLabel);
    deleteButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
    deleteButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!sessionDeleteHandler) {
        return;
      }
      try {
        await sessionDeleteHandler(session.session_id);
      } catch (error) {
        setStatus(
          error?.message ||
            t("pages.dashboard.status.session_delete_failed", "Failed to delete session.")
        );
      }
    });

    actions.append(pinButton, deleteButton);
    item.append(actions);
    els.sessionList.append(item);
  }
}

export function bindSessionSidebarEvents({
  loadSessions,
  loadContacts,
  renderAll,
  setSessionMuted,
  setSessionPinned,
  deleteSession,
}) {
  if (typeof setSessionMuted === "function") {
    sessionMuteHandler = setSessionMuted;
  }
  if (typeof setSessionPinned === "function") {
    sessionPinHandler = setSessionPinned;
  }
  if (typeof deleteSession === "function") {
    sessionDeleteHandler = deleteSession;
  }
  els.sessionSearchInput.addEventListener("input", async () => {
    state.searchKeyword = els.sessionSearchInput.value.trim();
    if (state.leftListMode === "sessions") {
      await loadSessions();
    } else {
      await loadContacts(false);
    }
  });

  els.leftListTabs.addEventListener("click", async (event) => {
    const button = event.target.closest(".left-list-tab");
    if (!button) {
      return;
    }
    const mode = text(button.dataset.mode).trim();
    if (!["sessions", "friends", "groups"].includes(mode) || state.leftListMode === mode) {
      return;
    }
    state.leftListMode = mode;
    renderLeftListTabs();
    renderAll();
    if (mode === "sessions") {
      await loadSessions();
    } else {
      await loadContacts(true);
    }
  });
}
