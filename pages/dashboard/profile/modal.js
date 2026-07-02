import { apiGet, apiPost } from "../core/api.js";
import { els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { avatarUrl, setAvatar, text } from "../core/utils.js";
import { loadContacts, loadGroupMembers } from "../contact/service.js";
import { renderGroupMembers } from "../contact/members.js";
import { renderMessages } from "../session/messages.js";
import { openSession } from "../session/service.js";

function roleLabel(role) {
  const normalized = text(role).trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  return t(`pages.dashboard.profile.roles.${normalized}`, normalized);
}

function sexLabel(sex) {
  const normalized = text(sex).trim().toLowerCase();
  if (!normalized || normalized === "unknown") {
    return "";
  }
  return t(`pages.dashboard.profile.sex.${normalized}`, normalized);
}

function buildTag(label, tone = "") {
  const chip = document.createElement("span");
  chip.className = `profile-tag${tone ? ` is-${tone}` : ""}`;
  chip.textContent = label;
  return chip;
}

function setModalStatus(message, tone = "") {
  const content = text(message).trim();
  els.profileModalStatus.className = `profile-modal-status${content ? "" : " is-hidden"}${
    tone ? ` is-${tone}` : ""
  }`;
  els.profileModalStatus.textContent = content;
}

function normalizeValue(value) {
  if (value == null) {
    return "";
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => normalizeValue(item))
      .filter((item) => text(item).trim());
    return parts.length ? parts.join(", ") : "";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => !isEmptyFieldValue("", item));
    return entries.length ? JSON.stringify(Object.fromEntries(entries)) : "";
  }
  if (typeof value === "boolean") {
    return value ? t("pages.dashboard.profile.boolean.yes", "Yes") : "";
  }
  if (typeof value === "number") {
    return value ? String(value) : "";
  }
  const normalized = text(value).trim();
  if (!normalized || normalized === "-" || normalized === "0-0-0") {
    return "";
  }
  return normalized;
}

function formatFieldValue(key, value) {
  if (key === "labels") {
    if (Array.isArray(value)) {
      const parts = value.map((item) => text(item).trim()).filter(Boolean);
      return parts.length ? parts.join(", ") : "";
    }
    const normalized = text(value).trim();
    return !normalized || normalized === "[]" ? "" : normalized;
  }
  if (key === "role") {
    return roleLabel(value);
  }
  if (key === "sex") {
    return sexLabel(value);
  }
  if (
    key === "join_time" ||
    key === "last_sent_time" ||
    key === "title_expire_time" ||
    key === "reg_time"
  ) {
    return formatTimestamp(value);
  }
  return normalizeValue(value);
}

function isEmptyFieldValue(key, value) {
  if (
    key === "birthday_year" ||
    key === "birthday_month" ||
    key === "birthday_day" ||
    key === "is_friend" ||
    key === "display_name"
  ) {
    return true;
  }
  return !text(formatFieldValue(key, value)).trim();
}

