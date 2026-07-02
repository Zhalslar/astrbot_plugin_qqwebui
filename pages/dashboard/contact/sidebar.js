import { els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { avatarUrl, setAvatar, text } from "../core/utils.js";
import { openProfileModal } from "../profile/modal.js";

let contactOpenHandler = null;

export function renderContactList(openSession) {
  if (typeof openSession === "function") {
    contactOpenHandler = openSession;
  }
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
  const visible = state.leftListMode === "friends" || state.leftListMode === "groups";
  els.sessionList.classList.toggle("is-hidden", visible);
  els.contactList.classList.toggle("is-hidden", !visible);
  if (!visible) {
    return;
  }
  els.leftListCount.textContent = String(state.contacts.length);
  els.sessionSearchInput.placeholder =
    state.leftListMode === "groups"
      ? t("pages.dashboard.contacts.search_groups_placeholder", "Group / QQ")
      : t("pages.dashboard.contacts.search_friends_placeholder", "Friend / QQ");
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
  for (const contact of state.contacts) {
    const row = document.createElement("div");
    row.className = "contact-item";
    row.addEventListener("click", () => {
      if (contactOpenHandler) {
        void contactOpenHandler(contact.session_id);
      }
    });

    const avatarButton = document.createElement("button");
    avatarButton.type = "button";
    avatarButton.className = "avatar-button";
    avatarButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (contact.message_type !== "private") {
        return;
      }
      void openProfileModal({
        userId: contact.target_id,
        groupId: "",
        displayName: contact.title,
        subtitle: `QQ ${contact.target_id}`,
      });
    });

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    setAvatar(
      avatar,
      avatarUrl(contact.target_id, contact.message_type),
      text(contact.title).slice(0, 1).toUpperCase()
    );
    avatarButton.append(avatar);

    const main = document.createElement("div");
    main.className = "contact-main";
    const title = document.createElement("strong");
    title.textContent = contact.title;
    const summary = document.createElement("span");
    summary.textContent =
      contact.summary ||
      t(`pages.dashboard.contacts.types.${contact.message_type}`, contact.message_type || "");
    main.append(title, summary);

    row.append(avatarButton, main);
    els.contactList.append(row);
  }
}
