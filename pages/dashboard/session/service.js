import { apiGet, apiPost } from "../core/api.js";
import { LOCAL_MESSAGE_ID_PREFIX } from "../core/constants.js";
import { els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { text } from "../core/utils.js";
import {
  clearComposerEditor,
  focusComposer,
  renderComposerPreview,
  updateSendAvailability,
} from "../chat/composer.js";
import { loadGroupMembers } from "../contact/service.js";
import { renderGroupMembers } from "../contact/members.js";
import { rememberActiveSessionExitCursor, renderMessages } from "./messages.js";
import { renderSessionList } from "./sidebar.js";

let openSessionHandler = null;
const MESSAGE_PAGE_LIMIT = 50;

export function setOpenSessionHandler(handler) {
  openSessionHandler = handler;
}

function areSessionListsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];
    if (
      leftItem.session_id !== rightItem.session_id ||
      leftItem.title !== rightItem.title ||
      leftItem.sender_name !== rightItem.sender_name ||
      leftItem.message_type !== rightItem.message_type ||
      leftItem.muted !== rightItem.muted ||
      Boolean(leftItem.pin) !== Boolean(rightItem.pin) ||
      leftItem.summary !== rightItem.summary ||
      leftItem.time !== rightItem.time ||
      Number(leftItem.pin_at || 0) !== Number(rightItem.pin_at || 0) ||
      leftItem.read_mid !== rightItem.read_mid ||
      Number(leftItem.unread || 0) !== Number(rightItem.unread || 0) ||
      Number(leftItem.member_count ?? -1) !== Number(rightItem.member_count ?? -1)
    ) {
      return false;
    }
  }
  return true;
}

function areMessageListsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];
    if (
      leftItem.message_id !== rightItem.message_id ||
      leftItem.post_type !== rightItem.post_type ||
      leftItem.notice_type !== rightItem.notice_type ||
      leftItem.sub_type !== rightItem.sub_type ||
      leftItem.summary !== rightItem.summary ||
      leftItem.time !== rightItem.time ||
      leftItem.message_type !== rightItem.message_type ||
      leftItem.user_id !== rightItem.user_id ||
      Boolean(leftItem.recalled) !== Boolean(rightItem.recalled) ||
      leftItem.recall_operator_id !== rightItem.recall_operator_id ||
      JSON.stringify(leftItem.sender || {}) !== JSON.stringify(rightItem.sender || {}) ||
      JSON.stringify(leftItem.notice || {}) !== JSON.stringify(rightItem.notice || {}) ||
      JSON.stringify(leftItem.message || []) !== JSON.stringify(rightItem.message || [])
    ) {
      return false;
    }
  }
  return true;
}

function getSessionPreview(sessionId) {
  return state.sessions.find((item) => item.session_id === sessionId) || null;
}

function isOptimisticMessage(item) {
  return text(item?.message_id).trim().startsWith(LOCAL_MESSAGE_ID_PREFIX);
}

function revokeOptimisticPreviewUrls(messageId) {
  const previewUrls = state.optimisticPreviewUrlsByMessageId.get(messageId) || [];
  for (const previewUrl of previewUrls) {
    URL.revokeObjectURL(previewUrl);
  }
  state.optimisticPreviewUrlsByMessageId.delete(messageId);
}

function removeFirstOptimisticMessage(sessionId, incomingMessage = null) {
  const cleanSessionId = text(sessionId).trim();
  const rows = state.messagesBySession.get(cleanSessionId) || [];
  const incomingSummary = text(incomingMessage?.summary).trim();
  let index = -1;
  for (const preferredStatus of ["sent", "sending", "timeout", ""]) {
    index = rows.findIndex((item) => {
      const sendStatus = text(item.send_status).trim();
      return (
        isOptimisticMessage(item) &&
        item.is_self &&
        sendStatus !== "failed" &&
        sendStatus === preferredStatus &&
        (!incomingSummary || text(item.summary).trim() === incomingSummary)
      );
    });
    if (index >= 0) {
      break;
    }
  }
  if (index < 0) {
    index = rows.findIndex((item) => {
      const sendStatus = text(item.send_status).trim();
      return (
        isOptimisticMessage(item) &&
        item.is_self &&
        (sendStatus === "sent" || sendStatus === "sending" || sendStatus === "")
      );
    });
  }
  if (index < 0) {
    return false;
  }
  const removed = rows[index];
  state.messagesBySession.set(cleanSessionId, [
    ...rows.slice(0, index),
    ...rows.slice(index + 1),
  ]);
  revokeOptimisticPreviewUrls(text(removed.message_id).trim());
  return true;
}

