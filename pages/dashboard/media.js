import { apiGet } from "./api.js";
import { t } from "./i18n.js";
import { state } from "./store.js";
import { text } from "./utils.js";

export function decodeBase64ToUint8Array(base64Text) {
  const normalized = text(base64Text).trim();
  const binary = window.atob(normalized);
  const length = binary.length;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function ensureMediaObjectUrl(attachment) {
  const directUrl = text(attachment?.url).trim();
  if (directUrl) {
    return directUrl;
  }
  const mediaKey = text(attachment?.media_key).trim();
  if (!mediaKey) {
    return "";
  }
  const cached = state.mediaObjectUrls.get(mediaKey);
  if (cached) {
    return cached;
  }
  const pending = state.mediaObjectUrlPending.get(mediaKey);
  if (pending) {
    return pending;
  }
  const request = (async () => {
    const result = await apiGet("page/media/content", { key: mediaKey });
    const bytes = decodeBase64ToUint8Array(result?.content_base64);
    const blob = new Blob([bytes], {
      type: text(result?.content_type).trim() || "application/octet-stream",
    });
    const objectUrl = URL.createObjectURL(blob);
    state.mediaObjectUrls.set(mediaKey, objectUrl);
    return objectUrl;
  })();
  state.mediaObjectUrlPending.set(mediaKey, request);
  try {
    return await request;
  } finally {
    state.mediaObjectUrlPending.delete(mediaKey);
  }
}

export async function ensureSegmentPreviewUrl(segment) {
  const directUrl = text(segment?.preview_url || segment?.url).trim();
  if (directUrl) {
    return directUrl;
  }
  const mediaKey = text(segment?.media_key).trim();
  if (!mediaKey) {
    return "";
  }
  const cached = state.mediaObjectUrls.get(mediaKey);
  if (cached) {
    return cached;
  }
  const result = await apiGet("page/media/content", { key: mediaKey });
  const bytes = decodeBase64ToUint8Array(result?.content_base64);
  const blob = new Blob([bytes], {
    type: text(result?.content_type).trim() || "image/gif",
  });
  const objectUrl = URL.createObjectURL(blob);
  state.mediaObjectUrls.set(mediaKey, objectUrl);
  return objectUrl;
}

export function isImageAttachment(attachment) {
  const name = text(attachment?.name).toLowerCase();
  const contentType = text(attachment?.content_type).toLowerCase();
  return (
    attachment?.kind === "image" ||
    contentType.startsWith("image/") ||
    /\.(jpg|jpeg|png|gif|webp|bmp|svg|heic|heif)$/.test(name)
  );
}

export function isVideoAttachment(attachment) {
  const name = text(attachment?.name).toLowerCase();
  const contentType = text(attachment?.content_type).toLowerCase();
  return (
    attachment?.kind === "video" ||
    contentType.startsWith("video/") ||
    /\.(mp4|mov|m4v|webm|mkv|avi)$/.test(name)
  );
}

export function isAudioAttachment(attachment) {
  const name = text(attachment?.name).toLowerCase();
  const contentType = text(attachment?.content_type).toLowerCase();
  return (
    attachment?.kind === "audio" ||
    contentType.startsWith("audio/") ||
    /\.(mp3|wav|ogg|m4a|aac|flac|amr)$/.test(name)
  );
}

export function attachmentKindLabel(attachment) {
  if (isImageAttachment(attachment)) {
    return t("pages.dashboard.attachments.image", "Image");
  }
  if (isVideoAttachment(attachment)) {
    return t("pages.dashboard.attachments.video", "Video");
  }
  if (isAudioAttachment(attachment)) {
    return t("pages.dashboard.attachments.audio", "Audio");
  }
  return t("pages.dashboard.attachments.file", "File");
}

export function segmentTextParts(segment) {
  const segType = text(segment?.type).trim().toLowerCase();
  if (segType === "text") {
    return text(segment?.text);
  }
  if (segType === "at") {
    return `@${text(segment?.name || segment?.qq).trim()}`;
  }
  return "";
}

export function hasRenderableSegmentBody(item) {
  const segments = Array.isArray(item?.segments) ? item.segments : [];
  return segments.some((segment) => {
    const segType = text(segment?.type).trim().toLowerCase();
    if (segType === "face") {
      return Boolean(
        text(segment?.preview_url || segment?.url || segment?.media_key).trim()
      );
    }
    return Boolean(segmentTextParts(segment));
  });
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

export async function hydrateMessageSegments(items) {
  return Promise.all(
    (items || []).map(async (item) => {
      const segments = Array.isArray(item?.segments) ? item.segments : [];
      if (!segments.length) {
        return item;
      }
      const hydratedSegments = await Promise.all(
        segments.map(async (segment) => {
          if (text(segment?.type).trim().toLowerCase() !== "face") {
            return segment;
          }
          try {
            const previewUrl = await ensureSegmentPreviewUrl(segment);
            return previewUrl ? { ...segment, preview_url: previewUrl } : segment;
          } catch {
            return segment;
          }
        })
      );
      return { ...item, segments: hydratedSegments };
    })
  );
}

export async function hydrateMessageAttachments(items) {
  return Promise.all(
    (items || []).map(async (item) => {
      if (!Array.isArray(item.attachments) || !item.attachments.length) {
        return item;
      }
      const attachments = await Promise.all(
        item.attachments.map(async (attachment) => {
          if (
            !isImageAttachment(attachment) &&
            !isVideoAttachment(attachment) &&
            !isAudioAttachment(attachment)
          ) {
            return attachment;
          }
          try {
            const previewUrl = await ensureMediaObjectUrl(attachment);
            return { ...attachment, preview_url: previewUrl };
          } catch {
            return attachment;
          }
        })
      );
      return { ...item, attachments };
    })
  );
}
