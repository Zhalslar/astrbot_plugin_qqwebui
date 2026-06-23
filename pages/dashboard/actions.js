import { apiPost } from "./api.js";
import { els } from "./dom.js";
import { t } from "./i18n.js";
import { hydrateMessageAttachments, hydrateMessageSegments } from "./media.js";
import { renderComposerPreview, updateSendAvailability } from "./renderers/composer.js";
import { renderMembers } from "./renderers/members.js";
import { closeQuoteModal, renderMessages } from "./renderers/messages.js";
import { renderSessions } from "./renderers/sidebar.js";
import {
  loadGroupMembers,
  loadMessages,
  loadSessions,
  showLoadingMessages,
} from "./services/page-data.js";
import { setStatus } from "./status.js";
import { state } from "./store.js";

export async function openSession(sessionId) {
  closeQuoteModal();
  state.faceWarmupPaused = true;
  try {
    state.activeSessionId = sessionId;
    state.pendingAttachments = [];
    await renderComposerPreview();
    renderSessions(openSession);
    const cached = state.messagesBySession.get(sessionId) || [];
    if (cached.length) {
      renderMessages({ forceScrollToBottom: true });
      void loadMessages(sessionId);
    } else {
      showLoadingMessages();
      await loadMessages(sessionId);
    }
    await apiPost("page/read", { session_id: sessionId });
    await loadSessions();
    await loadGroupMembers(false);
  } finally {
    state.faceWarmupPaused = false;
  }
}

export async function sendMessage() {
  const value = els.composerInput.value.trim();
  if (!state.activeSessionId || (!value && !state.pendingAttachments.length)) {
    return;
  }
  els.sendBtn.disabled = true;
  try {
    const data = await apiPost("page/send", {
      session_id: state.activeSessionId,
      text: value,
      attachments: state.pendingAttachments.map((item) => item.key),
    });
    const hydrated = await hydrateMessageSegments(
      await hydrateMessageAttachments([data.message])
    );
    const existing = state.messagesBySession.get(state.activeSessionId) || [];
    state.messagesBySession.set(state.activeSessionId, [...existing, ...hydrated]);
    els.composerInput.value = "";
    state.pendingAttachments = [];
    await renderComposerPreview();
    renderMessages({ forceScrollToBottom: true });
    await loadSessions();
    setStatus(
      state.status?.login?.user_id
        ? `QQ ${state.status.login.user_id}`
        : t("pages.dashboard.status.message_sent", "Message sent")
    );
  } catch (error) {
    setStatus(error.message || t("pages.dashboard.status.send_failed", "Send failed."));
  } finally {
    updateSendAvailability();
  }
}

export function resetActiveSessionView() {
  state.activeSessionId = "";
  renderSessions(openSession);
  renderMessages();
  renderMembers();
  updateSendAvailability();
}
