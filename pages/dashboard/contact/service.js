import { apiGet, apiPost } from "../core/api.js";
import { state } from "../core/state.js";
import { renderGroupMembers } from "./members.js";
import { renderContactList } from "./sidebar.js";
import { renderMessages } from "../session/messages.js";

export async function loadContacts(openSession, force = false) {
  if (force) {
    await apiPost("page/contacts/refresh", { force: true });
  }
  const data = await apiGet("page/contacts", {
    scope: "all",
    keyword: state.searchKeyword,
  });
  state.contacts = Array.isArray(data.items) ? data.items : [];
  renderContactList(openSession);
}

export async function loadGroupMembers(force = false) {
  const session = state.sessions.find((item) => item.session_id === state.activeSessionId);
  if (!session || session.message_type !== "group") {
    state.groupMembers = [];
    renderGroupMembers();
    return;
  }
  const data = await apiGet("page/group/members", {
    group_id: session.target_id,
    force: force ? "true" : "",
  });
  const items = Array.isArray(data.items) ? data.items : [];
  const changed = JSON.stringify(state.groupMembers) !== JSON.stringify(items);
  state.groupMembers = items;
  if (changed || force) {
    renderGroupMembers();
    if (state.activeSessionId === session.session_id) {
      renderMessages();
    }
  }
}
