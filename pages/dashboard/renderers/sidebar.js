import { els } from "../dom.js";
import { t } from "../i18n.js";
import { state } from "../store.js";
import { avatarUrl, formatTime, sessionAvatarUrl, setAvatar, text } from "../utils.js";

export function renderSessions(openSession) {
  const visible = !state.showContacts;
  els.sessionList.classList.toggle("is-hidden", !visible);
  els.contactList.classList.toggle("is-hidden", visible);
  if (!visible) {
    return;
  }
  els.leftListTitle.textContent = t(
    "pages.dashboard.sessions.title",
    "Recent sessions"
  );
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
  for (const item of state.sessions) {
    let button = existingItems.get(item.session_id);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.dataset.sessionId = item.session_id;
      button.addEventListener("click", () => {
        void openSession(item.session_id);
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
    button.className = `session-item${item.session_id === state.activeSessionId ? " active" : ""}`;
    const renderKey = [
      item.title || "",
      item.avatar || "",
      item.target_id || "",
      item.chat_type || "",
      item.last_message_preview || "",
      item.last_timestamp || "",
      item.unread_count || 0,
    ].join("\u0001");
    if (button.dataset.renderKey !== renderKey) {
      const avatar = button.querySelector(".avatar");
      setAvatar(
        avatar,
        sessionAvatarUrl(item),
        text(item.title).slice(0, 1).toUpperCase()
      );

      const title = button.querySelector(".session-main strong");
      title.textContent = item.title || item.target_id;
      const preview = button.querySelector(".session-main span");
      preview.textContent =
        item.last_message_preview || t("pages.dashboard.sessions.no_preview", "No preview");

      const meta = button.querySelector(".session-meta");
      const when = meta.querySelector("span");
      when.textContent = formatTime(item.last_timestamp);
      const currentBadge = meta.querySelector(".badge");
      if (Number(item.unread_count || 0) > 0) {
        if (currentBadge) {
          currentBadge.textContent = String(item.unread_count);
        } else {
          const badge = document.createElement("span");
          badge.className = "badge";
          badge.textContent = String(item.unread_count);
          meta.append(badge);
        }
      } else {
        currentBadge?.remove();
      }
      button.dataset.renderKey = renderKey;
    }
    existingItems.delete(item.session_id);
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

export function renderContacts(openSession) {
  const visible = state.showContacts;
  els.sessionList.classList.toggle("is-hidden", visible);
  els.contactList.classList.toggle("is-hidden", !visible);
  if (!visible) {
    return;
  }
  els.leftListTitle.textContent = t("pages.dashboard.contacts.title", "Contacts");
  els.leftListCount.textContent = String(state.contacts.length);
  els.sessionSearchInput.placeholder = t(
    "pages.dashboard.contacts.search_placeholder",
    "Friend / group / QQ"
  );
  if (!state.contacts.length) {
    els.contactList.className = "contact-list empty-state";
    els.contactList.textContent = t(
      "pages.dashboard.contacts.empty",
      "Contacts will appear after refresh."
    );
    return;
  }
  els.contactList.className = "contact-list";
  els.contactList.replaceChildren();
  for (const item of state.contacts.slice(0, 30)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "contact-item";
    row.addEventListener("click", () => {
      void openSession(`${item.type === "group" ? "group" : "private"}:${item.id}`);
    });

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    setAvatar(
      avatar,
      item.avatar || avatarUrl(item.id, item.type),
      text(item.title).slice(0, 1).toUpperCase()
    );

    const main = document.createElement("div");
    main.className = "contact-main";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const subtitle = document.createElement("span");
    subtitle.textContent =
      item.subtitle ||
      t(`pages.dashboard.contacts.types.${item.type}`, item.type || "");
    main.append(title, subtitle);

    row.append(avatar, main);
    els.contactList.append(row);
  }
}
