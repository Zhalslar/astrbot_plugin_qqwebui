import { openSession, resetActiveSessionView, sendMessage } from "./actions.js";
import { apiUpload } from "./api.js";
import { bridge, els, MAX_ATTACHMENT_SIZE } from "./dom.js";
import { renderStaticText, syncLocaleFromContext, t } from "./i18n.js";
import { ensureMediaObjectUrl } from "./media.js";
import {
  renderComposerPreview,
  renderFacePicker,
  updateSendAvailability,
} from "./renderers/composer.js";
import { renderMembers } from "./renderers/members.js";
import { closeQuoteModal, renderMessages } from "./renderers/messages.js";
import { renderContacts, renderSessions } from "./renderers/sidebar.js";
import {
  getSessionSummary,
  loadGroupMembers,
  loadMessages,
  loadContacts,
  loadFaces,
  loadSessions,
  loadStatus,
  registerOpenSessionAction,
} from "./services/page-data.js";
import { setStatus } from "./status.js";
import { state } from "./store.js";
import { text } from "./utils.js";

function applyMessageBounce() {
  els.messageListContent.style.transform = state.messageBounceOffset
    ? `translateY(${state.messageBounceOffset}px)`
    : "";
}

function setMessageBounceOffset(nextOffset) {
  const limited = Math.max(-180, Math.min(180, nextOffset));
  state.messageBounceOffset = limited;
  applyMessageBounce();
}

function releaseMessageBounce() {
  window.clearTimeout(state.messageBounceTimerId);
  window.clearTimeout(state.messageWheelIdleTimerId);
  if (!state.messageBounceOffset) {
    els.messageListContent.style.transform = "";
    return;
  }
  els.messageListContent.classList.add("is-bouncing");
  setMessageBounceOffset(0);
  state.messageBounceTimerId = window.setTimeout(() => {
    els.messageListContent.classList.remove("is-bouncing");
  }, 360);
}

function handleMessageBoundary(deltaY) {
  const maxScrollTop = Math.max(0, els.messageList.scrollHeight - els.messageList.clientHeight);
  const atTop = els.messageList.scrollTop <= 0;
  const atBottom = els.messageList.scrollTop >= maxScrollTop - 1;
  if ((deltaY < 0 && atTop) || (deltaY > 0 && atBottom)) {
    setMessageBounceOffset(state.messageBounceOffset - deltaY * 0.18);
    return true;
  }
  if (state.messageBounceOffset) {
    releaseMessageBounce();
  }
  return false;
}

function rerenderAll() {
  renderStaticText();
  renderSessions(openSession);
  renderContacts(openSession);
  renderMessages();
  renderMembers();
  void renderFacePicker(loadSessions, renderMessages);
  void renderComposerPreview();
}

