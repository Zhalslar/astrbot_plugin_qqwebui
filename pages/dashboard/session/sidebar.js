import { els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { avatarUrl, formatTime, setAvatar, text } from "../core/utils.js";

let sessionOpenHandler = null;

function sessionPreviewText(session) {
  const summary = text(session.summary).trim();
  if (!summary) {
    return t("pages.dashboard.sessions.no_preview", "No preview");
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
  const visible = !state.showingContacts;
  els.sessionList.classList.toggle("is-hidden", !visible);
  els.contactList.classList.toggle("is-hidden", visible);
  if (!visible) {
    return;
  }
  els.leftListTitle.textContent = t("pages.dashboard.sessions.title", "Recent sessions");
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
    const unread = session.session_id === state.activeSessionId ? 0 : Number(session.unread || 0);
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.sessionId = session.session_id;
    button.addEventListener("click", () => {
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

    button.append(avatar, main, meta);
    button.className = `session-item${session.session_id === state.activeSessionId ? " active" : ""}`;

    setAvatar(
      avatar,
      avatarUrl(session.target_id, session.message_type),
      text(session.title).slice(0, 1).toUpperCase()
    );

    title.textContent = session.title || session.target_id;
    preview.textContent = sessionPreviewText(session);

    when.textContent = formatTime(session.time);
    if (unread > 0) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = String(unread);
      meta.append(badge);
    }

    els.sessionList.append(button);
  }
}

export function bindSessionSidebarEvents({ loadSessions, loadContacts, renderAll }) {
  els.sessionSearchInput.addEventListener("input", async () => {
    state.searchKeyword = els.sessionSearchInput.value.trim();
    await loadSessions();
    await loadContacts(false);
  });

  els.toggleContactsBtn.addEventListener("click", () => {
    state.showingContacts = !state.showingContacts;
    renderAll();
  });
}
