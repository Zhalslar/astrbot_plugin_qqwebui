import { bridge } from "./core/dom.js";
import { renderStaticText, syncLocaleFromContext, t } from "./core/i18n.js";
import { setStatus } from "./core/status.js";
import { state } from "./core/state.js";
import { bindComposerEvents, renderComposerPreview, updateSendAvailability } from "./chat/composer.js";
import { loadContacts } from "./contact/service.js";
import { renderGroupMembers, setGroupMemberOpenSessionHandler } from "./contact/members.js";
import { renderContactList } from "./contact/sidebar.js";
import { connectEventStream, disconnectEventStream } from "./events/sse.js";
import { bindProfileModalEvents, renderProfileModal } from "./profile/modal.js";
import {
  bindRecorderEvents,
  cleanupRecorder,
  renderRecorderButton,
} from "./chat/recorder.js";
import { bindMessageEvents, renderMessages } from "./session/messages.js";
import {
  loadSessions,
  openSession,
  resetActiveSessionView,
  deleteSession,
  setSessionMuted,
  setSessionPinned,
  setOpenSessionHandler,
} from "./session/service.js";
import { bindSessionSidebarEvents, renderSessionList } from "./session/sidebar.js";
import { loadStatus } from "./status/service.js";

function rerenderAll() {
  renderStaticText();
  renderSessionList(openSession);
  renderContactList(openSession);
  renderMessages();
  renderGroupMembers();
  renderProfileModal();
  renderRecorderButton();
  void renderComposerPreview();
}

function bindEvents() {
  bindMessageEvents();
  bindSessionSidebarEvents({
    loadSessions,
    loadContacts: (force) => loadContacts(openSession, force),
    renderAll: rerenderAll,
    setSessionMuted,
    setSessionPinned,
    deleteSession,
  });
  bindComposerEvents();
  bindRecorderEvents();
  bindProfileModalEvents();
}

async function init() {
  if (!window.AstrBotPluginPage) {
    setStatus("Open this page from the AstrBot plugin dashboard.");
    return;
  }
  await window.AstrBotPluginPage.ready();
  syncLocaleFromContext();
  renderStaticText();
  setOpenSessionHandler(openSession);
  setGroupMemberOpenSessionHandler(openSession);
  bridge.onContext(() => {
    syncLocaleFromContext();
    rerenderAll();
  });
  window.addEventListener("qqwebui:group-profile-updated", () => {
    rerenderAll();
  });
  bindEvents();
  try {
    await loadStatus();
    await loadSessions();
    await renderComposerPreview();
    updateSendAvailability();
    renderRecorderButton();
    renderSessionList(openSession);
    const savedActiveSessionId = String(state.status?.ui?.last_active_session_id ?? "").trim();
    if (savedActiveSessionId) {
      try {
        await openSession(savedActiveSessionId);
      } catch {
        resetActiveSessionView();
      }
    }
    void loadContacts(openSession, false).catch((error) => {
      setStatus(
        error.message || t("pages.dashboard.status.initialization_failed", "Initialization failed.")
      );
    });
    await connectEventStream();
  } catch (error) {
    setStatus(
      error.message || t("pages.dashboard.status.initialization_failed", "Initialization failed.")
    );
  }
}

window.addEventListener("beforeunload", () => {
  cleanupRecorder();
  void disconnectEventStream();
});

init();
