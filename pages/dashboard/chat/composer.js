import { apiGet, apiPost, apiUpload } from "../core/api.js";
import { els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { ensureDirectMediaUrl, pendingUploadKindLabel } from "../core/media.js";
import { setStatus } from "../core/status.js";
import { state } from "../core/state.js";
import { avatarUrl, setAvatar, text } from "../core/utils.js";
import { ensureFaceAssets, renderMessages } from "../session/messages.js";

const QQ_FACE_PANEL_PAGE_SIZE = 72;
const EMOJI_PANEL_AUTO_CLOSE_DELAY_MS = 800;
const LOCAL_MESSAGE_ID_PREFIX = "local:";
const SEND_PENDING_INDICATOR_DELAY_MS = 700;

let emojiPanelAutoCloseTimerId = 0;

function revokePreviewUrl(item) {
  const previewUrl = text(item?.preview_url).trim();
  if (previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(previewUrl);
  }
}

function activeSession() {
  return state.sessions.find((item) => item.session_id === state.activeSessionId) || null;
}

function isGroupSession() {
  return activeSession()?.message_type === "group";
}

function resetMentionState() {
  state.composerMentionActive = false;
  state.composerMentionQuery = "";
  state.composerMentionRange = null;
  state.composerMentionSuggestions = [];
  state.composerMentionActiveIndex = 0;
}

function closeMentionSuggestions() {
  resetMentionState();
  els.composerMentionSuggestions.classList.add("is-hidden");
  els.composerMentionSuggestions.replaceChildren();
}

function renderEmojiPanel() {
  els.emojiPanel.classList.toggle("is-hidden", !state.emojiPanelOpen);
  els.emojiButton.classList.toggle("is-active", state.emojiPanelOpen);
  if (state.emojiPanelOpen) {
    scheduleEmojiPanelAutoClose();
  } else {
    clearEmojiPanelAutoClose();
  }
  renderEmojiPanelContent();
}

function clearEmojiPanelAutoClose() {
  window.clearTimeout(emojiPanelAutoCloseTimerId);
  emojiPanelAutoCloseTimerId = 0;
}

function scheduleEmojiPanelAutoClose() {
  clearEmojiPanelAutoClose();
  emojiPanelAutoCloseTimerId = window.setTimeout(() => {
    emojiPanelAutoCloseTimerId = 0;
    if (
      !state.emojiPanelOpen ||
      els.emojiPanel.matches(":hover") ||
      els.emojiButton.matches(":hover")
    ) {
      return;
    }
    state.emojiPanelOpen = false;
    renderEmojiPanel();
  }, EMOJI_PANEL_AUTO_CLOSE_DELAY_MS);
}

function clearPendingUploads() {
  for (const item of state.pendingUploads) {
    revokePreviewUrl(item);
  }
  state.pendingUploads = [];
}

function replySummaryText(target) {
  const summary = text(target?.summary).trim();
  if (!summary) {
    return t("pages.dashboard.messages.empty_message", "[Empty message]");
  }
  return summary.replace(/^[^:]{1,64}:\s*/, "");
}

function clearComposerReplyTarget() {
  state.composerReplyTarget = null;
  renderComposerReplyBar();
}

export function setComposerReplyTarget(target) {
  const messageId = text(target?.message_id).trim();
  if (!messageId) {
    clearComposerReplyTarget();
    return;
  }
  state.composerReplyTarget = {
    message_id: messageId,
    user_id: text(target.user_id).trim(),
    session_id: text(target.session_id).trim(),
    summary: text(target.summary).trim(),
    sender_name:
      text(target.sender?.card || target.sender?.nickname || target.user_id).trim() ||
      t("pages.dashboard.messages.unknown_user", "Unknown User"),
  };
  renderComposerReplyBar();
}

function renderComposerReplyBar() {
  const target = state.composerReplyTarget;
  if (!target || text(target.session_id).trim() !== text(state.activeSessionId).trim()) {
    els.composerReplyBar.classList.add("is-hidden");
    els.composerReplyBar.replaceChildren();
    if (target && text(target.session_id).trim() !== text(state.activeSessionId).trim()) {
      state.composerReplyTarget = null;
    }
    return;
  }

  els.composerReplyBar.classList.remove("is-hidden");
  els.composerReplyBar.replaceChildren();

  const meta = document.createElement("button");
  meta.type = "button";
  meta.className = "composer-reply-meta";
  meta.title = t("pages.dashboard.messages.reply_jump", "Jump to message");
  meta.addEventListener("click", () => {
    const targetRow = document.querySelector(
      `.message-item[data-message-id="${CSS.escape(target.message_id)}"]`
    );
    targetRow?.scrollIntoView({ block: "center", behavior: "smooth" });
  });

  const label = document.createElement("strong");
  label.textContent = t("pages.dashboard.composer.replying_to", "Replying to");
  const textNode = document.createElement("span");
  textNode.textContent = `${target.sender_name}: ${replySummaryText(target)}`;
  meta.append(label, textNode);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "composer-reply-close";
  closeBtn.setAttribute(
    "aria-label",
    t("pages.dashboard.composer.cancel_reply", "Cancel reply")
  );
  closeBtn.title = t("pages.dashboard.composer.cancel_reply", "Cancel reply");
  closeBtn.textContent = "x";
  closeBtn.addEventListener("click", () => {
    clearComposerReplyTarget();
    focusComposer();
  });

  els.composerReplyBar.append(meta, closeBtn);
}

function setComposerEnabled(enabled) {
  els.composerInput.contentEditable = enabled ? "true" : "false";
  els.composerInput.classList.toggle("is-disabled", !enabled);
  els.composerInput.setAttribute("aria-disabled", enabled ? "false" : "true");
}

function moveCaretToEnd(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  state.composerSelectionRange = range.cloneRange();
}

function moveCaretAfter(node) {
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  state.composerSelectionRange = range.cloneRange();
}

function normalizeComposerTextNode(node) {
  if (!node || node.nodeType !== Node.TEXT_NODE) {
    return;
  }
  if (node.textContent === "") {
    node.remove();
  }
}

function normalizeComposerEditor() {
  for (const node of Array.from(els.composerInput.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      normalizeComposerTextNode(node);
    }
  }
  els.composerInput.normalize();
}

function isComposerSelectionCollapsed() {
  const selection = window.getSelection();
  return Boolean(selection?.rangeCount) && selection.isCollapsed;
}

function caretInsideComposer() {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) {
    return false;
  }
  return els.composerInput.contains(selection.anchorNode);
}

