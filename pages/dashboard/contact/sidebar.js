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
  const visible = state.showingContacts;
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
  for (const contact of state.contacts.slice(0, 30)) {
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
