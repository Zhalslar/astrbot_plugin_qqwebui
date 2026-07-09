import { apiGet, apiPost } from "../core/api.js";
import {
  LOCAL_MESSAGE_ID_PREFIX,
  MESSAGE_RECALL_WINDOW_SECONDS,
} from "../core/constants.js";
import { els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { renderMarkdownFragment } from "../core/markdown.js";
import { setStatus } from "../core/status.js";
import {
  hasRenderableSegmentBody,
  isAudioSegment,
  isFileSegment,
  isImageSegment,
  isVideoSegment,
  segmentKindLabel,
  segmentTextParts,
} from "../core/media.js";
import { state } from "../core/state.js";
import { avatarUrl, clampText, setAvatar, text } from "../core/utils.js";
import { buildGroupBadge, findGroupMember } from "../contact/members.js";
import {
  focusComposer,
  restoreComposerFromMessage,
  retryOptimisticMessage,
  setComposerReplyTarget,
} from "../chat/composer.js";
import { openProfileModal } from "../profile/modal.js";
import { renderSessionList } from "./sidebar.js";

const MESSAGE_BOTTOM_THRESHOLD = 24;
const MESSAGE_EXIT_CURSOR_THRESHOLD = 8;
const MESSAGE_TIME_DIVIDER_THRESHOLD = 120;
const MESSAGE_PAGE_LIMIT = 50;
const RECALL_OPTIMISTIC_HIDE_DELAY_MS = 180;
let mediaPreviewOpen = false;
let mediaPreviewType = "";
let mediaPreviewImageScale = 1;
let mediaPreviewImageOffsetX = 0;
let mediaPreviewImageOffsetY = 0;
let mediaPreviewDragging = false;
let mediaPreviewDragged = false;
let mediaPreviewDragPointerId = null;
let mediaPreviewDragStartX = 0;
let mediaPreviewDragStartY = 0;
let mediaPreviewDragOriginX = 0;
let mediaPreviewDragOriginY = 0;
const mediaRefreshPendingSessionIds = new Set();
const mediaRefreshAttemptKeys = new Set();
const pokeCooldownKeys = new Set();

export async function fetchHistoryMessages(sessionId, messageSeq = "0") {
  const cleanSessionId = text(sessionId).trim();
  const separatorIndex = cleanSessionId.indexOf(":");
  const messageType = separatorIndex >= 0 ? cleanSessionId.slice(0, separatorIndex) : "";
  const targetId = separatorIndex >= 0 ? cleanSessionId.slice(separatorIndex + 1) : "";
  const cleanMessageSeq = text(messageSeq).trim() || "0";
  if (!targetId || !["group", "private"].includes(messageType)) {
    return {
      items: [],
      session: null,
      nextMessageSeq: cleanMessageSeq,
      hasMore: false,
    };
  }

  const data = await apiGet(
    messageType === "group" ? "page/history/group" : "page/history/friend",
    {
      [messageType === "group" ? "group_id" : "user_id"]: targetId,
      message_seq: cleanMessageSeq,
      count: MESSAGE_PAGE_LIMIT,
    }
  );
  return {
    items: Array.isArray(data.items) ? data.items : [],
    session: data.session && typeof data.session === "object" ? data.session : null,
    nextMessageSeq: text(data.next_message_seq || cleanMessageSeq).trim(),
    hasMore: Boolean(data.has_more),
  };
}

function activeSession() {
  return state.sessions.find((item) => item.session_id === state.activeSessionId) || null;
}

function isTokenMediaUrl(url) {
  return text(url).trim().startsWith("/api/v1/files/tokens/");
}

async function refreshSessionMediaCache(sessionId) {
  const cleanSessionId = text(sessionId).trim();
  if (!cleanSessionId || mediaRefreshPendingSessionIds.has(cleanSessionId)) {
    return;
  }
  mediaRefreshPendingSessionIds.add(cleanSessionId);
  try {
    const data = await apiGet("page/messages", {
      session_id: cleanSessionId,
      limit: MESSAGE_PAGE_LIMIT,
    });
    const items = Array.isArray(data.items) ? data.items : [];
    const existing = state.messagesBySession.get(cleanSessionId) || [];
    let next = items;
    if (existing.length > items.length || existing.some((item) => isOptimisticMessage(item))) {
      const seenMessageIds = new Set();
      next = [];
      for (const item of [...items, ...existing]) {
        const messageId = text(item?.message_id).trim();
        if (!messageId || seenMessageIds.has(messageId)) {
          continue;
        }
        seenMessageIds.add(messageId);
        next.push(item);
      }
      next.sort((left, right) => {
        const timeDiff = Number(left.time || 0) - Number(right.time || 0);
        if (timeDiff !== 0) {
          return timeDiff;
        }
        return text(left.message_id).localeCompare(text(right.message_id));
      });
    }
    state.messagesBySession.set(cleanSessionId, next);
    if (data.session && typeof data.session === "object") {
      const target = state.sessions.find((item) => item.session_id === cleanSessionId);
      if (target) {
        Object.assign(target, data.session);
        renderSessionList();
      }
    }
    if (state.activeSessionId === cleanSessionId) {
      renderMessages();
    }
  } catch {}
  mediaRefreshPendingSessionIds.delete(cleanSessionId);
}

function bindDeferredMediaRefresh(mediaElement, sourceUrl, sessionId) {
  const cleanUrl = text(sourceUrl).trim();
  const cleanSessionId = text(sessionId).trim();
  if (!cleanUrl || !cleanSessionId || isTokenMediaUrl(cleanUrl)) {
    return;
  }
  const refreshKey = `${cleanSessionId}\n${cleanUrl}`;
  let refreshTriggered = false;
  const triggerRefresh = () => {
    if (refreshTriggered || mediaRefreshAttemptKeys.has(refreshKey)) {
      return;
    }
    refreshTriggered = true;
    mediaRefreshAttemptKeys.add(refreshKey);
    void refreshSessionMediaCache(cleanSessionId);
  };
  mediaElement.addEventListener("play", triggerRefresh, { once: true });
  mediaElement.addEventListener("error", triggerRefresh, { once: true });
}

function applyMediaPreviewImageScale() {
  const image = els.mediaPreviewBody.querySelector(".media-preview-image");
  if (!image) {
    return;
  }
  image.style.transform = `translate(${mediaPreviewImageOffsetX}px, ${mediaPreviewImageOffsetY}px) scale(${mediaPreviewImageScale})`;
  image.classList.toggle("is-draggable", mediaPreviewImageScale > 1.001);
  image.classList.toggle("is-dragging", mediaPreviewDragging);
}

function stopMediaPreviewDrag() {
  mediaPreviewDragging = false;
  mediaPreviewDragPointerId = null;
  applyMediaPreviewImageScale();
}

function closeMediaPreview() {
  mediaPreviewOpen = false;
  mediaPreviewType = "";
  mediaPreviewImageScale = 1;
  mediaPreviewImageOffsetX = 0;
  mediaPreviewImageOffsetY = 0;
  mediaPreviewDragged = false;
  stopMediaPreviewDrag();
  els.mediaPreviewModal.classList.add("is-hidden");
  els.mediaPreviewModal.setAttribute("aria-hidden", "true");
  els.mediaPreviewBody.replaceChildren();
  document.body.classList.remove("has-modal-open");
}

function openMediaPreview({ type, url, name }) {
  const cleanUrl = text(url).trim();
  if (!cleanUrl) {
    return;
  }
  mediaPreviewOpen = true;
  mediaPreviewType = type === "video" ? "video" : "image";
  mediaPreviewImageScale = 1;
  mediaPreviewImageOffsetX = 0;
  mediaPreviewImageOffsetY = 0;
  mediaPreviewDragged = false;
  stopMediaPreviewDrag();
  els.mediaPreviewModal.classList.remove("is-hidden");
  els.mediaPreviewModal.setAttribute("aria-hidden", "false");
  els.mediaPreviewTitle.textContent =
    text(name).trim() ||
    (type === "video"
      ? t("pages.dashboard.attachments.video", "Video")
      : t("pages.dashboard.attachments.image", "Image"));
  els.mediaPreviewBody.replaceChildren();
  document.body.classList.add("has-modal-open");

  if (type === "video") {
    const video = document.createElement("video");
    video.className = "media-preview-video";
    video.controls = true;
    video.preload = "metadata";
    video.src = cleanUrl;
    els.mediaPreviewBody.append(video);
    return;
  }

  const img = document.createElement("img");
  img.className = "media-preview-image";
  img.alt = text(name).trim() || t("pages.dashboard.attachments.image_alt", "image");
  img.src = cleanUrl;
  img.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (mediaPreviewDragged) {
      mediaPreviewDragged = false;
      return;
    }
    closeMediaPreview();
  });
  els.mediaPreviewBody.append(img);
  applyMediaPreviewImageScale();
}

