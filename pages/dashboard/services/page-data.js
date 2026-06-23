import { apiGet, apiPost } from "../api.js";
import {
  areMemberListsEqual,
  areMessageListsEqual,
  areSessionListsEqual,
} from "../comparators.js";
import { els } from "../dom.js";
import { t } from "../i18n.js";
import { ensureMediaObjectUrl, hydrateMessageAttachments, hydrateMessageSegments } from "../media.js";
import { renderFacePicker, updateSendAvailability } from "../renderers/composer.js";
import { renderMembers } from "../renderers/members.js";
import { renderMessages } from "../renderers/messages.js";
import { renderContacts, renderSessions } from "../renderers/sidebar.js";
import { renderStatus } from "../status.js";
import { state } from "../store.js";
import { text } from "../utils.js";

let openSessionAction = async () => {};

export function registerOpenSessionAction(callback) {
  openSessionAction = callback;
}

export function getSessionSummary(sessionId) {
  return state.sessions.find((item) => item.session_id === sessionId) || null;
}

export async function loadStatus() {
  state.status = await apiGet("page/status");
  renderStatus();
}

export async function loadSessions() {
  const data = await apiGet("page/sessions", {
    keyword: state.sessionKeyword,
    limit: 200,
  });
  const items = data.items || [];
  const changed = !areSessionListsEqual(state.sessions, items);
  state.sessions = items;
  if (changed) {
    renderSessions(openSessionAction);
  }
  void prefetchRecentSessionMessages();
  return changed;
}

export async function loadContacts(force = false) {
  if (force) {
    await apiPost("page/contacts/refresh", { force: true });
  }
  const data = await apiGet("page/contacts", {
    scope: "all",
    keyword: state.sessionKeyword,
  });
  state.contacts = data.items || [];
  renderContacts(openSessionAction);
}

export async function loadMessages(sessionId, options = {}) {
  const { hydrate = true } = options;
  const data = await apiGet("page/messages", {
    session_id: sessionId,
    limit: 80,
  });
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const existing = state.messagesBySession.get(sessionId) || [];
  const cachedByMessageId = new Map(
    existing.map((item) => [text(item.message_id).trim(), item])
  );
  const items = rawItems.map((item) => {
    const cached = cachedByMessageId.get(text(item.message_id).trim());
    if (!cached) {
      return item;
    }
    const attachments = Array.isArray(item.attachments)
      ? item.attachments.map((attachment) => {
          const mediaKey = text(attachment?.media_key).trim();
          const matched = (cached.attachments || []).find((candidate) => {
            if (mediaKey) {
              return text(candidate?.media_key).trim() === mediaKey;
            }
            return (
              text(candidate?.name).trim() === text(attachment?.name).trim() &&
              text(candidate?.kind).trim() === text(attachment?.kind).trim()
            );
          });
          return matched?.preview_url && !attachment.preview_url
            ? { ...attachment, preview_url: matched.preview_url }
            : attachment;
        })
      : item.attachments;
    const segments = Array.isArray(item.segments)
      ? item.segments.map((segment) => {
          if (text(segment?.type).trim().toLowerCase() !== "face") {
            return segment;
          }
          const matched = (cached.segments || []).find((candidate) => {
            if (text(candidate?.type).trim().toLowerCase() !== "face") {
              return false;
            }
            const candidateMediaKey = text(candidate?.media_key).trim();
            const segmentMediaKey = text(segment?.media_key).trim();
            if (candidateMediaKey && segmentMediaKey) {
              return candidateMediaKey === segmentMediaKey;
            }
            return text(candidate?.id).trim() === text(segment?.id).trim();
          });
          return matched?.preview_url && !segment.preview_url
            ? { ...segment, preview_url: matched.preview_url }
            : segment;
        })
      : item.segments;
    return attachments !== item.attachments || segments !== item.segments
      ? { ...item, attachments, segments }
      : item;
  });
  const changed = !areMessageListsEqual(existing, items);
  state.messagesBySession.set(sessionId, items);
  updateSendAvailability();
  if (state.activeSessionId === sessionId && (!existing.length || changed)) {
    renderMessages({ forceScrollToBottom: !existing.length });
  }
  if (!hydrate) {
    return changed;
  }
  const hydrationTicket = ++state.messageHydrationTicket;
  void (async () => {
    const hydrated = await hydrateMessageSegments(
      await hydrateMessageAttachments(items)
    );
    if (
      state.messageHydrationTicket !== hydrationTicket ||
      state.activeSessionId !== sessionId
    ) {
      return;
    }
    state.messagesBySession.set(sessionId, hydrated);
    renderMessages({ forceScrollToBottom: true });
  })();
  return changed;
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
        await loadMessages(sessionId, { hydrate: false });
      } catch {}
      state.messagePrefetching.delete(sessionId);
    })();
  }
}

export async function loadFaces() {
  const data = await apiGet("page/faces");
  state.faces = Array.isArray(data.items) ? data.items : [];
  const pending = state.faces.filter((item) => {
    const mediaKey = text(item.media_key).trim();
    return mediaKey && !state.warmedFaceKeys.has(mediaKey);
  });
  const warmFaceBatch = async (items) => {
    await Promise.all(
      items.map(async (item) => {
        if (state.faceWarmupPaused) {
          return;
        }
        const mediaKey = text(item.media_key).trim();
        if (!mediaKey || state.warmedFaceKeys.has(mediaKey)) {
          return;
        }
        try {
          item.preview_url = await ensureMediaObjectUrl({ media_key: mediaKey });
          state.warmedFaceKeys.add(mediaKey);
        } catch {}
      })
    );
  };

  await warmFaceBatch(pending.slice(0, 24));

  const remaining = pending.slice(24);
  if (remaining.length && !state.faceWarmupScheduled) {
    state.faceWarmupScheduled = true;
    const schedule =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback.bind(window)
        : (callback) => window.setTimeout(callback, 120);
    schedule(async () => {
      const batchSize = 12;
      for (let index = 0; index < remaining.length; index += batchSize) {
        if (state.faceWarmupPaused) {
          break;
        }
        await warmFaceBatch(remaining.slice(index, index + batchSize));
        await new Promise((resolve) => window.setTimeout(resolve, 32));
      }
      state.faceWarmupScheduled = false;
    });
  }
  await renderFacePicker(loadSessions, renderMessages);
}

export async function loadGroupMembers(force = false) {
  const session = state.sessions.find((item) => item.session_id === state.activeSessionId);
  if (!session || session.chat_type !== "group") {
    state.members = [];
    renderMembers();
    return;
  }
  const data = await apiGet("page/group/members", {
    group_id: session.target_id,
    force: force ? "true" : "",
  });
  const items = data.items || [];
  const changed = !areMemberListsEqual(state.members, items);
  state.members = items;
  if (changed || force) {
    renderMembers();
    if (state.activeSessionId === session.session_id) {
      renderMessages();
    }
  }
}

export function showLoadingMessages() {
  els.messageListContent.className = "message-list-content empty-state";
  els.messageListContent.textContent = t(
    "pages.dashboard.status.loading_messages",
    "Loading messages..."
  );
}
