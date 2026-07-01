import { apiGet, apiPost } from "../core/api.js";
import { els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { renderMarkdownFragment } from "../core/markdown.js";
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
import { focusComposer, setComposerReplyTarget } from "../chat/composer.js";
import { renderSessionList } from "./sidebar.js";

const MESSAGE_BOTTOM_THRESHOLD = 24;
const MESSAGE_EXIT_CURSOR_THRESHOLD = 8;
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
      limit: 80,
    });
    const items = Array.isArray(data.items) ? data.items : [];
    state.messagesBySession.set(cleanSessionId, items);
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
  let refreshTriggered = false;
  const triggerRefresh = () => {
    if (refreshTriggered) {
      return;
    }
    refreshTriggered = true;
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
  const toExitCount =
    currentIndex >= 0 && exitIndex >= 0 ? Math.abs(currentIndex - exitIndex) : 0;

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

function buildReplyAction(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-reply-action";
  button.title = t("pages.dashboard.messages.reply", "Reply");
  button.setAttribute("aria-label", button.title);
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 8 4 12l6 4v-3h4a6 6 0 0 1 6 6v1a9 9 0 0 0-9-9h-1V8Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setComposerReplyTarget(item);
    focusComposer();
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
  if ((deltaY < 0 && atTop) || (deltaY > 0 && atBottom)) {
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

  for (const segment of segments) {
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
      body.append(document.createTextNode("\u00A0"));
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
  const { forceScrollToBottom = false, newMessageCount = 0 } = options;
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
  const previousScrollTop = els.messageList.scrollTop;
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
  for (const [index, item] of items.entries()) {
    const row = document.createElement("article");
    row.className = `message-item${item.is_self ? " self" : ""}`;
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
    stack.append(bubble, buildReplyAction(item));
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

    els.messageListContent.append(row);
  }
  if (shouldStickToBottom) {
    state.pendingNewMessageCount = 0;
    scrollMessagesToBottom({ smooth: shouldAnimateIncoming });
    return;
  }
  if (newMessageCount > 0) {
    state.pendingNewMessageCount += newMessageCount;
  }
  els.messageList.scrollTop = previousScrollTop;
  syncMessageListState();
}