export async function ensureFaceAssets(faceIds, options = {}) {
  const { rerenderMessages = true } = options;
  const pendingIds = [...new Set(faceIds.map((item) => text(item).trim()).filter(Boolean))]
    .filter(
      (faceId) =>
        !state.qqFaceCache.has(faceId) &&
        !state.qqFacePendingIds.has(faceId) &&
        !state.qqFaceMissingIds.has(faceId)
    );
  if (!pendingIds.length) {
    return;
  }
  for (const faceId of pendingIds) {
    state.qqFacePendingIds.add(faceId);
  }
  try {
    const data = await apiGet("page/faces", {
      ids: pendingIds.join(","),
    });
    const items = data.items && typeof data.items === "object" ? data.items : {};
    for (const [faceId, url] of Object.entries(items)) {
      if (text(url).trim()) {
        state.qqFaceCache.set(faceId, text(url).trim());
        state.qqFaceMissingIds.delete(faceId);
      }
    }
    for (const faceId of pendingIds) {
      if (!state.qqFaceCache.has(faceId)) {
        state.qqFaceMissingIds.add(faceId);
      }
    }
  } catch {}
  for (const faceId of pendingIds) {
    state.qqFacePendingIds.delete(faceId);
  }
  if (rerenderMessages && state.activeSessionId) {
    renderMessages();
  }
}

export function isMessageListNearBottom() {
  const maxScrollTop = Math.max(0, els.messageList.scrollHeight - els.messageList.clientHeight);
  return maxScrollTop - els.messageList.scrollTop <= MESSAGE_BOTTOM_THRESHOLD;
}

function formatUnreadCount(count) {
  return count > 99 ? "99+" : String(count);
}

function activeItems() {
  return state.messagesBySession.get(state.activeSessionId) || [];
}

function isOptimisticMessage(item) {
  return text(item?.message_id).trim().startsWith(LOCAL_MESSAGE_ID_PREFIX);
}

function roleRank(role) {
  return { owner: 3, admin: 2, member: 1 }[text(role).trim().toLowerCase()] || 0;
}

function messageRecallKey(item) {
  return `${text(item?.session_id || state.activeSessionId).trim()}\n${text(
    item?.message_id
  ).trim()}`;
}

function canRecallMessage(item) {
  const messageId = text(item?.message_id).trim();
  const selfId = text(state.status?.login?.user_id).trim();
  if (
    !item ||
    item.post_type !== "message" ||
    item.recalled ||
    isOptimisticMessage(item) ||
    text(item.send_status).trim() ||
    !/^\d+$/.test(messageId) ||
    !selfId ||
    state.messageRecallPendingIds.has(messageRecallKey(item))
  ) {
    return false;
  }

  const isOwnMessage = item.is_self || text(item.user_id).trim() === selfId;
  const selfRole = text(
    findGroupMember(selfId)?.role || (isOwnMessage ? item.sender?.role : "")
  ).trim().toLowerCase();
  const messageAge = Math.floor(Date.now() / 1000) - Number(item.time || 0);
  if (isOwnMessage) {
    if (item.message_type === "group" && roleRank(selfRole) >= 2) {
      return true;
    }
    return messageAge <= MESSAGE_RECALL_WINDOW_SECONDS;
  }
  if (item.message_type === "private") {
    return false;
  }
  if (item.message_type !== "group") {
    return false;
  }

  const targetRole = text(
    item.sender?.role || findGroupMember(item.user_id)?.role
  ).trim().toLowerCase();
  return roleRank(selfRole) > roleRank(targetRole) && roleRank(targetRole) > 0;
}

function applyLocalRecall(sessionId, messageId) {
  const cleanSessionId = text(sessionId).trim();
  const cleanMessageId = text(messageId).trim();
  const rows = state.messagesBySession.get(cleanSessionId) || [];
  const target = rows.find((item) => text(item.message_id).trim() === cleanMessageId);
  if (!target) {
    return false;
  }
  const next = rows.map((item) =>
    text(item.message_id).trim() === cleanMessageId
      ? {
          ...item,
          recalled: true,
          recall_operator_id: text(state.status?.login?.user_id).trim(),
        }
      : item
  );
  state.messagesBySession.set(cleanSessionId, next);
  if (state.activeSessionId === cleanSessionId) {
    renderMessages();
  }
  return true;
}

async function recallMessage(item) {
  const sessionId = text(item?.session_id || state.activeSessionId).trim();
  const messageId = text(item?.message_id).trim();
  const recallKey = messageRecallKey(item);
  if (!sessionId || !messageId || state.messageRecallPendingIds.has(recallKey)) {
    return;
  }
  const previousTarget = (state.messagesBySession.get(sessionId) || []).find(
    (row) => text(row.message_id).trim() === messageId
  );
  if (!previousTarget) {
    return;
  }
  state.messageRecallPendingIds.add(recallKey);
  renderMessages();
  let localRecallApplied = false;
  const hideTimerId = window.setTimeout(() => {
    localRecallApplied = applyLocalRecall(sessionId, messageId);
  }, RECALL_OPTIMISTIC_HIDE_DELAY_MS);
  try {
    await apiPost("page/action/recall", {
      session_id: sessionId,
      message_id: messageId,
    });
    if (!localRecallApplied) {
      window.clearTimeout(hideTimerId);
      localRecallApplied = applyLocalRecall(sessionId, messageId);
    }
    setStatus(t("pages.dashboard.status.message_recalled", "Message recalled."));
  } catch (error) {
    window.clearTimeout(hideTimerId);
    const rows = state.messagesBySession.get(sessionId) || [];
    let restored = false;
    const next = rows.map((row) => {
      if (text(row.message_id).trim() !== messageId) {
        return row;
      }
      restored = true;
      return previousTarget;
    });
    if (!restored) {
      next.push(previousTarget);
      next.sort((left, right) => {
        const timeDiff = Number(left.time || 0) - Number(right.time || 0);
        if (timeDiff !== 0) {
          return timeDiff;
        }
        return text(left.message_id).localeCompare(text(right.message_id));
      });
    }
    state.messagesBySession.set(sessionId, next);
    setStatus(
      error?.message ||
        t("pages.dashboard.status.message_recall_failed", "Failed to recall message.")
    );
  } finally {
    state.messageRecallPendingIds.delete(recallKey);
    if (state.activeSessionId === sessionId) {
      renderMessages();
    }
  }
}