function captureComposerSelectionRange() {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !caretInsideComposer()) {
    return;
  }
  state.composerSelectionRange = selection.getRangeAt(0).cloneRange();
}

function composerInsertionRange() {
  const selection = window.getSelection();
  if (selection?.rangeCount && caretInsideComposer()) {
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(true);
    return range;
  }
  if (state.composerSelectionRange) {
    const range = state.composerSelectionRange.cloneRange();
    range.collapse(true);
    return range;
  }
  const range = document.createRange();
  range.selectNodeContents(els.composerInput);
  range.collapse(false);
  return range;
}

function filteredMentionSuggestions(query) {
  const normalized = text(query).trim().toLowerCase();
  const suggestions = isGroupSession()
    ? state.groupMembers.map((member) => ({
        user_id: text(member.user_id).trim(),
        name: text(member.card || member.nickname || member.user_id).trim(),
        role: text(member.role).trim().toLowerCase(),
      }))
    : [];
  const unique = [];
  const seen = new Set();
  for (const member of suggestions) {
    if (!member.user_id || seen.has(member.user_id)) {
      continue;
    }
    seen.add(member.user_id);
    unique.push(member);
  }
  unique.unshift({
    user_id: "all",
    name: t("pages.dashboard.composer.mention_all", "all"),
    role: "all",
  });
  if (!normalized) {
    return unique;
  }
  return unique.filter((member) => {
    const role = text(member.role).toLowerCase();
    const name = text(member.name).toLowerCase();
    return (
      member.user_id.includes(normalized) ||
      name.includes(normalized) ||
      role.includes(normalized)
    );
  });
}

function currentMentionQuery() {
  if (!isGroupSession() || !isComposerSelectionCollapsed()) {
    return null;
  }
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!els.composerInput.contains(range.startContainer)) {
    return null;
  }
  if (range.startContainer.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  const probeRange = range.cloneRange();
  probeRange.selectNodeContents(els.composerInput);
  probeRange.setEnd(range.startContainer, range.startOffset);
  const beforeText = probeRange.toString();
  const markerIndex = beforeText.lastIndexOf("@");
  if (markerIndex < 0) {
    return null;
  }
  const query = beforeText.slice(markerIndex + 1);
  if (/\s/.test(query) || query.includes("\n")) {
    return null;
  }
  const startOffset = range.startOffset - query.length - 1;
  if (startOffset < 0) {
    return null;
  }
  const mentionRange = range.cloneRange();
  mentionRange.setStart(range.startContainer, startOffset);
  mentionRange.setEnd(range.startContainer, range.startOffset);
  return { query, range: mentionRange };
}

