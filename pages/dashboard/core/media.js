import { t } from "./i18n.js";
import { text } from "./utils.js";

export async function ensureDirectMediaUrl(resource) {
  const directUrl = text(resource?.url).trim();
  return directUrl;
}

export function isImageSegment(segment) {
  return text(segment?.type).trim().toLowerCase() === "image";
}

export function isVideoSegment(segment) {
  return text(segment?.type).trim().toLowerCase() === "video";
}

export function isAudioSegment(segment) {
  return text(segment?.type).trim().toLowerCase() === "record";
}

export function isFileSegment(segment) {
  return text(segment?.type).trim().toLowerCase() === "file";
}

export function segmentKindLabel(segment) {
  if (isImageSegment(segment)) {
    return t("pages.dashboard.attachments.image", "Image");
  }
  if (isVideoSegment(segment)) {
    return t("pages.dashboard.attachments.video", "Video");
  }
  if (isAudioSegment(segment)) {
    return t("pages.dashboard.attachments.audio", "Audio");
  }
  return t("pages.dashboard.attachments.file", "File");
}

export function pendingUploadKindLabel(item) {
  const type = text(item?.type).trim().toLowerCase();
  if (type === "image") {
    return t("pages.dashboard.attachments.image", "Image");
  }
  if (type === "video") {
    return t("pages.dashboard.attachments.video", "Video");
  }
  if (type === "record") {
    return t("pages.dashboard.attachments.audio", "Audio");
  }
  return t("pages.dashboard.attachments.file", "File");
}

export function segmentTextParts(segment) {
  const segType = text(segment?.type).trim().toLowerCase();
  const segData = segment?.data && typeof segment.data === "object" ? segment.data : {};
  if (segType === "text") {
    return text(segData.text);
  }
  if (segType === "at") {
    return `@${text(segData.name || segData.qq).trim()}`;
  }
  return "";
}

export function hasRenderableSegmentBody(item) {
  const segments = Array.isArray(item?.message) ? item.message : [];
  return segments.some((segment) => Boolean(segmentTextParts(segment)));
}

export function formatFileSize(size) {
  const value = Number(size || 0);
  if (!value) {
    return "";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
