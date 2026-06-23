import { els } from "../dom.js";
import { t } from "../i18n.js";
import { state } from "../store.js";
import { avatarUrl, setAvatar, text } from "../utils.js";

export function roleBadgeLabel(role) {
  if (role === "owner") {
    return t("pages.dashboard.members.roles.owner", "owner");
  }
  if (role === "admin") {
    return t("pages.dashboard.members.roles.admin", "admin");
  }
  return t("pages.dashboard.members.roles.member", "member");
}

export function findMemberProfile(senderId) {
  return state.members.find((item) => text(item.id).trim() === text(senderId).trim()) || null;
}

export function buildGroupBadge(member) {
  const extra = member?.extra || {};
  const rawRole = text(extra.role || member?.subtitle || "member").trim().toLowerCase();
  const role = rawRole === "owner" || rawRole === "admin" ? rawRole : "member";
  const level = text(extra.level).trim();
  return {
    text: `${level ? `LV${level} ` : ""}${roleBadgeLabel(role)}`.trim(),
    role,
    name: text(extra.card || member?.title || extra.nickname).trim(),
  };
}

export function renderMembers() {
  const session = state.sessions.find((item) => item.session_id === state.activeSessionId);
  const isGroup = session?.chat_type === "group";
  if (!isGroup) {
    els.memberList.className = "member-list empty-state";
    els.memberList.textContent = t(
      "pages.dashboard.members.open_group",
      "Open a group session to inspect member cache."
    );
    return;
  }
  if (!state.members.length) {
    els.memberList.className = "member-list empty-state";
    els.memberList.textContent = t(
      "pages.dashboard.members.empty",
      "No group members loaded yet."
    );
    return;
  }
  els.memberList.className = "member-list";
  els.memberList.replaceChildren();
  for (const item of state.members) {
    const row = document.createElement("div");
    row.className = "member-item";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    setAvatar(
      avatar,
      item.avatar || avatarUrl(item.id, "private"),
      text(item.title).slice(0, 1).toUpperCase()
    );
    const main = document.createElement("div");
    main.className = "member-main";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const subtitle = document.createElement("span");
    subtitle.textContent = t(
      "pages.dashboard.members.item_meta",
      "{role} - QQ {id}"
    )
      .replace("{role}", item.subtitle || t("pages.dashboard.members.roles.member", "member"))
      .replace("{id}", String(item.id));
    main.append(title, subtitle);
    row.append(avatar, main);
    els.memberList.append(row);
  }
}