function renderMentionSuggestions() {
  els.composerMentionSuggestions.replaceChildren();
  if (!state.composerMentionActive || !state.composerMentionSuggestions.length) {
    els.composerMentionSuggestions.classList.add("is-hidden");
    return;
  }
  els.composerMentionSuggestions.classList.remove("is-hidden");
  state.composerMentionSuggestions.forEach((member, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `composer-mention-option${
      index === state.composerMentionActiveIndex ? " is-active" : ""
    }`;
    const avatar = document.createElement("span");
    avatar.className = `composer-mention-option-avatar${
      member.user_id === "all" ? " is-all" : ""
    }`;
    if (member.user_id === "all") {
      avatar.textContent = "@";
    } else {
      setAvatar(
        avatar,
        avatarUrl(member.user_id, "private"),
        text(member.name).slice(0, 1).toUpperCase()
      );
    }
    const copy = document.createElement("span");
    copy.className = "composer-mention-option-copy";
    const name = document.createElement("span");
    name.className = "composer-mention-option-name";
    name.textContent = member.user_id === "all" ? "@all" : member.name;
    const meta = document.createElement("span");
    meta.className = "composer-mention-option-meta";
    meta.textContent =
      member.user_id === "all"
        ? t("pages.dashboard.composer.mention_all_hint", "Mention everyone")
        : `QQ ${member.user_id}`;
    copy.append(name, meta);
    button.append(avatar, copy);
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      insertMentionToken(member);
    });
    els.composerMentionSuggestions.append(button);
  });
}

function visibleFaceCatalogIds() {
  return state.qqFaceCatalogIds.slice(0, state.qqFacePanelLimit);
}

function expandFacePanel() {
  if (state.qqFacePanelLimit >= state.qqFaceCatalogIds.length) {
    return false;
  }
  state.qqFacePanelLimit = Math.min(
    state.qqFacePanelLimit + QQ_FACE_PANEL_PAGE_SIZE,
    state.qqFaceCatalogIds.length
  );
  return true;
}

function syncComposerFaceToken(faceId) {
  const faceUrl = state.qqFaceCache.get(faceId) || "";
  if (!faceUrl) {
    return;
  }
  for (const token of els.composerInput.querySelectorAll(".composer-face-token")) {
    if (text(token.dataset.faceId).trim() !== faceId || token.querySelector("img")) {
      continue;
    }
    token.textContent = "";
    const img = document.createElement("img");
    img.alt = t("pages.dashboard.attachments.qq_face_alt", "[QQ Face]");
    img.src = faceUrl;
    token.append(img);
  }
}

function insertFaceToken(faceId) {
  const cleanFaceId = text(faceId).trim();
  if (!cleanFaceId || els.composerInput.contentEditable !== "true") {
    return;
  }
  const range = composerInsertionRange();
  range.deleteContents();
  const token = document.createElement("span");
  token.className = "composer-face-token";
  token.contentEditable = "false";
  token.dataset.faceId = cleanFaceId;

  const faceUrl = state.qqFaceCache.get(cleanFaceId) || "";
  if (faceUrl) {
    const img = document.createElement("img");
    img.alt = t("pages.dashboard.attachments.qq_face_alt", "[QQ Face]");
    img.src = faceUrl;
    token.append(img);
  } else {
    token.textContent = cleanFaceId;
  }

  range.insertNode(token);
  moveCaretAfter(token);
  normalizeComposerEditor();
  els.composerInput.focus();
  void ensureFaceAssets([cleanFaceId], { rerenderMessages: false }).then(() => {
    syncComposerFaceToken(cleanFaceId);
    if (state.emojiPanelOpen) {
      renderEmojiPanelContent();
    }
  });
}