function upsertSession(session) {
  if (!session?.session_id) {
    return false;
  }
  const next = [...state.sessions];
  const index = next.findIndex((item) => item.session_id === session.session_id);
  if (index >= 0) {
    next[index] = { ...next[index], ...session };
  } else {
    next.push(session);
  }
  next.sort((left, right) => {
    const pinDiff = Number(Boolean(right.pin)) - Number(Boolean(left.pin));
    if (pinDiff !== 0) {
      return pinDiff;
    }
    if (left.pin && right.pin) {
      const pinTimeDiff = Number(right.pin_at || 0) - Number(left.pin_at || 0);
      if (pinTimeDiff !== 0) {
        return pinTimeDiff;
      }
    }
    const timeDiff = Number(right.time || 0) - Number(left.time || 0);
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return text(right.session_id).localeCompare(text(left.session_id));
  });
  const changed = !areSessionListsEqual(state.sessions, next);
  state.sessions = next;
  if (changed && openSessionHandler) {
    renderSessionList(openSessionHandler);
  }
  return changed;
}

function removeSession(sessionId) {
  const cleanSessionId = text(sessionId).trim();
  if (!cleanSessionId) {
    return false;
  }
  for (const item of state.messagesBySession.get(cleanSessionId) || []) {
    if (isOptimisticMessage(item)) {
      revokeOptimisticPreviewUrls(text(item.message_id).trim());
    }
  }
  const next = state.sessions.filter((item) => item.session_id !== cleanSessionId);
  const changed = next.length !== state.sessions.length;
  state.sessions = next;
  state.messagesBySession.delete(cleanSessionId);
  state.messageHistoryBySession.delete(cleanSessionId);
  state.messagePrefetching.delete(cleanSessionId);
  state.sessionMutePendingIds.delete(cleanSessionId);
  state.sessionPinPendingIds.delete(cleanSessionId);
  state.sessionDeletePendingIds.delete(cleanSessionId);
  for (const key of Array.from(state.messageRecallPendingIds)) {
    if (key.startsWith(`${cleanSessionId}\n`)) {
      state.messageRecallPendingIds.delete(key);
    }
  }
  if (state.activeSessionId === cleanSessionId) {
    resetActiveSessionView();
  } else if (changed && openSessionHandler) {
    renderSessionList(openSessionHandler);
  }
  return changed;
}

function mergeMessage(message) {
  if (!message?.session_id || !message?.message_id) {
    return { changed: false, inserted: false };
  }
  const existing = state.messagesBySession.get(message.session_id) || [];
  const index = existing.findIndex(
    (item) => text(item.message_id).trim() === text(message.message_id).trim()
  );
  let next;
  if (index >= 0) {
    next = existing.map((item, currentIndex) =>
      currentIndex === index ? { ...item, ...message } : item
    );
  } else {
    next = [...existing];
    let insertAt = next.length;
    while (insertAt > 0 && Number(next[insertAt - 1].time || 0) > Number(message.time || 0)) {
      insertAt -= 1;
    }
    next.splice(insertAt, 0, message);
  }
  const changed = !areMessageListsEqual(existing, next);
  state.messagesBySession.set(message.session_id, next);
  return { changed, inserted: index < 0 };
}

function applyRecallNotice(message) {
  const noticeType = text(message?.notice_type || message?.notice?.notice_type).trim();
  if (!["group_recall", "friend_recall"].includes(noticeType)) {
    return "";
  }
  const sourceMessageId = text(message?.notice?.message_id).trim();
  if (!sourceMessageId) {
    return "";
  }
  let targetSessionId = text(message?.session_id).trim();
  let rows = state.messagesBySession.get(targetSessionId) || [];
  let target = rows.find((item) => text(item.message_id).trim() === sourceMessageId);
  if (!target) {
    for (const [sessionId, candidates] of state.messagesBySession.entries()) {
      target = candidates.find(
        (item) => text(item.message_id).trim() === sourceMessageId
      );
      if (target) {
        targetSessionId = sessionId;
        rows = candidates;
        break;
      }
    }
  }
  if (!targetSessionId || !target) {
    return "";
  }
  const next = rows.map((item) =>
    text(item.message_id).trim() === sourceMessageId
      ? {
          ...item,
          recalled: true,
          recall_operator_id: text(
            message?.notice?.operator_id || message?.user_id || ""
          ).trim(),
        }
      : item
  );
  state.messagesBySession.set(targetSessionId, next);
  return targetSessionId;
}

export async function loadSessions() {
  const data = await apiGet("page/sessions", {
    keyword: state.searchKeyword,
    limit: 200,
  });
  const items = Array.isArray(data.items) ? data.items : [];
  const changed = !areSessionListsEqual(state.sessions, items);
  state.sessions = items;
  if (changed && openSessionHandler) {
    renderSessionList(openSessionHandler);
  }
  void prefetchActiveSessionMessages();
}

