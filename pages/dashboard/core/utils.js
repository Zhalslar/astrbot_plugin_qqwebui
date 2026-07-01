import { bridge } from "./dom.js";
import { state } from "./state.js";

export function text(value) {
  return String(value ?? "");
}

export function getLocale() {
  const locale = text(state.locale || bridge?.getLocale?.() || "zh-CN").trim();
  return locale || "zh-CN";
}

export function clampText(value, maxLength = 120) {
  const normalized = text(value).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

export function avatarUrl(id, type) {
  const clean = text(id).trim();
  if (!clean) {
    return "";
  }
  if (type === "group") {
    return `https://p.qlogo.cn/gh/${clean}/${clean}/100`;
  }
  return `https://q1.qlogo.cn/g?b=qq&nk=${clean}&s=100`;
}

export function setAvatar(target, url, fallbackText) {
  target.textContent = fallbackText;
  target.replaceChildren();
  if (!url) {
    target.textContent = fallbackText;
    return;
  }
  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  img.src = url;
  img.onerror = () => {
    target.replaceChildren();
    target.textContent = fallbackText;
  };
  target.append(img);
}

export function formatTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) {
    return "--";
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  const now = new Date();
  const locale = getLocale();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    return date.toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return date.toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
  });
}