function buildSendState(item) {
  const sendStatus = text(item?.send_status).trim();
  if (!item?.is_self || !sendStatus || sendStatus === "sent") {
    return null;
  }
  const canRetry = sendStatus === "failed" || sendStatus === "timeout";
  const indicator = document.createElement(canRetry ? "button" : "span");
  indicator.className = `message-send-state is-${sendStatus}`;
  if (canRetry) {
    indicator.type = "button";
  }
  if (sendStatus === "sending") {
    indicator.title = t("pages.dashboard.messages.sending", "Sending...");
    indicator.setAttribute("aria-label", indicator.title);
    return indicator;
  }
  const fallback =
    sendStatus === "timeout"
      ? t(
          "pages.dashboard.messages.send_timeout",
          "Send timed out. Delivery status is unknown."
        )
      : t("pages.dashboard.messages.send_failed", "Send failed.");
  const retryHint = t("pages.dashboard.messages.retry_send", "Click to retry.");
  indicator.title = `${text(item.send_error).trim() || fallback} ${retryHint}`;
  indicator.setAttribute("aria-label", indicator.title);
  indicator.textContent = "!";
  indicator.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!retryOptimisticMessage(item.message_id)) {
      setStatus(t("pages.dashboard.status.retry_failed", "Unable to retry this message."));
    }
  });
  return indicator;
}

async function loadOlderMessages() {
  const sessionId = text(state.activeSessionId).trim();
  const items = activeItems();
  const history = state.messageHistoryBySession.get(sessionId) || {};
  if (!sessionId || !items.length || history.loadingOlder || history.hasMoreOlder === false) {
    return;
  }
  const before = Number(items[0]?.time || 0);
  if (!before) {
    state.messageHistoryBySession.set(sessionId, {
      ...history,
      hasMoreOlder: false,
      loadingOlder: false,
    });
    return;
  }
  state.messageHistoryBySession.set(sessionId, {
    ...history,
    loadingOlder: true,
  });
  const previousScrollHeight = els.messageList.scrollHeight;
  const previousScrollTop = els.messageList.scrollTop;
  try {
    const data = await apiGet("page/messages", {
      session_id: sessionId,
      before,
      limit: MESSAGE_PAGE_LIMIT,
    });
    if (state.activeSessionId !== sessionId) {
      return;
    }
    let olderItems = Array.isArray(data.items) ? data.items : [];
    let historySession = data.session;
    let hasMoreOlder = olderItems.length > 0;
    let remoteMessageSeq = text(history.remoteMessageSeq).trim();
    let remoteHistoryQueried = false;
    if (!olderItems.length) {
      const cursorItem = items.find((item) =>
        /^-?\d+$/.test(text(item?.message_id).trim())
      );
      const messageSeq = remoteMessageSeq || text(cursorItem?.message_id).trim() || "0";
      const historyData = await fetchHistoryMessages(sessionId, messageSeq);
      remoteHistoryQueried = true;
      if (state.activeSessionId !== sessionId) {
        return;
      }
      olderItems = historyData.items;
      historySession = historyData.session || historySession;
      remoteMessageSeq = historyData.nextMessageSeq || messageSeq;
      hasMoreOlder =
        historyData.hasMore ||
        Boolean(olderItems.length && remoteMessageSeq && remoteMessageSeq !== messageSeq);
    }
    const nextHistory = {
      ...(state.messageHistoryBySession.get(sessionId) || {}),
      hasMoreOlder,
      loadingOlder: false,
    };
    if (remoteMessageSeq) {
      nextHistory.remoteMessageSeq = remoteMessageSeq;
    }
    if (remoteHistoryQueried) {
      nextHistory.remoteHistoryExhausted = !hasMoreOlder;
    }
    state.messageHistoryBySession.set(sessionId, nextHistory);
    if (!olderItems.length) {
      return;
    }
    const existing = activeItems();
    const seenMessageIds = new Set();
    const next = [];
    for (const item of [...olderItems, ...existing]) {
      const messageId = text(item?.message_id).trim();
      if (!messageId || seenMessageIds.has(messageId)) {
        continue;
      }
      seenMessageIds.add(messageId);
      next.push(item);
    }
    next.sort((left, right) => {
      const timeDiff = Number(left.time || 0) - Number(right.time || 0);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return text(left.message_id).localeCompare(text(right.message_id));
    });
    state.messagesBySession.set(sessionId, next);
    if (historySession && typeof historySession === "object") {
      const target = state.sessions.find((item) => item.session_id === sessionId);
      if (target) {
        Object.assign(target, historySession);
        renderSessionList();
      }
    }
    renderMessages({
      preserveScrollOffset: true,
      previousScrollHeight,
      previousScrollTop,
    });
  } catch {
    if (state.activeSessionId === sessionId) {
      state.messageHistoryBySession.set(sessionId, {
        ...(state.messageHistoryBySession.get(sessionId) || {}),
        loadingOlder: false,
      });
    }
  } finally {
    const currentHistory = state.messageHistoryBySession.get(sessionId);
    if (currentHistory?.loadingOlder) {
      state.messageHistoryBySession.set(sessionId, {
        ...currentHistory,
        loadingOlder: false,
      });
    }
  }
}

function updateMessageJumpButton() {
  const items = activeItems();
  const currentReadingMessageId = text(state.currentReadingMessageId).trim();
  const exitCursorMessageId = text(
    state.messageExitCursorBySession.get(state.activeSessionId) || ""
  ).trim();
  const currentIndex = items.findIndex(
    (item) => text(item.message_id).trim() === currentReadingMessageId
  );
  const exitIndex = items.findIndex(
    (item) => text(item.message_id).trim() === exitCursorMessageId
  );
  let toExitCount = 0;
  if (currentIndex >= 0 && exitIndex >= 0) {
    if (currentIndex > exitIndex) {
      toExitCount = currentIndex - exitIndex;
    } else {
      state.messageExitCursorBySession.delete(state.activeSessionId);
    }
  }

  els.messageJumpToUnreadBtn.classList.toggle(
    "is-hidden",
    !(toExitCount >= MESSAGE_EXIT_CURSOR_THRESHOLD)
  );
  els.messageJumpToBottomBtn.classList.toggle(
    "is-hidden",
    !(state.pendingNewMessageCount > 0 && !state.messageListAtBottom)
  );
  els.messageJumpUnreadTop.textContent = formatUnreadCount(toExitCount);
  els.messageJumpUnread.textContent = formatUnreadCount(state.pendingNewMessageCount);
}