function birthdayValue(user) {
  const year = Number(user?.birthday_year || 0);
  const month = Number(user?.birthday_month || 0);
  const day = Number(user?.birthday_day || 0);
  if (!year || !month || !day) {
    return "";
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatTimestamp(value) {
  const numeric = Number(value || 0);
  if (!numeric) {
    return "";
  }
  const date = new Date(numeric * 1000);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(state.locale || "zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function fieldLabel(key) {
  const fallbackMap = {
    display_name: "Display Name",
    nickname: "Nickname",
    remark: "Remark",
    group_card: "Group Card",
    qid: "QID",
    sex: "Sex",
    age: "Age",
    area: "Area",
    user_id: "QQ",
    uid: "UID",
    qqLevel: "QQ Level",
    long_nick: "Long Nick",
    reg_time: "Registered At",
    is_vip: "VIP",
    is_years_vip: "Years VIP",
    vip_level: "VIP Level",
    status: "Status",
    login_days: "Login Days",
    birthday_year: "Birth Year",
    birthday_month: "Birth Month",
    birthday_day: "Birth Day",
    kBloodType: "Blood Type",
    phoneNum: "Phone",
    eMail: "Email",
    homeTown: "Home Town",
    country: "Country",
    province: "Province",
    city: "City",
    address: "Address",
    makeFriendCareer: "Career",
    labels: "Labels",
    group_id: "Group ID",
    card: "Card",
    join_time: "Join Time",
    last_sent_time: "Last Sent",
    level: "Level",
    role: "Role",
    unfriendly: "Unfriendly",
    is_robot: "Robot",
    title: "Title",
    title_expire_time: "Title Expires",
    card_changeable: "Card Changeable",
  };
  return t(`pages.dashboard.profile.fields.${key}`, fallbackMap[key] || key);
}

function buildProfileSections(user, member) {
  const sections = [];
  const basicItems = [
    ["nickname", user?.nickname || member?.nickname || ""],
    ["remark", user?.remark || ""],
    ["group_card", member?.card || ""],
    ["qid", user?.qid || ""],
    ["sex", user?.sex || member?.sex || ""],
    ["age", user?.age || member?.age || 0],
    ["area", user?.area || member?.area || ""],
    ["birthday", birthdayValue(user)],
  ];
  const qqItems = user
    ? Object.entries(user).filter(
        ([key]) =>
          ![
            "user_id",
            "nickname",
            "remark",
            "is_friend",
            "qid",
            "sex",
            "age",
            "area",
            "birthday_year",
            "birthday_month",
            "birthday_day",
          ].includes(key)
      )
    : [];
  const memberItems = member
    ? Object.entries(member).filter(
        ([key]) =>
          !["group_id", "user_id", "nickname", "card", "sex", "age", "area"].includes(key)
      )
    : [];

  if (basicItems.some(([key, value]) => !isEmptyFieldValue(key, value))) {
    sections.push({
      title: t("pages.dashboard.profile.sections.basic", "Basic"),
      items: basicItems,
    });
  }
  if (qqItems.length) {
    sections.push({
      title: t("pages.dashboard.profile.sections.qq", "QQ Profile"),
      items: qqItems,
    });
  }
  if (memberItems.length) {
    sections.push({
      title: t("pages.dashboard.profile.sections.group", "Group Profile"),
      items: memberItems,
    });
  }
  return sections;
}

function renderProfileSections() {
  els.profileModalBody.replaceChildren();
  const sections = buildProfileSections(state.profileModalUser, state.profileModalMember);
  if (!sections.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state profile-modal-empty";
    empty.textContent = t(
      "pages.dashboard.profile.empty",
      "Profile details will appear here after refresh."
    );
    els.profileModalBody.append(empty);
    return;
  }

  for (const section of sections) {
    const rows = Array.isArray(section?.items) ? section.items : [];
    const block = document.createElement("section");
    block.className = "profile-section";
    const title = document.createElement("h3");
    title.textContent = text(section.title).trim();
    const grid = document.createElement("div");
    grid.className = "profile-grid";

    for (const entry of rows) {
      const [key, rawValue] = Array.isArray(entry) ? entry : [entry?.[0], entry?.[1]];
      if (isEmptyFieldValue(key, rawValue)) {
        continue;
      }
      const value = formatFieldValue(key, rawValue);
      const row = document.createElement("div");
      row.className = "profile-row";
      const label = document.createElement("span");
      label.className = "profile-row-label";
      label.textContent = fieldLabel(key);
      const content = document.createElement("strong");
      content.className = "profile-row-value";
      content.textContent = value;
      row.append(label, content);
      grid.append(row);
    }

    if (!grid.childElementCount) {
      continue;
    }
    block.append(title, grid);
    els.profileModalBody.append(block);
  }
}

function renderProfileModal() {
  els.profileModalCloseBtn.title = t("pages.dashboard.profile.close", "Close");
  els.profileModalCloseBtn.setAttribute("aria-label", els.profileModalCloseBtn.title);
  els.profileModalBackdrop.setAttribute(
    "aria-label",
    t("pages.dashboard.profile.close", "Close")
  );
  const refreshLabel = state.profileModalRefreshing
    ? t("pages.dashboard.profile.refreshing", "Refreshing...")
    : t("pages.dashboard.profile.refresh", "Refresh");
  els.profileModalRefreshBtn.title = refreshLabel;
  els.profileModalRefreshBtn.setAttribute("aria-label", refreshLabel);
  els.profileModalRefreshBtn.classList.toggle("is-spinning", state.profileModalRefreshing);
  const open = state.profileModalOpen;
  els.profileModal.classList.toggle("is-hidden", !open);
  els.profileModal.setAttribute("aria-hidden", open ? "false" : "true");
  document.body.classList.toggle("has-modal-open", open);
  if (!open) {
    return;
  }

  const user = state.profileModalUser;
  const member = state.profileModalMember;
  const userId =
    text(user?.user_id || member?.user_id || state.activeProfileTarget?.userId).trim();
  const displayName =
    text(member?.card || user?.remark || user?.nickname || member?.nickname || userId).trim() ||
    t("pages.dashboard.profile.title", "Profile");
  setAvatar(
    els.profileModalAvatar,
    avatarUrl(userId, "private"),
    displayName.slice(0, 1).toUpperCase()
  );
  els.profileModalName.textContent = displayName;

  const metaParts = [`QQ ${userId}`];
  if (user?.is_friend) {
    metaParts.push(t("pages.dashboard.profile.friend", "Friend"));
  }
  if (member?.role) {
    metaParts.push(roleLabel(member.role));
  }
  els.profileModalMeta.textContent = metaParts.join(" / ");
  els.profileModalTags.replaceChildren();
  if (user?.is_friend) {
    els.profileModalTags.append(buildTag(t("pages.dashboard.profile.friend", "Friend"), "accent"));
  }
  const memberRole = text(member?.role).trim().toLowerCase();
  const memberTitle = text(member?.title).trim();
  if (memberRole === "member" && memberTitle) {
    els.profileModalTags.append(buildTag(memberTitle, "title"));
  } else if (memberRole) {
    els.profileModalTags.append(buildTag(roleLabel(memberRole), "muted"));
  }
  if (memberRole !== "member" && memberTitle) {
    els.profileModalTags.append(buildTag(memberTitle, "title"));
  }
  els.profileModalRefreshBtn.disabled =
    state.profileModalRefreshing || state.profileModalLoading;
  if (state.profileModalLoading) {
    setModalStatus(
      t("pages.dashboard.profile.loading", "Loading cached profile..."),
      ""
    );
  } else if (state.profileModalError) {
    setModalStatus(state.profileModalError, "danger");
  } else {
    setModalStatus("");
  }
  renderProfileSections();
}

function applyProfilePayload(data) {
  state.profileModalUser = data?.user && typeof data.user === "object" ? data.user : null;
  state.profileModalMember = data?.member && typeof data.member === "object" ? data.member : null;
}

export async function openProfileModal(target) {
  state.activeProfileTarget = target
    ? {
        userId: text(target.userId).trim(),
        groupId: text(target.groupId).trim(),
      }
    : null;
  state.profileModalOpen = true;
  state.profileModalLoading = true;
  state.profileModalRefreshing = false;
  state.profileModalError = "";
  state.profileModalUser = target
    ? {
        user_id: text(target.userId).trim(),
        nickname: text(target.nickname).trim(),
        remark: text(target.remark).trim(),
        is_friend: Boolean(target.isFriend),
      }
    : null;
  state.profileModalMember = target?.groupId
    ? {
        group_id: text(target.groupId).trim(),
        user_id: text(target.userId).trim(),
        card: text(target.displayName).trim(),
        role: text(target.role).trim(),
        title: text(target.title).trim(),
      }
    : null;
  renderProfileModal();
  try {
    const data = await apiGet("page/contact/profile", {
      user_id: state.activeProfileTarget?.userId || "",
      group_id: state.activeProfileTarget?.groupId || "",
    });
    applyProfilePayload(data);
    state.profileModalError = "";
  } catch (error) {
    state.profileModalError =
      error.message ||
      t("pages.dashboard.profile.load_failed", "Failed to load cached profile.");
  } finally {
    state.profileModalLoading = false;
    renderProfileModal();
  }
}

export function closeProfileModal() {
  state.profileModalOpen = false;
  state.profileModalLoading = false;
  state.profileModalRefreshing = false;
  state.profileModalError = "";
  renderProfileModal();
}

export async function refreshProfileModal() {
  if (!state.activeProfileTarget?.userId || state.profileModalRefreshing) {
    return;
  }
  state.profileModalRefreshing = true;
  state.profileModalError = "";
  renderProfileModal();
  try {
    const data = await apiPost("page/contact/profile/refresh", {
      user_id: state.activeProfileTarget.userId,
      group_id: state.activeProfileTarget.groupId || "",
      force: true,
    });
    applyProfilePayload(data);
    state.profileModalError = "";
    await loadContacts(openSession, false);
    await loadGroupMembers(false);
    renderGroupMembers();
    renderMessages();
  } catch (error) {
    state.profileModalError =
      error.message ||
      t("pages.dashboard.profile.refresh_failed", "Failed to refresh profile.");
  } finally {
    state.profileModalRefreshing = false;
    renderProfileModal();
  }
}

export function bindProfileModalEvents() {
  els.profileModalBackdrop.addEventListener("click", () => {
    closeProfileModal();
  });
  els.profileModalCloseBtn.addEventListener("click", () => {
    closeProfileModal();
  });
  els.profileModalRefreshBtn.addEventListener("click", () => {
    void refreshProfileModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.profileModalOpen) {
      closeProfileModal();
    }
  });
}

export { renderProfileModal };
