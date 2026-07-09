import { els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { avatarUrl, setAvatar, text } from "../core/utils.js";
import { openProfileModal } from "../profile/modal.js";

let memberOpenSessionHandler = null;

export function setGroupMemberOpenSessionHandler(handler) {
  memberOpenSessionHandler = typeof handler === "function" ? handler : null;
}

function roleBadgeLabel(role) {
  if (role === "owner") {
    return t("pages.dashboard.members.roles.owner", "owner");
  }
  if (role === "admin") {
    return t("pages.dashboard.members.roles.admin", "admin");
  }
  return t("pages.dashboard.members.roles.member", "member");
}

export function findGroupMember(userId) {
  return state.groupMemberByUserId.get(text(userId).trim()) || null;
}

export function buildGroupBadge(member) {
  const role = ["owner", "admin"].includes(text(member?.role).trim().toLowerCase())
    ? text(member.role).trim().toLowerCase()
    : "member";
  const level = text(member?.level).trim();
  const title = text(member?.title).trim();
  return {
    text: `${level ? `LV${level} ` : ""}${title || roleBadgeLabel(role)}`.trim(),
    role: role === "member" && title ? "title" : role,
    name: text(member?.card || member?.nickname || member?.user_id).trim(),
  };
}

export function renderGroupMembers() {
  const session = state.sessions.find((item) => item.session_id === state.activeSessionId);
  const isGroup = session?.message_type === "group";
  if (!isGroup) {
    els.memberList.className = "member-list empty-state";
    els.memberList.textContent = t(
      "pages.dashboard.members.open_group",
      "Open a group session to inspect member cache."
    );
    return;
  }
  if (!state.groupMembers.length) {
    els.memberList.className = "member-list empty-state";
    els.memberList.textContent = t(
      "pages.dashboard.members.empty",
      "No group members loaded yet."
    );
    return;
  }
  els.memberList.className = "member-list";
  els.memberList.replaceChildren();
  for (const member of state.groupMembers) {
    const row = document.createElement("div");
    row.className = "member-item";
    const displayName = text(member.card || member.nickname || member.user_id).trim();
    const avatarButton = document.createElement("button");
    avatarButton.type = "button";
    avatarButton.className = "avatar-button";
    avatarButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void openProfileModal({
        userId: member.user_id,
        groupId: session?.target_id || "",
        displayName,
        subtitle: `QQ ${member.user_id}`,
        role: text(member.role).trim().toLowerCase(),
        title: text(member.title).trim(),
      });
    });
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    setAvatar(
      avatar,
      avatarUrl(member.user_id, "private"),
      displayName.slice(0, 1).toUpperCase()
    );
    avatarButton.append(avatar);
    const main = document.createElement("div");
    main.className = "member-main";
    main.addEventListener("dblclick", (event) => {
      const userId = text(member.user_id).trim();
      if (!userId || !memberOpenSessionHandler) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void memberOpenSessionHandler(`private:${userId}`);
    });
    const title = document.createElement("strong");
    title.textContent = displayName;
    const subtitle = document.createElement("span");
    subtitle.textContent = t("pages.dashboard.members.item_meta", "{role} - QQ {id}")
      .replace("{role}", roleBadgeLabel(text(member.role).trim().toLowerCase()))
      .replace("{id}", String(member.user_id));
    main.append(title, subtitle);
    row.append(avatarButton, main);
    els.memberList.append(row);
  }
}
