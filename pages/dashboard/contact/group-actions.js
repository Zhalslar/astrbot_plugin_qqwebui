import { apiPost } from "../core/api.js";
import { state } from "../core/state.js";
import { text } from "../core/utils.js";

const ROLE_RANK = { member: 1, admin: 2, owner: 3 };

export function currentGroupSelfRole() {
  const selfId = text(state.status?.login?.user_id).trim();
  if (!selfId) {
    return "";
  }
  return text(state.groupMemberByUserId.get(selfId)?.role).trim().toLowerCase();
}

export function canEditGroupCards() {
  return ROLE_RANK[currentGroupSelfRole()] >= ROLE_RANK.admin;
}

export function canEditGroupSpecialTitles() {
  return currentGroupSelfRole() === "owner";
}

function patchGroupMessageSenders(groupId, userId, values) {
  const cleanGroupId = text(groupId).trim();
  const cleanUserId = text(userId).trim();
  for (const [sessionId, rows] of state.messagesBySession.entries()) {
    if (sessionId !== `group:${cleanGroupId}` || !Array.isArray(rows)) {
      continue;
    }
    state.messagesBySession.set(
      sessionId,
      rows.map((item) => {
        const itemUserId = text(item?.user_id || item?.sender?.user_id).trim();
        if (itemUserId !== cleanUserId) {
          return item;
        }
        return {
          ...item,
          sender: {
            ...(item.sender || {}),
            ...values,
          },
        };
      })
    );
  }
}

function emitGroupProfileUpdated(detail = {}) {
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent("qqwebui:group-profile-updated", { detail }));
  }, 0);
}

export async function saveGroupName(groupId, groupName) {
  const cleanGroupId = text(groupId).trim();
  const cleanGroupName = text(groupName).trim();
  const data = await apiPost("page/action/group-name", {
    group_id: cleanGroupId,
    group_name: cleanGroupName,
  });
  const savedName = text(data.group_name || cleanGroupName).trim();
  state.contacts = state.contacts.map((item) =>
    item?.message_type === "group" && text(item.target_id).trim() === cleanGroupId
      ? { ...item, title: savedName }
      : item
  );
  state.sessions = state.sessions.map((item) =>
    item?.session_id === `group:${cleanGroupId}` ? { ...item, title: savedName } : item
  );
  emitGroupProfileUpdated({ groupId: cleanGroupId, type: "group-name" });
  return savedName;
}

export async function saveGroupMemberCard(groupId, userId, card) {
  const cleanGroupId = text(groupId).trim();
  const cleanUserId = text(userId).trim();
  const cleanCard = text(card).trim();
  const data = await apiPost("page/action/group-card", {
    group_id: cleanGroupId,
    user_id: cleanUserId,
    card: cleanCard,
  });
  const savedCard = text(data.card ?? cleanCard).trim();
  state.groupMembers = state.groupMembers.map((item) =>
    text(item?.user_id).trim() === cleanUserId ? { ...item, card: savedCard } : item
  );
  state.groupMemberByUserId = new Map(
    state.groupMembers
      .map((item) => [text(item?.user_id).trim(), item])
      .filter(([itemUserId]) => itemUserId)
  );
  if (
    state.activeProfileTarget?.groupId === cleanGroupId &&
    state.activeProfileTarget?.userId === cleanUserId &&
    state.profileModalMember
  ) {
    state.profileModalMember = { ...state.profileModalMember, card: savedCard };
  }
  patchGroupMessageSenders(cleanGroupId, cleanUserId, { card: savedCard });
  emitGroupProfileUpdated({
    groupId: cleanGroupId,
    userId: cleanUserId,
    type: "group-card",
  });
  return savedCard;
}

export async function saveGroupSpecialTitle(groupId, userId, specialTitle) {
  const cleanGroupId = text(groupId).trim();
  const cleanUserId = text(userId).trim();
  const cleanSpecialTitle = text(specialTitle).trim();
  const data = await apiPost("page/action/group-special-title", {
    group_id: cleanGroupId,
    user_id: cleanUserId,
    special_title: cleanSpecialTitle,
  });
  const savedTitle = text(data.special_title ?? cleanSpecialTitle).trim();
  state.groupMembers = state.groupMembers.map((item) =>
    text(item?.user_id).trim() === cleanUserId ? { ...item, title: savedTitle } : item
  );
  state.groupMemberByUserId = new Map(
    state.groupMembers
      .map((item) => [text(item?.user_id).trim(), item])
      .filter(([itemUserId]) => itemUserId)
  );
  if (
    state.activeProfileTarget?.groupId === cleanGroupId &&
    state.activeProfileTarget?.userId === cleanUserId &&
    state.profileModalMember
  ) {
    state.profileModalMember = { ...state.profileModalMember, title: savedTitle };
  }
  emitGroupProfileUpdated({
    groupId: cleanGroupId,
    userId: cleanUserId,
    type: "group-special-title",
  });
  return savedTitle;
}