function renderEmojiPanelContent() {
  els.emojiPanel.replaceChildren();

  const title = document.createElement("div");
  title.className = "emoji-panel-title";
  title.textContent = t("pages.dashboard.composer.face_title", "QQ Face");
  els.emojiPanel.append(title);

  const body = document.createElement("div");
  body.className = "emoji-panel-body";
  els.emojiPanel.append(body);

  if (!state.emojiPanelOpen) {
    return;
  }
  if (state.qqFaceCatalogLoading) {
    body.textContent = t("pages.dashboard.composer.face_loading", "Loading faces...");
    return;
  }
  if (state.qqFaceCatalogError) {
    body.textContent = state.qqFaceCatalogError;
    return;
  }
  if (!state.qqFaceCatalogReady) {
    body.textContent = t("pages.dashboard.composer.face_loading", "Loading faces...");
    return;
  }
  if (!state.qqFaceCatalogIds.length) {
    body.textContent = t("pages.dashboard.composer.face_empty", "No faces available.");
    return;
  }

  const grid = document.createElement("div");
  grid.className = "emoji-grid";
  body.append(grid);

  const visibleIds = visibleFaceCatalogIds();
  for (const faceId of visibleIds) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "emoji-option";
    option.title = `Face ${faceId}`;
    option.dataset.faceId = faceId;

    const faceUrl = state.qqFaceCache.get(faceId) || "";
    if (faceUrl) {
      const img = document.createElement("img");
      img.alt = t("pages.dashboard.attachments.qq_face_alt", "[QQ Face]");
      img.src = faceUrl;
      option.append(img);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "emoji-option-placeholder";
      placeholder.textContent = faceId;
      option.append(placeholder);
    }

    option.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    option.addEventListener("click", (event) => {
      event.preventDefault();
      insertFaceToken(faceId);
    });
    grid.append(option);
  }

  const pendingIds = visibleIds.filter(
    (faceId) =>
      !state.qqFaceCache.has(faceId) &&
      !state.qqFacePendingIds.has(faceId) &&
      !state.qqFaceMissingIds.has(faceId)
  );
  if (pendingIds.length) {
    void ensureFaceAssets(pendingIds, { rerenderMessages: false }).then(() => {
      for (const faceId of pendingIds) {
        syncComposerFaceToken(faceId);
      }
      if (state.emojiPanelOpen) {
        renderEmojiPanelContent();
      }
    });
  }
}

async function ensureFaceCatalog() {
  if (state.qqFaceCatalogReady || state.qqFaceCatalogLoading) {
    return;
  }
  state.qqFaceCatalogLoading = true;
  state.qqFaceCatalogError = "";
  renderEmojiPanelContent();
  try {
    const data = await apiGet("page/face-index");
    state.qqFaceCatalogIds = (Array.isArray(data.items) ? data.items : [])
      .map((item) => text(item).trim())
      .filter((item) => item && /^\d+$/.test(item));
    state.qqFaceCatalogReady = true;
    state.qqFacePanelLimit = Math.min(QQ_FACE_PANEL_PAGE_SIZE, state.qqFaceCatalogIds.length);
  } catch (error) {
    state.qqFaceCatalogError =
      error.message || t("pages.dashboard.composer.face_load_failed", "Failed to load faces.");
  } finally {
    state.qqFaceCatalogLoading = false;
    renderEmojiPanelContent();
  }
}

function updateMentionSuggestions() {
  const mention = currentMentionQuery();
  if (!mention) {
    closeMentionSuggestions();
    return;
  }
  const suggestions = filteredMentionSuggestions(mention.query);
  if (!suggestions.length) {
    closeMentionSuggestions();
    return;
  }
  state.composerMentionActive = true;
  state.composerMentionQuery = mention.query;
  state.composerMentionRange = mention.range;
  state.composerMentionSuggestions = suggestions;
  state.composerMentionActiveIndex = 0;
  renderMentionSuggestions();
}

function insertMentionToken(member) {
  if (!state.composerMentionRange) {
    return;
  }
  state.composerMentionRange.deleteContents();
  const token = document.createElement("span");
  token.className = "composer-mention-token";
  token.contentEditable = "false";
  token.dataset.qq = member.user_id;
  token.dataset.name = member.name;
  token.textContent = member.user_id === "all" ? "@all" : member.name;
  state.composerMentionRange.insertNode(token);
  const spacer = document.createTextNode(" ");
  token.after(spacer);
  moveCaretAfter(spacer);
  normalizeComposerEditor();
  closeMentionSuggestions();
}

function appendTextSegment(segments, value) {
  if (!value) {
    return;
  }
  const previous = segments.at(-1);
  if (previous?.type === "text") {
    previous.data.text += value;
    return;
  }
  segments.push({ type: "text", data: { text: value } });
}