export async function setSessionMuted(sessionId, muted) {
  const cleanSessionId = text(sessionId).trim();
  const nextMuted = Boolean(muted);
  const current = getSessionPreview(cleanSessionId);
  if (!cleanSessionId || state.sessionMutePendingIds.has(cleanSessionId)) {
    return current;
  }

  const previousMuted = Boolean(current?.muted);
  state.sessionMutePendingIds.add(cleanSessionId);
  if (current && previousMuted !== nextMuted) {
    upsertSession({ ...current, muted: nextMuted });
  } else if (openSessionHandler) {
    renderSessionList(openSessionHandler);
  }

  try {
    const data = await apiPost("page/session/mute", {
      session_id: cleanSessionId,
      muted: nextMuted,
    });
    state.sessionMutePendingIds.delete(cleanSessionId);
    if (data.session) {
      const latest = getSessionPreview(cleanSessionId) || data.session;
      const changed = upsertSession({
        ...latest,
        muted: Boolean(data.session.muted),
      });
      if (!changed && openSessionHandler) {
        renderSessionList(openSessionHandler);
      }
    } else if (openSessionHandler) {
      renderSessionList(openSessionHandler);
    }
    return data.session || getSessionPreview(cleanSessionId);
  } catch (error) {
    state.sessionMutePendingIds.delete(cleanSessionId);
    const latest = getSessionPreview(cleanSessionId);
    if (latest) {
      upsertSession({ ...latest, muted: previousMuted });
    } else if (openSessionHandler) {
      renderSessionList(openSessionHandler);
    }
    throw error;
  }
}

export async function setSessionPinned(sessionId, pin) {
  const cleanSessionId = text(sessionId).trim();
  const nextPin = Boolean(pin);
  const current = getSessionPreview(cleanSessionId);
  if (!cleanSessionId || state.sessionPinPendingIds.has(cleanSessionId)) {
    return current;
  }

  const previousPin = Boolean(current?.pin);
  const previousPinAt = Number(current?.pin_at || 0);
  state.sessionPinPendingIds.add(cleanSessionId);
  if (current && previousPin !== nextPin) {
    upsertSession({
      ...current,
      pin: nextPin,
      pin_at: nextPin ? Math.floor(Date.now() / 1000) : 0,
    });
  } else if (openSessionHandler) {
    renderSessionList(openSessionHandler);
  }

  try {
    const data = await apiPost("page/session/pin", {
      session_id: cleanSessionId,
      pin: nextPin,
    });
    state.sessionPinPendingIds.delete(cleanSessionId);
    if (data.session) {
      const latest = getSessionPreview(cleanSessionId) || data.session;
      const changed = upsertSession({
        ...latest,
        pin: Boolean(data.session.pin),
        pin_at: Number(data.session.pin_at || 0),
      });
      if (!changed && openSessionHandler) {
        renderSessionList(openSessionHandler);
      }
    } else if (openSessionHandler) {
      renderSessionList(openSessionHandler);
    }
    return data.session || getSessionPreview(cleanSessionId);
  } catch (error) {
    state.sessionPinPendingIds.delete(cleanSessionId);
    const latest = getSessionPreview(cleanSessionId);
    if (latest) {
      upsertSession({
        ...latest,
        pin: previousPin,
        pin_at: previousPinAt,
      });
    } else if (openSessionHandler) {
      renderSessionList(openSessionHandler);
    }
    throw error;
  }
}

export async function deleteSession(sessionId) {
  const cleanSessionId = text(sessionId).trim();
  const current = getSessionPreview(cleanSessionId);
  if (!cleanSessionId || !current || state.sessionDeletePendingIds.has(cleanSessionId)) {
    return false;
  }

  const wasActive = state.activeSessionId === cleanSessionId;
  const previousMessages = state.messagesBySession.get(cleanSessionId) || null;
  const previousHistory = state.messageHistoryBySession.get(cleanSessionId) || null;
  state.sessionDeletePendingIds.add(cleanSessionId);
  removeSession(cleanSessionId);

  try {
    await apiPost("page/session/delete", {
      session_id: cleanSessionId,
    });
    state.sessionDeletePendingIds.delete(cleanSessionId);
    return true;
  } catch (error) {
    state.sessionDeletePendingIds.delete(cleanSessionId);
    if (previousMessages) {
      state.messagesBySession.set(cleanSessionId, previousMessages);
    }
    if (previousHistory) {
      state.messageHistoryBySession.set(cleanSessionId, previousHistory);
    }
    upsertSession(current);
    if (wasActive) {
      state.activeSessionId = cleanSessionId;
      renderMessages({ forceScrollToBottom: true });
      void loadGroupMembers(false);
      updateSendAvailability();
      if (openSessionHandler) {
        renderSessionList(openSessionHandler);
      }
    }
    throw error;
  }
}

