import { bridge, els } from "./dom.js";
import { state } from "./store.js";
import { getLocale, text } from "./utils.js";

export function t(key, fallback) {
  return bridge?.t?.(key, fallback) || fallback;
}

export function syncLocaleFromContext() {
  state.locale = text(
    bridge?.getLocale?.() || bridge?.getContext?.()?.locale || "zh-CN"
  ).trim() || "zh-CN";
}

export function renderStaticText() {
  document.documentElement.lang = getLocale();
  document.title = t("pages.dashboard.title", "QQ Dashboard");
  els.chatTitle.textContent =
    state.activeSessionId ||
    t("pages.dashboard.messages.select_session", "Select a conversation from the left side.");
  els.quoteModalTitle.textContent = t("pages.dashboard.forward.modal_title", "Forwarded Messages");
  els.quoteModalMeta.textContent = t("pages.dashboard.forward.card_footer", "Messages");
  els.toggleContactsBtn.title = state.showContacts
    ? t("pages.dashboard.actions.show_sessions", "Show recent sessions")
    : t("pages.dashboard.actions.show_contacts", "Show contacts");
  els.toggleContactsBtn.classList.toggle("is-active", state.showContacts);
  els.toggleContactsBtn.setAttribute("aria-label", els.toggleContactsBtn.title);
  els.chatMenuBtn.title = t("pages.dashboard.actions.more_chat_actions", "More chat actions");
  els.chatMenuBtn.setAttribute("aria-label", els.chatMenuBtn.title);
  els.facePickerBtn.title = t("pages.dashboard.actions.qq_faces", "QQ faces");
  els.facePickerBtn.setAttribute("aria-label", els.facePickerBtn.title);
  els.attachmentButton.title = t("pages.dashboard.actions.upload_attachment", "Upload attachment");
  els.attachmentButton.setAttribute("aria-label", els.attachmentButton.title);
  els.memberPanelTitle.textContent = t(
    "pages.dashboard.members.panel_title",
    "Group Members"
  );
  els.sendBtn.textContent = t("pages.dashboard.composer.send", "Send");
  els.composerInput.placeholder = t(
    "pages.dashboard.composer.placeholder",
    "Type a message to the active session"
  );
  els.quoteModalCloseBtn.title = t(
    "pages.dashboard.actions.close_quote_viewer",
    "Close quote viewer"
  );
  els.quoteModalCloseBtn.setAttribute("aria-label", els.quoteModalCloseBtn.title);
}