function composerSegments() {
  const segments = [];
  for (const node of els.composerInput.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      appendTextSegment(segments, node.textContent || "");
      continue;
    }
    if (
      node.nodeType === Node.ELEMENT_NODE &&
      node.classList.contains("composer-mention-token")
    ) {
      const qq = text(node.dataset.qq).trim();
      if (qq) {
        segments.push({
          type: "at",
          data: {
            qq,
            name: text(node.dataset.name).trim() || qq,
          },
        });
      }
      continue;
    }
    if (
      node.nodeType === Node.ELEMENT_NODE &&
      node.classList.contains("composer-face-token")
    ) {
      const faceId = text(node.dataset.faceId).trim();
      if (faceId) {
        segments.push({
          type: "face",
          data: {
            id: faceId,
          },
        });
      }
      continue;
    }
    appendTextSegment(segments, node.textContent || "");
  }
  return segments.filter(
    (segment) => segment.type !== "text" || text(segment.data?.text) !== ""
  );
}

function composerHasContent() {
  return composerSegments().some((segment) => {
    if (segment.type === "text") {
      return text(segment.data?.text).trim() !== "";
    }
    return true;
  });
}

function buildLocalMessageSummary(segments) {
  const parts = [];
  for (const segment of segments) {
    const segType = text(segment?.type).trim().toLowerCase();
    const data = segment?.data && typeof segment.data === "object" ? segment.data : {};
    if (segType === "reply") {
      continue;
    }
    if (segType === "text") {
      const value = text(data.text).replace(/\s+/g, " ");
      if (value.trim()) {
        parts.push(value);
      }
      continue;
    }
    if (segType === "at") {
      parts.push(`@${text(data.name || data.qq).trim()} `);
      continue;
    }
    if (segType === "face") {
      parts.push("[Face]");
      continue;
    }
    if (segType === "image") {
      parts.push("[Image]");
      continue;
    }
    if (segType === "video") {
      parts.push("[Video]");
      continue;
    }
    if (segType === "record") {
      parts.push("[Record]");
      continue;
    }
    if (segType === "file") {
      parts.push(`[File:${text(data.name).trim() || "file"}]`);
    }
  }
  return (
    parts.join("").replace(/\s+/g, " ").trim() ||
    t("pages.dashboard.messages.empty_message", "[Empty message]")
  );
}

function buildOptimisticMessage(sessionId, message) {
  state.sendQueueSequence += 1;
  const [messageType, targetId = ""] = text(sessionId).trim().split(":");
  const selfId = text(state.status?.login?.user_id).trim();
  const nickname =
    text(state.status?.login?.nickname).trim() ||
    t("pages.dashboard.messages.me", "Me");
  const summary = buildLocalMessageSummary(message);
  const messageId = `${LOCAL_MESSAGE_ID_PREFIX}${Date.now().toString(36)}-${state.sendQueueSequence}`;
  return {
    self_id: selfId,
    user_id: selfId,
    time: Math.floor(Date.now() / 1000),
    is_self: true,
    message_id: messageId,
    post_type: "message",
    message_type: messageType,
    sub_type: "normal",
    group_id: messageType === "group" ? targetId : "",
    raw_message: summary,
    message,
    sender: {
      user_id: selfId,
      nickname,
      card: nickname,
    },
    session_id: sessionId,
    summary,
    send_status: "",
    send_error: "",
  };
}

function insertOptimisticMessage(message) {
  const rows = state.messagesBySession.get(message.session_id) || [];
  state.messagesBySession.set(message.session_id, [...rows, message]);
  if (state.activeSessionId === message.session_id) {
    renderMessages({ forceScrollToBottom: true });
  }
}

function updateOptimisticMessage(entry, sendStatus, sendError = "") {
  const rows = state.messagesBySession.get(entry.sessionId) || [];
  const next = rows.map((item) => {
    if (text(item.message_id).trim() !== entry.localMessageId) {
      return item;
    }
    return {
      ...item,
      send_status: sendStatus,
      send_error: sendError,
    };
  });
  state.messagesBySession.set(entry.sessionId, next);
  if (state.activeSessionId === entry.sessionId) {
    renderMessages();
  }
}

function isTimeoutError(error) {
  const message = text(error?.message).trim().toLowerCase();
  return message.includes("timeout") || message.includes("timed out");
}

