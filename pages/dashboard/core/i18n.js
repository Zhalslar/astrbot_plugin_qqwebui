import { bridge, els } from "./dom.js";
import { state } from "./state.js";
import { refreshComposerPlaceholder } from "../chat/composer.js";
import { getLocale, text } from "./utils.js";

export function t(key, fallback = "") {
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
  els.chatMenuBtn.title = t("pages.dashboard.actions.more_chat_actions", "More chat actions");
  els.chatMenuBtn.setAttribute("aria-label", els.chatMenuBtn.title);
  els.messageJumpToUnreadBtn.title = t(
    "pages.dashboard.actions.jump_to_previous_reading_position",
    "Jump to previous reading position"
  );
  els.messageJumpToUnreadBtn.setAttribute("aria-label", els.messageJumpToUnreadBtn.title);
  els.attachmentButton.title = t("pages.dashboard.actions.upload_attachment", "Upload attachment");
  els.attachmentButton.setAttribute("aria-label", els.attachmentButton.title);
  els.emojiButton.title = t("pages.dashboard.actions.emoji", "Emoji");
  els.emojiButton.setAttribute("aria-label", els.emojiButton.title);
  els.memberPanelTitle.textContent = t(
    "pages.dashboard.members.panel_title",
    "Group Members"
  );
  els.sendBtn.textContent = t("pages.dashboard.composer.send", "Send");
  refreshComposerPlaceholder();
}