function bindEvents() {
  els.messageList.addEventListener(
    "wheel",
    (event) => {
      if (handleMessageBoundary(event.deltaY)) {
        window.clearTimeout(state.messageWheelIdleTimerId);
        state.messageWheelIdleTimerId = window.setTimeout(() => {
          releaseMessageBounce();
        }, 90);
        event.preventDefault();
        return;
      }
      window.clearTimeout(state.messageWheelIdleTimerId);
    },
    { passive: false }
  );

  els.messageList.addEventListener("touchstart", (event) => {
    const touch = event.changedTouches[0];
    state.messageTouchId = touch?.identifier ?? null;
    state.messageTouchLastY = touch?.clientY ?? 0;
    window.clearTimeout(state.messageBounceTimerId);
    els.messageList.classList.remove("is-bouncing");
  });

  els.messageList.addEventListener(
    "touchmove",
    (event) => {
      const touch = Array.from(event.changedTouches).find(
        (item) => item.identifier === state.messageTouchId
      );
      if (!touch) {
        return;
      }
      const deltaY = state.messageTouchLastY - touch.clientY;
      state.messageTouchLastY = touch.clientY;
      if (handleMessageBoundary(deltaY)) {
        event.preventDefault();
      }
    },
    { passive: false }
  );

  els.messageList.addEventListener("touchend", () => {
    state.messageTouchId = null;
    state.messageTouchLastY = 0;
    releaseMessageBounce();
  });

  els.messageList.addEventListener("touchcancel", () => {
    state.messageTouchId = null;
    state.messageTouchLastY = 0;
    releaseMessageBounce();
  });

  els.sessionSearchInput.addEventListener("input", async () => {
    state.sessionKeyword = els.sessionSearchInput.value.trim();
    await loadSessions();
    await loadContacts(false);
  });

  els.composerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendMessage();
  });

  els.composerInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
      return;
    }
    event.preventDefault();
    if (els.sendBtn.disabled) {
      return;
    }
    await sendMessage();
  });

  els.composerInput.addEventListener("paste", async (event) => {
    const attachmentFiles = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!attachmentFiles.length) {
      return;
    }
    event.preventDefault();
    els.sendBtn.disabled = true;
    try {
      const uploadedItems = [];
      for (const file of attachmentFiles) {
        if (file.size > MAX_ATTACHMENT_SIZE) {
          continue;
        }
        const uploaded = await apiUpload("page/upload", file);
        if (text(uploaded.kind).trim().toLowerCase() === "image") {
          uploaded.preview_url = await ensureMediaObjectUrl({ media_key: uploaded.key });
        }
        uploadedItems.push(uploaded);
      }
      state.pendingAttachments = [...state.pendingAttachments, ...uploadedItems];
      await renderComposerPreview();
      if (!uploadedItems.length) {
        setStatus(
          t(
            "pages.dashboard.status.paste_ignored_large",
            "Ignored pasted attachments larger than 15 MB."
          )
        );
      } else {
        setStatus(
          uploadedItems.length === 1
            ? t("pages.dashboard.status.pasted_one", "Pasted attachment: {name}").replace(
                "{name}",
                uploadedItems[0].name || "clipboard-file"
              )
            : t("pages.dashboard.status.pasted_many", "Pasted {count} attachments").replace(
                "{count}",
                String(uploadedItems.length)
              )
        );
      }
    } catch (error) {
      setStatus(
        error.message ||
          t("pages.dashboard.status.attachment_paste_failed", "Attachment paste failed.")
      );
    } finally {
      updateSendAvailability();
    }
  });

  els.attachmentInput.addEventListener("change", async () => {
    const files = Array.from(els.attachmentInput.files || []);
    if (!files.length) {
      return;
    }
    els.sendBtn.disabled = true;
    try {
      const uploadedItems = [];
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_SIZE) {
          continue;
        }
        const uploaded = await apiUpload("page/upload", file);
        if (text(uploaded.kind).trim().toLowerCase() === "image") {
          uploaded.preview_url = await ensureMediaObjectUrl({ media_key: uploaded.key });
        }
        uploadedItems.push(uploaded);
      }
      state.pendingAttachments = [...state.pendingAttachments, ...uploadedItems];
      await renderComposerPreview();
      if (!uploadedItems.length) {
        setStatus(
          t(
            "pages.dashboard.status.upload_ignored_large",
            "Ignored attachments larger than 15 MB."
          )
        );
      } else {
        setStatus(
          uploadedItems.length === 1
            ? t("pages.dashboard.status.selected_one", "Selected attachment: {name}").replace(
                "{name}",
                uploadedItems[0].name
              )
            : t("pages.dashboard.status.selected_many", "Selected {count} attachments").replace(
                "{count}",
                String(uploadedItems.length)
              )
        );
      }
    } catch (error) {
      setStatus(
        error.message ||
          t("pages.dashboard.status.attachment_upload_failed", "Attachment upload failed.")
      );
    } finally {
      els.attachmentInput.value = "";
      updateSendAvailability();
    }
  });

  els.facePickerBtn.addEventListener("click", async () => {
    window.clearTimeout(state.facePickerCloseTimerId);
    if (!state.faces.length) {
      await loadFaces();
    }
    state.facePickerPinned = !state.facePickerPinned;
    els.facePickerWrap.classList.toggle("is-open", state.facePickerPinned);
    els.facePickerWrap.classList.toggle("is-pinned", state.facePickerPinned);
    els.facePickerPanel.classList.toggle("is-hidden", !state.facePickerPinned);
    els.facePickerPanel.setAttribute("aria-hidden", state.facePickerPinned ? "false" : "true");
  });

  els.facePickerWrap.addEventListener("mouseenter", async () => {
    window.clearTimeout(state.facePickerCloseTimerId);
    if (!state.faces.length) {
      await loadFaces();
    }
    els.facePickerWrap.classList.add("is-open");
    els.facePickerPanel.classList.remove("is-hidden");
    els.facePickerPanel.setAttribute("aria-hidden", "false");
  });

  els.facePickerWrap.addEventListener("mouseleave", () => {
    if (state.facePickerPinned) {
      return;
    }
    window.clearTimeout(state.facePickerCloseTimerId);
    state.facePickerCloseTimerId = window.setTimeout(() => {
      if (state.facePickerPinned) {
        return;
      }
      els.facePickerWrap.classList.remove("is-open");
      els.facePickerPanel.classList.add("is-hidden");
      els.facePickerPanel.setAttribute("aria-hidden", "true");
    }, 180);
  });

  els.toggleContactsBtn.addEventListener("click", () => {
    state.showContacts = !state.showContacts;
    els.toggleContactsBtn.classList.toggle("is-active", state.showContacts);
    renderStaticText();
    renderSessions(openSession);
    renderContacts(openSession);
  });

  els.quoteModalBackdrop.addEventListener("click", () => {
    closeQuoteModal();
  });

  els.quoteModalCloseBtn.addEventListener("click", () => {
    closeQuoteModal();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.quoteModal.classList.contains("is-hidden")) {
      closeQuoteModal();
      return;
    }
    if (event.key === "Escape" && !els.facePickerPanel.classList.contains("is-hidden")) {
      window.clearTimeout(state.facePickerCloseTimerId);
      state.facePickerPinned = false;
      els.facePickerWrap.classList.remove("is-open", "is-pinned");
      els.facePickerPanel.classList.add("is-hidden");
      els.facePickerPanel.setAttribute("aria-hidden", "true");
    }
  });

  document.addEventListener("click", (event) => {
    if (els.facePickerWrap.contains(event.target)) {
      return;
    }
    window.clearTimeout(state.facePickerCloseTimerId);
    state.facePickerPinned = false;
    els.facePickerWrap.classList.remove("is-open", "is-pinned");
    els.facePickerPanel.classList.add("is-hidden");
    els.facePickerPanel.setAttribute("aria-hidden", "true");
  });
}