async function processSendQueue() {
  if (state.sendQueueProcessing) {
    return;
  }
  state.sendQueueProcessing = true;
  try {
    while (state.sendQueue.length) {
      const entry = state.sendQueue[0];
      try {
        await apiPost("page/send", {
          session_id: entry.sessionId,
          message: entry.outboundMessage,
        });
        window.clearTimeout(entry.pendingIndicatorTimerId);
        updateOptimisticMessage(entry, "sent");
        setStatus(
          state.status?.login?.user_id
            ? `QQ ${state.status.login.user_id}`
            : t("pages.dashboard.status.message_sent", "Message sent")
        );
      } catch (error) {
        window.clearTimeout(entry.pendingIndicatorTimerId);
        const sendError =
          error?.message || t("pages.dashboard.status.send_failed", "Send failed.");
        updateOptimisticMessage(
          entry,
          isTimeoutError(error) ? "timeout" : "failed",
          sendError
        );
        setStatus(sendError);
      } finally {
        state.sendQueue.shift();
      }
    }
  } finally {
    state.sendQueueProcessing = false;
    updateSendAvailability();
    if (state.sendQueue.length) {
      void processSendQueue();
    }
  }
}

export function retryOptimisticMessage(messageId) {
  const localMessageId = text(messageId).trim();
  if (!localMessageId) {
    return false;
  }
  let sessionId = "";
  let targetMessage = null;
  for (const [candidateSessionId, rows] of state.messagesBySession.entries()) {
    targetMessage = rows.find(
      (item) => text(item.message_id).trim() === localMessageId
    );
    if (targetMessage) {
      sessionId = candidateSessionId;
      break;
    }
  }
  const sendStatus = text(targetMessage?.send_status).trim();
  const outboundMessage = Array.isArray(targetMessage?.send_payload)
    ? targetMessage.send_payload
    : [];
  if (
    !sessionId ||
    !["failed", "timeout"].includes(sendStatus) ||
    !outboundMessage.length ||
    state.sendQueue.some((entry) => entry.localMessageId === localMessageId)
  ) {
    return false;
  }
  updateOptimisticMessage({ sessionId, localMessageId }, "");
  const pendingIndicatorTimerId = window.setTimeout(() => {
    updateOptimisticMessage({ sessionId, localMessageId }, "sending");
  }, SEND_PENDING_INDICATOR_DELAY_MS);
  state.sendQueue.push({
    sessionId,
    localMessageId,
    outboundMessage,
    pendingIndicatorTimerId,
  });
  setStatus(t("pages.dashboard.status.retrying_send", "Retrying send..."));
  void processSendQueue();
  return true;
}

export function clearComposerEditor() {
  els.composerInput.replaceChildren();
  state.composerSelectionRange = null;
  clearComposerReplyTarget();
  closeMentionSuggestions();
  state.emojiPanelOpen = false;
  renderEmojiPanel();
}

export function focusComposer() {
  if (els.composerInput.contentEditable !== "true") {
    return;
  }
  els.composerInput.focus();
  moveCaretToEnd(els.composerInput);
}

export function refreshComposerPlaceholder() {
  const placeholder = t(
    "pages.dashboard.composer.placeholder",
    "Type a message to the active session"
  );
  els.composerInput.dataset.placeholder = placeholder;
  els.composerInput.setAttribute("aria-label", placeholder);
}

export function updateSendAvailability() {
  const enabled = Boolean(state.activeSessionId);
  const recordingLocked = state.isRecording || state.recordingBusy;
  setComposerEnabled(enabled && !state.recordingBusy);
  els.emojiButton.disabled = !enabled || recordingLocked;
  els.attachmentInput.disabled = !enabled || recordingLocked;
  if (els.recordButton) {
    els.recordButton.disabled =
      state.recordingBusy || (!enabled && !state.isRecording);
  }
  els.sendBtn.disabled = !enabled || recordingLocked;
  if (!enabled || state.recordingBusy) {
    closeMentionSuggestions();
    state.emojiPanelOpen = false;
    renderEmojiPanel();
  }
}