export function syncActiveSessionView() {
  const items = activeItems();
  const readMid = text(state.currentReadingMessageId || items.at(-1)?.message_id).trim();
  if (!state.activeSessionId || !readMid) {
    return;
  }
  const syncKey = `${state.activeSessionId}:${state.messageListAtBottom ? "1" : "0"}:${readMid}`;
  if (state.messageViewSyncKey === syncKey) {
    return;
  }
  state.messageViewSyncKey = syncKey;
  void apiPost("page/view", {
    session_id: state.activeSessionId,
    at_bottom: state.messageListAtBottom,
    read_mid: readMid,
  })
    .then((data) => {
      const current = activeSession();
      if (current && data.session) {
        Object.assign(current, data.session);
        renderSessionList();
        updateMessageJumpButton();
      }
      if (data.last_active_session_id) {
        state.status = {
          ...(state.status || {}),
          ui: {
            ...((state.status || {}).ui || {}),
            last_active_session_id: data.last_active_session_id,
          },
        };
      }
    })
    .catch(() => {})
    .finally(() => {
      if (state.messageViewSyncKey === syncKey) {
        state.messageViewSyncKey = "";
      }
    });
}

function syncMessageListState() {
  const items = activeItems();
  state.messageListAtBottom = isMessageListNearBottom();
  if (items.length) {
    const containerTop = els.messageList.getBoundingClientRect().top;
    const readingLine = containerTop + Math.min(96, els.messageList.clientHeight * 0.28);
    let bestItem = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const row of els.messageListContent.querySelectorAll(".message-item")) {
      const rect = row.getBoundingClientRect();
      const visibleTop = Math.max(rect.top, containerTop);
      const visibleBottom = Math.min(
        rect.bottom,
        containerTop + els.messageList.clientHeight
      );
      if (visibleBottom <= visibleTop) {
        continue;
      }
      const distance = Math.abs(visibleTop - readingLine);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestItem = row;
      }
    }
    state.currentReadingMessageId = text(bestItem?.dataset.messageId).trim();
  } else {
    state.currentReadingMessageId = "";
  }
  if (state.messageListAtBottom && items.length) {
    state.currentReadingMessageId = text(items.at(-1)?.message_id).trim();
    state.pendingNewMessageCount = 0;
  }
  syncActiveSessionView();
  updateMessageJumpButton();
}

function scrollMessagesToBottom(options = {}) {
  const { smooth = false } = options;
  const top = els.messageList.scrollHeight;
  if (smooth && typeof els.messageList.scrollTo === "function") {
    els.messageList.scrollTo({ top, behavior: "smooth" });
    state.messageListAtBottom = true;
    state.pendingNewMessageCount = 0;
    syncActiveSessionView();
    updateMessageJumpButton();
    return;
  }
  els.messageList.scrollTop = top;
  syncMessageListState();
}

function jumpToLastReadMessage() {
  const exitCursorMessageId = text(
    state.messageExitCursorBySession.get(state.activeSessionId) || ""
  ).trim();
  if (!exitCursorMessageId) {
    return;
  }
  const target = els.messageListContent.querySelector(
    `.message-item[data-message-id="${CSS.escape(exitCursorMessageId)}"]`
  );
  if (!target) {
    return;
  }
  const targetTop = Math.max(0, target.offsetTop - 12);
  if (typeof els.messageList.scrollTo === "function") {
    els.messageList.scrollTo({ top: targetTop, behavior: "smooth" });
  } else {
    els.messageList.scrollTop = targetTop;
  }
  state.messageExitCursorBySession.delete(state.activeSessionId);
  window.requestAnimationFrame(() => {
    syncMessageListState();
  });
}

function formatReplyTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) {
    return "";
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const now = new Date();
  const pad = (part) => String(part).padStart(2, "0");
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    return `${hours}:${minutes}`;
  }
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${hours}:${minutes}`;
}

function formatMessageTimeDivider(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) {
    return "";
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const now = new Date();
  const pad = (part) => String(part).padStart(2, "0");
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return isToday
    ? `${hours}:${minutes}`
    : `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${hours}:${minutes}`;
}

function buildMessageNotice(content) {
  const notice = document.createElement("div");
  notice.className = "message-notice";
  if (Array.isArray(content)) {
    notice.append(...content);
  } else if (content instanceof Node) {
    notice.append(content);
  } else {
    notice.textContent = text(content).trim();
  }
  return notice;
}

function playAvatarPokeAnimation(avatar) {
  avatar.classList.remove("is-poke-shaking");
  void avatar.offsetWidth;
  avatar.classList.add("is-poke-shaking");
}

async function sendAvatarPoke(avatar, item) {
  const userId = text(item?.user_id).trim();
  if (!userId) {
    return;
  }
  const groupId = item?.message_type === "group" ? text(item?.group_id).trim() : "";
  const pokeKey = `${groupId}:${userId}`;
  if (pokeCooldownKeys.has(pokeKey)) {
    return;
  }
  pokeCooldownKeys.add(pokeKey);
  playAvatarPokeAnimation(avatar);
  try {
    await apiPost("page/action/poke", {
      user_id: userId,
      group_id: groupId,
    });
  } catch (error) {
    setStatus(
      error?.message || t("pages.dashboard.status.poke_failed", "Failed to send poke.")
    );
  } finally {
    window.setTimeout(() => {
      pokeCooldownKeys.delete(pokeKey);
    }, 800);
  }
}

function formatNoticeString(key, values = {}) {
  let content = t(`pages.dashboard.notices.${key}`, "");
  for (const [name, value] of Object.entries(values)) {
    content = content.replaceAll(`{${name}}`, text(value).trim());
  }
  return content;
}

function formatNoticeTemplate(key, values = {}) {
  const template = t(`pages.dashboard.notices.${key}`, "");
  const parts = [];
  let cursor = 0;
  for (const match of template.matchAll(/\{([^}]+)\}/g)) {
    if (match.index > cursor) {
      parts.push(document.createTextNode(template.slice(cursor, match.index)));
    }
    const value = values[match[1]];
    if (value instanceof Node) {
      parts.push(value);
    } else {
      parts.push(document.createTextNode(text(value).trim()));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < template.length) {
    parts.push(document.createTextNode(template.slice(cursor)));
  }
  return parts;
}

function noticeUser(userId, groupId) {
  const cleanUserId = text(userId).trim();
  if (!cleanUserId) {
    return document.createTextNode(t("pages.dashboard.messages.unknown_user", "Unknown User"));
  }
  const member = findGroupMember(cleanUserId);
  const cleanGroupId = text(groupId).trim();
  if (member) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-notice-user";
    button.textContent = text(member.card || member.nickname || member.user_id).trim();
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openProfileModal({
        userId: cleanUserId,
        groupId: cleanGroupId,
        displayName: button.textContent,
        nickname: member.nickname,
        role: member.role,
        title: member.title,
      });
    });
    return button;
  }
  const contact = state.contacts.find(
    (item) =>
      text(item.user_id || item.target_id).trim() === cleanUserId &&
      text(item.message_type || item.type).trim() !== "group"
  );
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-notice-user";
  button.textContent = text(
    contact?.remark || contact?.nickname || contact?.title || cleanUserId
  ).trim();
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openProfileModal({
      userId: cleanUserId,
      groupId: cleanGroupId,
      displayName: button.textContent,
      nickname: contact?.nickname,
      remark: contact?.remark,
      isFriend: text(contact?.message_type || contact?.type).trim() === "private",
    });
  });
  return button;
}

function formatNoticeDuration(seconds) {
  let value = Math.floor(Number(seconds || 0));
  if (value <= 0) {
    return "";
  }
  const parts = [];
  for (const [key, unitSeconds] of [
    ["duration_days", 86400],
    ["duration_hours", 3600],
    ["duration_minutes", 60],
    ["duration_seconds", 1],
  ]) {
    const count = Math.floor(value / unitSeconds);
    if (count <= 0) {
      continue;
    }
    parts.push(formatNoticeString(key, { count }));
    value -= count * unitSeconds;
  }
  return parts.join(formatNoticeString("duration_separator"));
}

function noticeText(item) {
  const payload = item?.notice && typeof item.notice === "object" ? item.notice : {};
  const noticeType = text(item?.notice_type || payload.notice_type).trim();
  const subType = text(item?.sub_type || payload.sub_type).trim();
  const groupId = text(payload.group_id || item.group_id || "").trim();
  const user = noticeUser(payload.user_id || item.user_id, groupId);
  const operator = noticeUser(payload.operator_id, groupId);
  const target = noticeUser(payload.target_id, groupId);
  const file = payload.file && typeof payload.file === "object" ? payload.file : {};
  const fileName = text(file.name).trim() || t("pages.dashboard.attachments.file", "File");

  if (noticeType === "group_upload") {
    return formatNoticeTemplate("group_upload", { user, file: fileName });
  }
  if (noticeType === "group_admin") {
    return formatNoticeTemplate(subType === "unset" ? "group_admin_unset" : "group_admin_set", {
      user,
    });
  }
  if (noticeType === "group_decrease") {
    const key =
      subType === "kick_me"
        ? "group_decrease_kick_me"
        : subType === "kick"
          ? "group_decrease_kick"
          : "group_decrease_leave";
    return formatNoticeTemplate(key, { user, operator });
  }
  if (noticeType === "group_increase") {
    return formatNoticeTemplate(
      subType === "invite" ? "group_increase_invite" : "group_increase_approve",
      { user, operator }
    );
  }
  if (noticeType === "group_ban") {
    return formatNoticeTemplate(subType === "lift_ban" ? "group_ban_lift" : "group_ban_ban", {
      user,
      operator,
      duration: formatNoticeDuration(payload.duration),
    });
  }
  if (noticeType === "friend_add") {
    return formatNoticeTemplate("friend_add", { user });
  }
  if (noticeType === "group_recall" || noticeType === "friend_recall") {
    const selfId = text(state.status?.login?.user_id).trim();
    const sourceMessageId = text(payload.message_id).trim();
    const recalledUserId = text(payload.user_id || item.user_id).trim();
    const operatorId = text(
      payload.operator_id || (noticeType === "friend_recall" ? recalledUserId : "")
    ).trim();
    if (
      selfId &&
      sourceMessageId &&
      recalledUserId === selfId &&
      (!operatorId || operatorId === selfId)
    ) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "message-notice-user";
      action.textContent = t("pages.dashboard.notices.reedit", "Re-edit");
      action.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const sessionId = text(item.session_id || state.activeSessionId).trim();
        let recalledMessage = (state.messagesBySession.get(sessionId) || []).find(
          (row) => text(row.message_id).trim() === sourceMessageId
        );
        if (!recalledMessage) {
          for (const rows of state.messagesBySession.values()) {
            recalledMessage = rows.find(
              (row) => text(row.message_id).trim() === sourceMessageId
            );
            if (recalledMessage) {
              break;
            }
          }
        }
        void restoreComposerFromMessage(recalledMessage);
      });
      return [
        document.createTextNode(
          t(
            "pages.dashboard.notices.self_recall",
            "You recalled a message. "
          )
        ),
        action,
      ];
    }
    if (
      noticeType === "group_recall" &&
      recalledUserId &&
      operatorId &&
      recalledUserId === operatorId
    ) {
      return formatNoticeTemplate("group_self_recall", { user });
    }
  }
  if (noticeType === "group_recall") {
    return formatNoticeTemplate("group_recall", { user, operator });
  }
  if (noticeType === "friend_recall") {
    return formatNoticeTemplate("friend_recall", { user });
  }
  if (noticeType === "notify" && subType === "poke") {
    return formatNoticeTemplate("notify_poke", { user, target });
  }
  if (noticeType === "notify" && subType === "lucky_king") {
    return formatNoticeTemplate("notify_lucky_king", { user, target });
  }
  if (noticeType === "notify" && subType === "honor") {
    const content = formatNoticeTemplate(`notify_honor_${text(payload.honor_type).trim() || "generic"}`, {
      user,
    });
    return content.length ? content : formatNoticeTemplate("notify_honor_generic", { user });
  }
  return formatNoticeTemplate("generic", { type: noticeType || item.post_type || "notice" });
}

function buildReplyAction(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-reply-action";
  button.title = t("pages.dashboard.messages.reply", "Reply");
  button.setAttribute("aria-label", button.title);
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 16.5c1.8-1.2 2.8-2.8 2.8-4.8V7.5H4.8v5h2.8c-.2 1.1-.9 2-2 2.8l1.6 1.2ZM15.8 16.5c1.8-1.2 2.8-2.8 2.8-4.8V7.5h-5.2v5h2.8c-.2 1.1-.9 2-2 2.8l1.6 1.2Z" fill="currentColor"></path></svg>';
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setComposerReplyTarget(item);
    focusComposer();
  });
  return button;
}

function buildRecallAction(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-recall-action";
  button.title = t("pages.dashboard.messages.recall", "Recall");
  button.setAttribute("aria-label", button.title);
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3.7a.8.8 0 0 1 .8.8v2.1h5.6a5.1 5.1 0 1 1 0 10.2H8.6a.8.8 0 0 1 0-1.6h6.8a3.5 3.5 0 1 0 0-7H9.8v2.1a.8.8 0 0 1-1.36.56l-3-2.9a.8.8 0 0 1 0-1.12l3-2.9A.8.8 0 0 1 9 3.7Z" fill="currentColor"></path></svg>';
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void recallMessage(item);
  });
  return button;
}

function jumpToMessage(messageId) {
  const cleanMessageId = text(messageId).trim();
  if (!cleanMessageId) {
    return false;
  }
  const target = els.messageListContent.querySelector(
    `.message-item[data-message-id="${CSS.escape(cleanMessageId)}"]`
  );
  if (!target) {
    return false;
  }
  const targetTop = Math.max(
    0,
    target.offsetTop - Math.max(12, Math.round(els.messageList.clientHeight * 0.18))
  );
  if (typeof els.messageList.scrollTo === "function") {
    els.messageList.scrollTo({ top: targetTop, behavior: "smooth" });
  } else {
    els.messageList.scrollTop = targetTop;
  }
  for (const row of els.messageListContent.querySelectorAll(".message-item.is-targeted")) {
    row.classList.remove("is-targeted");
  }
  target.classList.add("is-targeted");
  window.clearTimeout(state.messageTargetHighlightTimerId);
  state.messageTargetHighlightTimerId = window.setTimeout(() => {
    target.classList.remove("is-targeted");
  }, 1800);
  window.requestAnimationFrame(() => {
    syncMessageListState();
  });
  return true;
}

function applyMessageBounce() {
  els.messageListContent.style.transform = state.messageBounceOffset
    ? `translateY(${state.messageBounceOffset}px)`
    : "";
}

function setMessageBounceOffset(nextOffset) {
  state.messageBounceOffset = Math.max(-180, Math.min(180, nextOffset));
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
  if (deltaY < 0 && atTop) {
    void loadOlderMessages();
    setMessageBounceOffset(state.messageBounceOffset - deltaY * 0.18);
    return true;
  }
  if (deltaY > 0 && atBottom) {
    setMessageBounceOffset(state.messageBounceOffset - deltaY * 0.18);
    return true;
  }
  if (state.messageBounceOffset) {
    releaseMessageBounce();
  }
  return false;
}

function buildMessageBody(item) {
  const segments = Array.isArray(item?.message) ? item.message : [];
  if (!segments.length) {
    return null;
  }
  const body = document.createElement("div");
  body.className = "bubble-text bubble-text-segments markdown-content";
  let hasContent = false;
  let textBuffer = "";
  const missingFaceIds = [];

  function flushTextBuffer() {
    if (!textBuffer) {
      return;
    }
    body.append(renderMarkdownFragment(textBuffer, true));
    textBuffer = "";
    hasContent = true;
  }

  function buildReplyPreview(segment) {
    const replyId = text(segment?.data?.id).trim();
    if (!replyId) {
      return null;
    }
    const sessionId = text(item?.session_id || state.activeSessionId).trim();
    const quotedMessage = (state.messagesBySession.get(sessionId) || []).find(
      (candidate) => text(candidate.message_id).trim() === replyId
    );
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "bubble-reply";
    preview.title = t("pages.dashboard.messages.reply_jump", "Jump to message");

    const title = document.createElement("div");
    title.className = "bubble-reply-title";
    const meta = document.createElement("div");
    meta.className = "bubble-reply-meta";
    const name = document.createElement("span");
    name.className = "bubble-reply-name";
    const time = document.createElement("span");
    time.className = "bubble-reply-time";
    const icon = document.createElement("span");
    icon.className = "bubble-reply-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML =
      '<svg viewBox="0 0 16 16" focusable="false"><path d="M8 13.2a.8.8 0 0 1-.8-.8V5.73L4.97 7.96a.8.8 0 1 1-1.14-1.13l3.6-3.6a.8.8 0 0 1 1.14 0l3.6 3.6a.8.8 0 1 1-1.14 1.13L8.8 5.73v6.67a.8.8 0 0 1-.8.8Z"></path></svg>';
    const summary = document.createElement("div");
    summary.className = "bubble-reply-summary";

    if (!quotedMessage) {
      preview.classList.add("is-missing");
      name.textContent = `#${replyId}`;
      time.textContent = "";
      meta.append(name, time);
      title.append(meta, icon);
      summary.textContent = `#${replyId}`;
      preview.append(title, summary);
      return preview;
    }

    const senderName =
      text(
        quotedMessage.sender?.card ||
          quotedMessage.sender?.nickname ||
          quotedMessage.user_id
      ).trim() || t("pages.dashboard.messages.unknown_user", "Unknown User");
    let summaryText = text(quotedMessage.summary).trim();
    if (quotedMessage.message_type === "group") {
      summaryText = summaryText.replace(/^[^:]{1,64}:\s*/, "");
    }
    summaryText = clampText(
      summaryText || t("pages.dashboard.messages.empty_message", "[Empty message]"),
      90
    );
    name.textContent = senderName;
    time.textContent = formatReplyTime(quotedMessage.time);
    meta.append(name, time);
    title.append(meta, icon);
    summary.textContent = summaryText;
    preview.addEventListener("click", () => {
      jumpToMessage(replyId);
    });
    preview.append(title, summary);
    return preview;
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const type = text(segment?.type).trim().toLowerCase();
    if (type === "reply") {
      flushTextBuffer();
      const preview = buildReplyPreview(segment);
      if (preview) {
        body.append(preview);
        hasContent = true;
      }
      continue;
    }
    if (type === "at") {
      flushTextBuffer();
      const mention = document.createElement("span");
      mention.className = "bubble-at";
      mention.textContent = segmentTextParts(segment);
      body.append(mention);
      const nextSegment = segments[index + 1];
      const nextType = text(nextSegment?.type).trim().toLowerCase();
      const nextText =
        nextType === "text" ? text(nextSegment?.data?.text) : "";
      if (!/^\s/.test(nextText)) {
        body.append(document.createTextNode("\u00A0"));
      }
      hasContent = true;
      continue;
    }
    if (type === "face") {
      flushTextBuffer();
      const faceId = text(segment?.data?.id).trim();
      if (!faceId) {
        continue;
      }
      const faceUrl = state.qqFaceCache.get(faceId) || "";
      if (faceUrl) {
        const img = document.createElement("img");
        img.className = "bubble-face";
        img.alt = t("pages.dashboard.attachments.qq_face_alt", "[QQ Face]");
        img.loading = "lazy";
        img.src = faceUrl;
        body.append(img);
      } else {
        const placeholder = document.createElement("span");
        placeholder.className = "bubble-face-placeholder";
        placeholder.textContent = "\uFFFD";
        body.append(placeholder);
        missingFaceIds.push(faceId);
      }
      hasContent = true;
      continue;
    }
    const value = segmentTextParts(segment);
    if (value) {
      textBuffer += value;
    }
  }
  flushTextBuffer();
  if (missingFaceIds.length) {
    void ensureFaceAssets(missingFaceIds);
  }
  return hasContent ? body : null;
}

