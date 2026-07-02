import { apiGet, apiPost } from "../core/api.js";
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
      leftItem.summary !== rightItem.summary ||
      leftItem.time !== rightItem.time ||
      leftItem.message_type !== rightItem.message_type ||
      leftItem.user_id !== rightItem.user_id ||
      JSON.stringify(leftItem.sender || {}) !== JSON.stringify(rightItem.sender || {}) ||
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
  const next = state.sessions.filter((item) => item.session_id !== cleanSessionId);
  const changed = next.length !== state.sessions.length;
  state.sessions = next;
  state.messagesBySession.delete(cleanSessionId);
  state.messagePrefetching.delete(cleanSessionId);
  state.sessionMutePendingIds.delete(cleanSessionId);
  state.sessionPinPendingIds.delete(cleanSessionId);
  state.sessionDeletePendingIds.delete(cleanSessionId);
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
  void prefetchRecentSessionMessages();
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
    limit: 80,
  });
  const items = Array.isArray(data.items) ? data.items : [];
  const existing = state.messagesBySession.get(sessionId) || [];
  const changed = !areMessageListsEqual(existing, items);
  state.messagesBySession.set(sessionId, items);
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
  const { inserted } = mergeMessage(payload?.message);
  if (state.activeSessionId === payload?.message?.session_id) {
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
  const session = getSessionPreview(sessionId);
  if (session && Number(session.unread || 0) > 0) {
    session.unread = 0;
    renderSessionList(openSessionHandler);
  }
  if (cached.length) {
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

export async function prefetchRecentSessionMessages() {
  const targets = state.sessions
    .slice(0, 8)
    .map((item) => text(item.session_id).trim())
    .filter(Boolean)
    .filter((sessionId) => !state.messagePrefetching.has(sessionId));

  for (const sessionId of targets) {
    state.messagePrefetching.add(sessionId);
    void (async () => {
      try {
        await loadMessages(sessionId);
      } catch {}
      state.messagePrefetching.delete(sessionId);
    })();
  }
}

export { getSessionPreview };