export async function renderComposerPreview() {
  if (!state.pendingUploads.length) {
    els.composerPreview.classList.add("is-hidden");
    els.composerPreview.replaceChildren();
    return;
  }
  els.composerPreview.classList.remove("is-hidden");
  els.composerPreview.replaceChildren();
  for (const item of state.pendingUploads) {
    const chip = document.createElement("div");
    chip.className = "preview-chip";
    if (item.type === "image") {
      const previewUrl =
        text(item.preview_url).trim() ||
        text(item.url).trim() ||
        (await ensureDirectMediaUrl(item));
      const img = document.createElement("img");
      img.alt = item.name || t("pages.dashboard.attachments.image_alt", "image");
      img.src = previewUrl;
      chip.append(img);
    } else {
      const label = document.createElement("div");
      label.className = "preview-chip-label";
      label.textContent = pendingUploadKindLabel(item);
      chip.append(label);
    }
    const name = document.createElement("span");
    name.className = "preview-chip-name";
    name.textContent = item.name || pendingUploadKindLabel(item);
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "preview-remove";
    removeBtn.textContent = "x";
    removeBtn.addEventListener("click", () => {
      revokePreviewUrl(item);
      state.pendingUploads = state.pendingUploads.filter((entry) => entry.key !== item.key);
      void renderComposerPreview();
    });
    chip.append(name, removeBtn);
    els.composerPreview.append(chip);
  }
}

export async function uploadSelectedMedia(files, buildSuccessMessage) {
  els.sendBtn.disabled = true;
  try {
    const uploadedMedia = [];
    for (const file of files) {
      const uploaded = await apiUpload("page/media/upload", file);
      if (uploaded.type === "image") {
        uploaded.preview_url = URL.createObjectURL(file);
      }
      uploadedMedia.push(uploaded);
    }
    state.pendingUploads = [...state.pendingUploads, ...uploadedMedia];
    await renderComposerPreview();
    setStatus(buildSuccessMessage(uploadedMedia));
  } catch (error) {
    setStatus(
      error.message ||
        t("pages.dashboard.status.attachment_upload_failed", "Attachment upload failed.")
    );
  } finally {
    updateSendAvailability();
  }
}

export async function sendMessage() {
  const message = composerSegments();
  const hasTextOrMentions = message.some((segment) => {
    if (segment.type === "text") {
      return text(segment.data?.text).trim() !== "";
    }
    return true;
  });
  if (!state.activeSessionId || (!hasTextOrMentions && !state.pendingUploads.length)) {
    return;
  }
  const sessionId = state.activeSessionId;
  const uploads = [...state.pendingUploads];
  const outboundMessage = [];
  const displayMessage = [];
  const optimisticPreviewUrls = [];
  const replyId = text(state.composerReplyTarget?.message_id).trim();
  if (replyId) {
    const replySegment = {
      type: "reply",
      data: {
        id: replyId,
      },
    };
    outboundMessage.push(replySegment);
    displayMessage.push(replySegment);
  }
  outboundMessage.push(...message);
  displayMessage.push(...message);
  for (const item of uploads) {
    const data = { file: item.key };
    if (item.type === "file" && item.name) {
      data.name = item.name;
    }
    outboundMessage.push({ type: item.type, data });

    const previewUrl =
      text(item.preview_url).trim() || text(item.url).trim() || text(item.key).trim();
    const displayData = {
      file: previewUrl,
      url: previewUrl,
    };
    if (item.name) {
      displayData.name = item.name;
    }
    displayMessage.push({ type: item.type, data: displayData });
    if (previewUrl.startsWith("blob:")) {
      optimisticPreviewUrls.push(previewUrl);
    }
  }
  const optimisticMessage = {
    ...buildOptimisticMessage(sessionId, displayMessage),
    send_payload: outboundMessage,
  };
  if (optimisticPreviewUrls.length) {
    state.optimisticPreviewUrlsByMessageId.set(
      optimisticMessage.message_id,
      optimisticPreviewUrls
    );
  }
  insertOptimisticMessage(optimisticMessage);
  const pendingIndicatorTimerId = window.setTimeout(() => {
    updateOptimisticMessage(
      {
        sessionId,
        localMessageId: optimisticMessage.message_id,
      },
      "sending"
    );
  }, SEND_PENDING_INDICATOR_DELAY_MS);
  state.sendQueue.push({
    sessionId,
    localMessageId: optimisticMessage.message_id,
    outboundMessage,
    pendingIndicatorTimerId,
  });
  state.pendingUploads = [];
  clearComposerEditor();
  await renderComposerPreview();
  updateSendAvailability();
  focusComposer();
  void processSendQueue();
}