function mediaSegmentsOf(item) {
  return (Array.isArray(item?.message) ? item.message : []).filter(
    (segment) =>
      isImageSegment(segment) ||
      isVideoSegment(segment) ||
      isAudioSegment(segment) ||
      isFileSegment(segment)
  );
}

export function bindMessageEvents() {
  els.messageList.addEventListener("scroll", () => {
    if (els.messageList.scrollTop <= 8) {
      void loadOlderMessages();
    }
    syncMessageListState();
  });

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

  const clearTouchState = () => {
    state.messageTouchId = null;
    state.messageTouchLastY = 0;
    releaseMessageBounce();
  };
  els.messageList.addEventListener("touchend", clearTouchState);
  els.messageList.addEventListener("touchcancel", clearTouchState);
  els.messageJumpToBottomBtn.addEventListener("click", () => {
    scrollMessagesToBottom({ smooth: true });
  });
  els.messageJumpToUnreadBtn.addEventListener("click", () => {
    jumpToLastReadMessage();
  });
  els.mediaPreviewBackdrop.addEventListener("click", () => {
    closeMediaPreview();
  });
  els.mediaPreviewCloseBtn.addEventListener("click", () => {
    closeMediaPreview();
  });
  els.mediaPreviewBody.addEventListener("click", (event) => {
    if (event.target === els.mediaPreviewBody) {
      closeMediaPreview();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mediaPreviewOpen) {
      closeMediaPreview();
    }
  });
  els.mediaPreviewBody.addEventListener(
    "wheel",
    (event) => {
      if (!mediaPreviewOpen || mediaPreviewType !== "image") {
        return;
      }
      const image = els.mediaPreviewBody.querySelector(".media-preview-image");
      if (!image) {
        return;
      }
      event.preventDefault();
      const nextScale =
        mediaPreviewImageScale * (event.deltaY < 0 ? 1.12 : 1 / 1.12);
      mediaPreviewImageScale = Math.max(0.2, Math.min(8, nextScale));
      if (mediaPreviewImageScale <= 1.001) {
        mediaPreviewImageOffsetX = 0;
        mediaPreviewImageOffsetY = 0;
        stopMediaPreviewDrag();
      }
      applyMediaPreviewImageScale();
    },
    { passive: false }
  );
  els.mediaPreviewBody.addEventListener("pointerdown", (event) => {
    if (!mediaPreviewOpen || mediaPreviewType !== "image" || mediaPreviewImageScale <= 1.001) {
      return;
    }
    const image = event.target.closest(".media-preview-image");
    if (!image) {
      return;
    }
    mediaPreviewDragging = true;
    mediaPreviewDragged = false;
    mediaPreviewDragPointerId = event.pointerId;
    mediaPreviewDragStartX = event.clientX;
    mediaPreviewDragStartY = event.clientY;
    mediaPreviewDragOriginX = mediaPreviewImageOffsetX;
    mediaPreviewDragOriginY = mediaPreviewImageOffsetY;
    image.setPointerCapture(event.pointerId);
    applyMediaPreviewImageScale();
    event.preventDefault();
  });
  els.mediaPreviewBody.addEventListener("pointermove", (event) => {
    if (
      !mediaPreviewDragging ||
      mediaPreviewDragPointerId !== event.pointerId ||
      mediaPreviewType !== "image"
    ) {
      return;
    }
    const deltaX = event.clientX - mediaPreviewDragStartX;
    const deltaY = event.clientY - mediaPreviewDragStartY;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      mediaPreviewDragged = true;
    }
    mediaPreviewImageOffsetX = mediaPreviewDragOriginX + deltaX;
    mediaPreviewImageOffsetY = mediaPreviewDragOriginY + deltaY;
    applyMediaPreviewImageScale();
    event.preventDefault();
  });
  const releaseMediaPreviewPointer = (event) => {
    if (mediaPreviewDragPointerId !== event.pointerId) {
      return;
    }
    stopMediaPreviewDrag();
  };
  els.mediaPreviewBody.addEventListener("pointerup", releaseMediaPreviewPointer);
  els.mediaPreviewBody.addEventListener("pointercancel", releaseMediaPreviewPointer);
}

