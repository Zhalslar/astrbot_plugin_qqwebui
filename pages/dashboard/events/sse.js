import { subscribeSSE, unsubscribeSSE } from "../core/api.js";
import { state } from "../core/state.js";
import { text } from "../core/utils.js";
import { syncActiveSessionView } from "../session/messages.js";
import { applyIncomingMessage, applyIncomingSession } from "../session/service.js";

export function handleSseEvent(event) {
  const eventType = text(event?.eventType || event?.type).trim().toLowerCase();
  const payload = event?.parsed;
  if (!payload || typeof payload !== "object") {
    return;
  }
  if (eventType === "ready") {
    const activeSessionId = text(payload.last_active_session_id).trim();
    if (activeSessionId && !state.activeSessionId) {
      state.activeSessionId = activeSessionId;
    }
    return;
  }
  if (payload.last_active_session_id) {
    state.status = {
      ...(state.status || {}),
      ui: {
        ...((state.status || {}).ui || {}),
        last_active_session_id: payload.last_active_session_id,
      },
    };
  }
  if (eventType === "message") {
    void applyIncomingMessage(payload);
    return;
  }
  if (eventType === "session") {
    void applyIncomingSession(payload.session);
  }
}

export function scheduleSseReconnect() {
  state.sseConnected = false;
  state.sseSubscriptionId = "";
  window.clearTimeout(state.sseReconnectTimerId);
  state.sseReconnectTimerId = window.setTimeout(() => {
    void connectEventStream();
  }, 1500);
}

export async function connectEventStream() {
  if (state.sseSubscriptionId) {
    return state.sseSubscriptionId;
  }
  window.clearTimeout(state.sseReconnectTimerId);
  const subscriptionId = await subscribeSSE("page/events", {
    onOpen() {
      state.sseConnected = true;
      syncActiveSessionView();
    },
    onError: scheduleSseReconnect,
    onMessage: handleSseEvent,
  });
  state.sseSubscriptionId = subscriptionId;
  return subscriptionId;
}

export async function disconnectEventStream() {
  window.clearTimeout(state.sseReconnectTimerId);
  const subscriptionId = state.sseSubscriptionId;
  state.sseSubscriptionId = "";
  state.sseConnected = false;
  if (!subscriptionId) {
    return;
  }
  await unsubscribeSSE(subscriptionId);
}