export function bindComposerEvents() {
  refreshComposerPlaceholder();
  renderComposerReplyBar();
  renderEmojiPanel();

  els.composerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendMessage();
  });

  els.composerInput.addEventListener("keydown", async (event) => {
    if (state.composerMentionActive) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        state.composerMentionActiveIndex =
          (state.composerMentionActiveIndex + 1) % state.composerMentionSuggestions.length;
        renderMentionSuggestions();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        state.composerMentionActiveIndex =
          (state.composerMentionActiveIndex - 1 + state.composerMentionSuggestions.length) %
          state.composerMentionSuggestions.length;
        renderMentionSuggestions();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertMentionToken(
          state.composerMentionSuggestions[state.composerMentionActiveIndex]
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMentionSuggestions();
        return;
      }
    }

    if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
      return;
    }
    event.preventDefault();
    if (els.sendBtn.disabled || !composerHasContent() && !state.pendingUploads.length) {
      return;
    }
    await sendMessage();
  });

  els.composerInput.addEventListener("input", () => {
    normalizeComposerEditor();
    captureComposerSelectionRange();
    updateMentionSuggestions();
  });

  els.composerInput.addEventListener("click", () => {
    captureComposerSelectionRange();
    updateMentionSuggestions();
  });

  els.composerInput.addEventListener("paste", async (event) => {
    const mediaFiles = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!mediaFiles.length) {
      return;
    }
    event.preventDefault();
    await uploadSelectedMedia(
      mediaFiles,
      (uploadedMedia) =>
        uploadedMedia.length === 1
          ? t("pages.dashboard.status.pasted_one", "Pasted attachment: {name}").replace(
              "{name}",
              uploadedMedia[0].name || "clipboard-file"
            )
          : t("pages.dashboard.status.pasted_many", "Pasted {count} attachments").replace(
              "{count}",
              String(uploadedMedia.length)
            )
    );
  });

  els.attachmentInput.addEventListener("change", async () => {
    const files = Array.from(els.attachmentInput.files || []);
    if (!files.length) {
      return;
    }
    try {
      await uploadSelectedMedia(
        files,
        (uploadedMedia) =>
          uploadedMedia.length === 1
            ? t("pages.dashboard.status.selected_one", "Selected attachment: {name}").replace(
                "{name}",
                uploadedMedia[0].name
              )
            : t("pages.dashboard.status.selected_many", "Selected {count} attachments").replace(
                "{count}",
                String(uploadedMedia.length)
              )
      );
    } finally {
      els.attachmentInput.value = "";
    }
  });

  els.emojiButton.addEventListener("click", async () => {
    state.emojiPanelOpen = !state.emojiPanelOpen;
    renderEmojiPanel();
    if (state.emojiPanelOpen) {
      await ensureFaceCatalog();
    }
  });

  els.emojiPanel.addEventListener("scroll", () => {
    if (
      els.emojiPanel.scrollTop + els.emojiPanel.clientHeight <
      els.emojiPanel.scrollHeight - 36
    ) {
      return;
    }
    if (expandFacePanel()) {
      renderEmojiPanelContent();
    }
  });

  els.emojiPanel.addEventListener("mouseenter", () => {
    clearEmojiPanelAutoClose();
  });

  els.emojiPanel.addEventListener("mouseleave", () => {
    if (state.emojiPanelOpen) {
      scheduleEmojiPanelAutoClose();
    }
  });

  els.emojiButton.addEventListener("mouseenter", () => {
    if (state.emojiPanelOpen) {
      clearEmojiPanelAutoClose();
    }
  });

  els.emojiButton.addEventListener("mouseleave", () => {
    if (state.emojiPanelOpen && !els.emojiPanel.matches(":hover")) {
      scheduleEmojiPanelAutoClose();
    }
  });

  document.addEventListener("selectionchange", () => {
    if (!caretInsideComposer()) {
      closeMentionSuggestions();
      return;
    }
    captureComposerSelectionRange();
    updateMentionSuggestions();
  });

  document.addEventListener("click", (event) => {
    if (
      event.target !== els.composerInput &&
      !els.composerInput.contains(event.target) &&
      !els.composerMentionSuggestions.contains(event.target) &&
      event.target !== els.emojiButton &&
      !els.emojiButton.contains(event.target) &&
      !els.emojiPanel.contains(event.target)
    ) {
      closeMentionSuggestions();
      state.emojiPanelOpen = false;
      renderEmojiPanel();
    }
  });
}

window.addEventListener("beforeunload", () => {
  clearPendingUploads();
  for (const previewUrls of state.optimisticPreviewUrlsByMessageId.values()) {
    for (const previewUrl of previewUrls) {
      URL.revokeObjectURL(previewUrl);
    }
  }
  state.optimisticPreviewUrlsByMessageId.clear();
});
