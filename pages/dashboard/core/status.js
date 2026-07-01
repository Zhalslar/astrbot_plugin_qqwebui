import { els } from "./dom.js";
import { t } from "./i18n.js";
import { state } from "./state.js";
import { avatarUrl, setAvatar } from "./utils.js";

export function statusText(message) {
  state.statusText = String(message ?? "").trim();
  els.accountMeta.textContent = state.statusText;
}

export function setStatus(message) {
  statusText(message);
}

export function renderStatus() {
  const status = state.status;
  const login = status?.login || {};
  const adapter = status?.adapter || {};
  const online = Boolean(adapter.bound && adapter.online);
  els.accountName.textContent =
    login.nickname || t("pages.dashboard.status.not_connected", "Not connected");
  statusText(
    login.user_id
      ? `QQ ${login.user_id}`
      : t("pages.dashboard.status.waiting_adapter", "Waiting for aiocqhttp")
  );
  setAvatar(
    els.accountAvatar,
    avatarUrl(login.user_id, "private"),
    (login.nickname || "Q").slice(0, 1).toUpperCase()
  );
  els.adapterDot.classList.toggle("is-online", online);
}