export async function loadMessages(sessionId) {
  const data = await apiGet("page/messages", {
    session_id: sessionId,
    limit: MESSAGE_PAGE_LIMIT,
  });
  const items = Array.isArray(data.items) ? data.items : [];
  const existing = state.messagesBySession.get(sessionId) || [];
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
  const changed = !areMessageListsEqual(existing, next);
  state.messagesBySession.set(sessionId, next);
  const history = state.messageHistoryBySession.get(sessionId) || {};
  state.messageHistoryBySession.set(sessionId, {
    ...history,
    hasMoreOlder:
      existing.length > items.length
        ? history.hasMoreOlder !== false
        : items.length >= MESSAGE_PAGE_LIMIT,
    loadingOlder: false,
  });
  if (data.session) {
    upsertSession(data.session);
  }
  updateSendAvailability();
  if (state.activeSessionId === sessionId && (!existing.length || changed)) {
    renderMessages({ forceScrollToBottom: !existing.length });
  }
}

export async function applyIncomingSession(session) {
  if (session?.deleted) {
    return removeSession(session.session_id);
  }
  const changed = upsertSession(session);
  if (state.activeSessionId === session?.session_id) {
    renderMessages();
  }
  return changed;
}

export async function applyIncomingMessage(payload) {
  if (payload?.session?.session_id) {
    upsertSession(payload.session);
  }
  const incomingMessage = payload?.message;
  if (
    incomingMessage?.is_self &&
    incomingMessage?.session_id &&
    incomingMessage?.post_type === "message" &&
    !isOptimisticMessage(incomingMessage)
  ) {
    removeFirstOptimisticMessage(incomingMessage.session_id, incomingMessage);
  }
  const recalledSessionId = applyRecallNotice(incomingMessage);
  const { inserted } = mergeMessage(incomingMessage);
  if (
    state.activeSessionId === incomingMessage?.session_id ||
    state.activeSessionId === recalledSessionId
  ) {
    renderMessages({
      newMessageCount: inserted && !state.messageListAtBottom ? 1 : 0,
    });
  }
  return true;
}

export async function openSession(sessionId) {
  if (state.activeSessionId && state.activeSessionId !== sessionId) {
    rememberActiveSessionExitCursor();
  }
  state.activeSessionId = sessionId;
  state.pendingNewMessageCount = 0;
  state.pendingUploads = [];
  clearComposerEditor();
  await renderComposerPreview();
  if (openSessionHandler) {
    renderSessionList(openSessionHandler);
  }
  const cached = state.messagesBySession.get(sessionId) || [];
  const cachedRecent = cached.slice(-MESSAGE_PAGE_LIMIT);
  if (cached.length !== cachedRecent.length) {
    state.messagesBySession.set(sessionId, cachedRecent);
  }
  state.messageHistoryBySession.set(sessionId, {
    hasMoreOlder: cached.length >= MESSAGE_PAGE_LIMIT,
    loadingOlder: false,
  });
  const session = getSessionPreview(sessionId);
  if (session && Number(session.unread || 0) > 0) {
    session.unread = 0;
    renderSessionList(openSessionHandler);
  }
  if (cachedRecent.length) {
    renderMessages({ forceScrollToBottom: true });
    void loadMessages(sessionId);
  } else {
    showLoadingMessages();
    await loadMessages(sessionId);
  }
  await loadGroupMembers(false);
  updateSendAvailability();
  focusComposer();
}

export function resetActiveSessionView() {
  rememberActiveSessionExitCursor();
  state.activeSessionId = "";
  state.messageListAtBottom = true;
  state.currentReadingMessageId = "";
  state.pendingNewMessageCount = 0;
  state.groupMembers = [];
  state.groupMemberByUserId = new Map();
  clearComposerEditor();
  if (openSessionHandler) {
    renderSessionList(openSessionHandler);
  }
  renderMessages();
  renderGroupMembers();
  updateSendAvailability();
}

export function showLoadingMessages() {
  els.messageListContent.className = "message-list-content empty-state";
  els.messageListContent.textContent = t(
    "pages.dashboard.status.loading_messages",
    "Loading messages..."
  );
}

export async function prefetchActiveSessionMessages() {
  const sessionId = text(state.activeSessionId).trim();
  if (!sessionId || state.messagePrefetching.has(sessionId)) {
    return;
  }
  state.messagePrefetching.add(sessionId);
  try {
    await loadMessages(sessionId);
  } catch {}
  state.messagePrefetching.delete(sessionId);
}

export { getSessionPreview };