export function rememberActiveSessionExitCursor() {
  if (!state.activeSessionId) {
    return;
  }
  const messageId = text(state.currentReadingMessageId).trim();
  if (!messageId) {
    state.messageExitCursorBySession.delete(state.activeSessionId);
    return;
  }
  state.messageExitCursorBySession.set(state.activeSessionId, messageId);
}

export function renderMessages(options = {}) {
  const {
    forceScrollToBottom = false,
    newMessageCount = 0,
    preserveScrollOffset = false,
    previousScrollHeight = 0,
    previousScrollTop = 0,
  } = options;
  const session = activeSession();
  const sessionTitle = session?.title || state.activeSessionId;
  if (session?.message_type === "group") {
    const memberCount =
      session.member_count != null ? Number(session.member_count) : state.groupMembers.length;
    els.chatTitle.textContent = memberCount > 0 ? `${sessionTitle}(${memberCount})` : sessionTitle;
  } else {
    els.chatTitle.textContent = sessionTitle;
  }
  const items = state.messagesBySession.get(state.activeSessionId) || [];
  const previousListScrollTop = els.messageList.scrollTop;
  const shouldStickToBottom = forceScrollToBottom || isMessageListNearBottom();
  const previousRenderedSessionId = els.messageListContent.dataset.sessionId || "";
  const previousLastMessageId = text(
    els.messageListContent.querySelector(".message-item:last-of-type")?.dataset.messageId
  ).trim();
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  if (!state.activeSessionId || !items.length) {
    if (!state.activeSessionId) {
      delete els.messageListContent.dataset.sessionId;
    } else {
      els.messageListContent.dataset.sessionId = state.activeSessionId;
    }
    state.messageListAtBottom = true;
    state.currentReadingMessageId = "";
    state.pendingNewMessageCount = 0;
    syncActiveSessionView();
    updateMessageJumpButton();
    els.messageListContent.className = "message-list-content empty-state";
    els.messageListContent.textContent = !state.activeSessionId
      ? t(
          "pages.dashboard.messages.select_session",
          "Select a conversation from the left side."
        )
      : t(
          "pages.dashboard.messages.empty_session",
          "No cached messages for this session yet."
        );
    return;
  }
  const previousLastIndex = items.findIndex(
    (item) => text(item.message_id).trim() === previousLastMessageId
  );
  const shouldAnimateIncoming =
    !reduceMotion &&
    !forceScrollToBottom &&
    shouldStickToBottom &&
    previousRenderedSessionId === state.activeSessionId &&
    previousLastIndex >= 0 &&
    previousLastIndex < items.length - 1;
  const shouldAutoScrollAfterMediaLoad = shouldStickToBottom;
  els.messageListContent.className = "message-list-content";
  els.messageListContent.dataset.sessionId = state.activeSessionId;
  els.messageListContent.replaceChildren();
  const fragment = document.createDocumentFragment();
  const selfId = text(state.status?.login?.user_id).trim();
  let previousMessageTime = 0;
  for (const [index, item] of items.entries()) {
    if (
      item.post_type !== "notice" &&
      item.recalled &&
      selfId &&
      text(item.recall_operator_id).trim() === selfId
    ) {
      continue;
    }
    const messageTime = Number(item.time || 0);
    if (
      messageTime > 0 &&
      (index === 0 || messageTime - previousMessageTime >= MESSAGE_TIME_DIVIDER_THRESHOLD)
    ) {
      const dividerText = formatMessageTimeDivider(messageTime);
      if (dividerText) {
        fragment.append(buildMessageNotice(dividerText));
      }
    }
    previousMessageTime = messageTime || previousMessageTime;

    if (item.post_type === "notice") {
      const content = noticeText(item);
      if (content) {
        fragment.append(buildMessageNotice(content));
      }
      continue;
    }

    const row = document.createElement("article");
    const sendStatus = text(item.send_status).trim();
    const isRecalling = state.messageRecallPendingIds.has(messageRecallKey(item));
    row.className = `message-item${item.is_self ? " self" : ""}${
      isOptimisticMessage(item) ? " is-local" : ""
    }${sendStatus ? ` is-send-${sendStatus}` : ""}${item.recalled ? " is-recalled" : ""}${
      isRecalling ? " is-recalling" : ""
    }`;
    if (shouldAnimateIncoming && index === items.length - 1) {
      row.classList.add("is-entering");
    }
    row.dataset.messageId = text(item.message_id).trim();
    const member = item.message_type === "group" ? findGroupMember(item.user_id) : null;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    setAvatar(
      avatar,
      avatarUrl(item.user_id, "private"),
      text(item.sender?.card || item.sender?.nickname || item.user_id).slice(0, 1).toUpperCase()
    );
    avatar.classList.add("is-pokable");
    avatar.title = t("pages.dashboard.actions.poke", "Poke");
    avatar.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void sendAvatarPoke(avatar, item);
    });

    const hasSegmentBody = hasRenderableSegmentBody(item);
    const mediaSegments = mediaSegmentsOf(item);
    const images = mediaSegments.filter((segment) => isImageSegment(segment));
    const videos = mediaSegments.filter((segment) => isVideoSegment(segment));
    const audios = mediaSegments.filter((segment) => isAudioSegment(segment));
    const files = mediaSegments.filter((segment) => isFileSegment(segment));
    const summary = text(item.summary).trim();
    const isAttachmentPlaceholder =
      /^\[(image|video|audio|file)\]$/i.test(summary) &&
      (images.length || videos.length || audios.length || files.length);
    const displayText =
      hasSegmentBody || isAttachmentPlaceholder || mediaSegments.length ? "" : summary;
    const attachmentCount = images.length + videos.length + audios.length + files.length;
    const singleMediaOnly = attachmentCount === 1 && !displayText;

    const bubble = document.createElement("div");
    bubble.className = singleMediaOnly ? "bubble bubble-media-only" : "bubble";
    const bubbleFrame = document.createElement("div");
    bubbleFrame.className = "message-bubble-frame";
    const stack = document.createElement("div");
    stack.className = `message-stack${item.is_self ? " self" : ""}`;

    if (item.message_type === "group") {
      const badgeMeta = buildGroupBadge({
        ...member,
        role: item.sender?.role || member?.role,
        level: item.sender?.level || member?.level,
        title: member?.title,
        card: item.sender?.card || member?.card,
        nickname: item.sender?.nickname || member?.nickname,
        user_id: item.user_id,
      });
      const meta = document.createElement("div");
      meta.className = `bubble-meta${item.is_self ? " self" : ""}`;

      const badge = document.createElement("div");
      badge.className = `bubble-corner-badge role-${badgeMeta.role}${item.is_self ? " self" : ""}`;
      badge.textContent = badgeMeta.text;

      const name = document.createElement("div");
      name.className = `bubble-name${item.is_self ? " self" : ""}`;
      name.textContent = badgeMeta.name || item.sender?.card || item.sender?.nickname || item.user_id;
      meta.append(badge, name);
      stack.append(meta);
    }
    bubbleFrame.append(bubble);
    if (!isOptimisticMessage(item) && !item.recalled) {
      bubbleFrame.append(buildReplyAction(item));
    }
    if (canRecallMessage(item)) {
      bubbleFrame.append(buildRecallAction(item));
    }
    stack.append(bubbleFrame);
    const sendState = buildSendState(item);
    if (sendState) {
      stack.append(sendState);
    }
    row.append(avatar, stack);

    const segmentBody = buildMessageBody(item);
    if (segmentBody) {
      bubble.append(segmentBody);
    } else if (displayText) {
      const body = document.createElement("div");
      body.className = "bubble-text markdown-content";
      body.append(renderMarkdownFragment(displayText));
      bubble.append(body);
    }

    if (mediaSegments.length) {
      const wrap = document.createElement("div");
      wrap.className =
        videos.length || audios.length || files.length
          ? "attachment-row"
          : "attachment-row images-only";

      for (const segment of images) {
        const previewUrl = text(segment?.data?.url || segment?.data?.file).trim();
        const name = text(segment?.data?.name || segment?.data?.file).trim();
        const link = document.createElement("a");
        link.className = `message-image-link${singleMediaOnly ? " is-standalone" : ""}`;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.href = previewUrl || "javascript:void(0)";
        const img = document.createElement("img");
        img.className = "message-image";
        img.loading = "lazy";
        img.alt = name || t("pages.dashboard.attachments.image_alt", "image");
        if (shouldAutoScrollAfterMediaLoad) {
          img.addEventListener(
            "load",
            () => {
              if (state.messageListAtBottom || isMessageListNearBottom()) {
                scrollMessagesToBottom();
              }
            },
            { once: true }
          );
        }
        img.src = previewUrl;
        link.addEventListener("dblclick", (event) => {
          event.preventDefault();
          openMediaPreview({ type: "image", url: previewUrl, name });
        });
        link.append(img);
        wrap.append(link);
      }

      for (const segment of videos) {
        const previewUrl = text(segment?.data?.url || segment?.data?.file).trim();
        const name = text(segment?.data?.name || segment?.data?.file).trim();
        const video = document.createElement("video");
        video.className = `message-video${singleMediaOnly ? " is-standalone" : ""}`;
        video.controls = true;
        video.preload = "metadata";
        video.src = previewUrl;
        bindDeferredMediaRefresh(video, previewUrl, item.session_id);
        video.addEventListener("dblclick", (event) => {
          event.preventDefault();
          openMediaPreview({ type: "video", url: previewUrl, name });
        });
        wrap.append(video);
      }

      for (const segment of audios) {
        const previewUrl = text(segment?.data?.url || segment?.data?.file).trim();
        const audio = document.createElement("audio");
        audio.className = `message-audio${singleMediaOnly ? " is-standalone" : ""}`;
        audio.controls = true;
        audio.preload = "metadata";
        audio.src = previewUrl;
        bindDeferredMediaRefresh(audio, previewUrl, item.session_id);
        wrap.append(audio);
      }

      for (const segment of files) {
        const link = document.createElement("a");
        link.className = `attachment-chip attachment-chip-file${singleMediaOnly ? " is-standalone" : ""}`;
        link.target = "_blank";
        link.rel = "noreferrer";
        const attachmentUrl = text(segment?.data?.url || segment?.data?.file).trim() || "javascript:void(0)";
        const fileName = text(segment?.data?.name || segment?.data?.file || segment?.type).trim();
        link.title = fileName || segmentKindLabel(segment);
        link.href = attachmentUrl;
        const name = document.createElement("span");
        name.className = "attachment-chip-file-name";
        name.textContent = fileName || segmentKindLabel(segment);
        const icon = document.createElement("span");
        icon.className = "attachment-chip-file-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"></path><path d="M14 2v5h5"></path><path d="M9 15h6"></path><path d="M9 11h3"></path></svg>';
        link.append(name, icon);
        if (attachmentUrl === "javascript:void(0)") {
          link.classList.add("is-disabled");
        }
        wrap.append(link);
      }

      bubble.append(wrap);
    }

    fragment.append(row);
  }
  els.messageListContent.append(fragment);
  if (preserveScrollOffset) {
    els.messageList.scrollTop = Math.max(
      0,
      previousScrollTop + els.messageList.scrollHeight - previousScrollHeight
    );
    syncMessageListState();
    return;
  }
  if (shouldStickToBottom) {
    state.pendingNewMessageCount = 0;
    scrollMessagesToBottom({ smooth: shouldAnimateIncoming });
    return;
  }
  if (newMessageCount > 0) {
    state.pendingNewMessageCount += newMessageCount;
  }
  els.messageList.scrollTop = previousListScrollTop;
  syncMessageListState();
}