async function startPolling() {
  window.clearInterval(state.pollTimerId);
  state.pollTimerId = window.setInterval(async () => {
    try {
      await loadStatus();
      await loadSessions();
      if (state.activeSessionId) {
        const activeSession = getSessionSummary(state.activeSessionId);
        const cached = state.messagesBySession.get(state.activeSessionId) || [];
        const cachedLastMessageId = cached[cached.length - 1]?.message_id || "";
        const hasNewMessage =
          !cached.length ||
          (activeSession?.last_message_id && activeSession.last_message_id !== cachedLastMessageId);
        if (hasNewMessage) {
          const changed = await loadMessages(state.activeSessionId);
          if (changed) {
            renderMessages();
          }
        }
        await loadGroupMembers(false);
      }
    } catch (error) {
      setStatus(error.message || t("pages.dashboard.status.polling_failed", "Polling failed."));
    }
  }, 4000);
}

async function init() {
  if (!window.AstrBotPluginPage) {
    setStatus("Open this page from the AstrBot plugin dashboard.");
    return;
  }
  await window.AstrBotPluginPage.ready();
  syncLocaleFromContext();
  renderStaticText();
  registerOpenSessionAction(openSession);
  bridge.onContext(() => {
    syncLocaleFromContext();
    rerenderAll();
  });
  bindEvents();
  try {
    await loadStatus();
    await loadSessions();
    await loadFaces();
    await loadContacts(false);
    await renderComposerPreview();
    updateSendAvailability();
    renderSessions(openSession);
    renderContacts(openSession);
    const savedActiveSessionId = String(state.status?.ui?.last_active_session_id ?? "").trim();
    if (savedActiveSessionId) {
      try {
        await openSession(savedActiveSessionId);
      } catch {
        resetActiveSessionView();
      }
    }
    await startPolling();
  } catch (error) {
    setStatus(
      error.message || t("pages.dashboard.status.initialization_failed", "Initialization failed.")
    );
  }
}

init();
