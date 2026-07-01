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
  const visible = !state.showingContacts;
  els.sessionList.classList.toggle("is-hidden", !visible);
  els.contactList.classList.toggle("is-hidden", visible);
  if (!visible) {
    return;
  }
  els.leftListTitle.textContent = t("pages.dashboard.sessions.title", "Recent sessions");
  els.leftListCount.textContent = String(state.sessions.length);
  els.sessionSearchInput.placeholder = t(
    "pages.dashboard.sessions.search_placeholder",
    "Group name / QQ"
  );
  if (!state.sessions.length) {
    els.sessionList.className = "session-list empty-state";
    els.sessionList.textContent = t(
      "pages.dashboard.sessions.empty",
      "No QQ traffic yet. Send or receive a message first."
    );
    return;
  }
  const wasEmptyState = els.sessionList.classList.contains("empty-state");
  els.sessionList.className = "session-list";
  if (wasEmptyState) {
    els.sessionList.replaceChildren();
  }
  const existingItems = new Map(
    Array.from(els.sessionList.querySelectorAll(".session-item")).map((item) => [
      item.dataset.sessionId,
      item,
    ])
  );
  let cursor = els.sessionList.firstElementChild;
  for (const session of state.sessions) {
    const unread = session.session_id === state.activeSessionId ? 0 : Number(session.unread || 0);
    let button = existingItems.get(session.session_id);
    if (!button) {
      button = document.createElement("button");
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
    }
    button.className = `session-item${session.session_id === state.activeSessionId ? " active" : ""}`;
    const renderKey = [
      session.title || "",
      session.target_id || "",
      session.sender_name || "",
      session.message_type || "",
      session.summary || "",
      session.time || "",
      unread,
      session.member_count ?? "",
    ].join("\u0001");
    if (button.dataset.renderKey !== renderKey) {
      const avatar = button.querySelector(".avatar");
      setAvatar(
        avatar,
        avatarUrl(session.target_id, session.message_type),
        text(session.title).slice(0, 1).toUpperCase()
      );

      const title = button.querySelector(".session-main strong");
      title.textContent = session.title || session.target_id;
      const preview = button.querySelector(".session-main span");
      preview.textContent = sessionPreviewText(session);

      const meta = button.querySelector(".session-meta");
      const when = meta.querySelector("span");
      when.textContent = formatTime(session.time);
      const currentBadge = meta.querySelector(".badge");
      if (unread > 0) {
        if (currentBadge) {
          currentBadge.textContent = String(unread);
        } else {
          const badge = document.createElement("span");
          badge.className = "badge";
          badge.textContent = String(unread);
          meta.append(badge);
        }
      } else {
        currentBadge?.remove();
      }
      button.dataset.renderKey = renderKey;
    }
    existingItems.delete(session.session_id);
    if (button === cursor) {
      cursor = cursor.nextElementSibling;
    } else {
      els.sessionList.insertBefore(button, cursor);
    }
  }
  for (const item of existingItems.values()) {
    item.remove();
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
