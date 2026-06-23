import { els } from "../dom.js";
import { t } from "../i18n.js";
import { renderMarkdownFragment } from "../markdown.js";
import {
  attachmentKindLabel,
  formatFileSize,
  hasRenderableSegmentBody,
  isAudioAttachment,
  isImageAttachment,
  isVideoAttachment,
  segmentTextParts,
} from "../media.js";
import { setStatus } from "../status.js";
import { state } from "../store.js";
import { avatarUrl, clampText, setAvatar, text } from "../utils.js";
import { buildGroupBadge, findMemberProfile } from "./members.js";

export function closeQuoteModal() {
  els.quoteModal.classList.add("is-hidden");
  els.quoteModal.setAttribute("aria-hidden", "true");
}

function buildMessageBodyFromSegments(item) {
  const segments = Array.isArray(item?.segments) ? item.segments : [];
  if (!segments.length) {
    return null;
  }
  const body = document.createElement("div");
  body.className = "bubble-text bubble-text-segments markdown-content";
  let hasContent = false;
  let textBuffer = "";

  function flushTextBuffer() {
    if (!textBuffer) {
      return;
    }
    body.append(renderMarkdownFragment(textBuffer, true));
    textBuffer = "";
    hasContent = true;
  }

  for (const segment of segments) {
    const segType = text(segment?.type).trim().toLowerCase();
    if (segType === "reply" || segType === "forward") {
      continue;
    }
    if (segType === "face") {
      flushTextBuffer();
      const previewUrl = text(segment?.preview_url || segment?.url).trim();
      if (!previewUrl) {
        continue;
      }
      const img = document.createElement("img");
      img.className = "qq-face-inline";
      img.loading = "lazy";
      img.alt = t("pages.dashboard.attachments.qq_face_alt", "[QQ face]");
      img.src = previewUrl;
      body.append(img);
      hasContent = true;
      continue;
    }
    if (segType === "at") {
      flushTextBuffer();
      const mention = document.createElement("span");
      mention.className = "bubble-at";
      mention.textContent = segmentTextParts(segment);
      body.append(mention);
      body.append(document.createTextNode("\u00A0"));
      hasContent = true;
      continue;
    }
    const value = segmentTextParts(segment);
    if (!value) {
      continue;
    }
    textBuffer += value;
  }
  flushTextBuffer();
  return hasContent ? body : null;
}

function buildForwardRecordPreview(item) {
  const senderName = text(item?.sender_name).trim();
  const body = clampText(item?.text, 48);
  if (senderName && body) {
    return `${senderName}: ${body}`;
  }
  return body || senderName || t("pages.dashboard.forward.record_fallback", "Forwarded message");
}

function getForwardDisplayText(forward) {
  if (!forward) {
    return "";
  }
  const preview = clampText(forward.preview, 140);
  if (preview) {
    return preview;
  }
  const body = clampText(forward.text, 140);
  return body || t("pages.dashboard.forward.modal_title", "Forwarded Messages");
}

function scrollToQuotedMessage(messageId) {
  const targetId = text(messageId).trim();
  if (!targetId) {
    return;
  }
  const target = els.messageListContent.querySelector(`[data-message-id="${targetId}"]`);
  if (!target) {
    setStatus(
      t(
        "pages.dashboard.status.quote_not_loaded",
        "Quoted message is not in the current loaded message window."
      )
    );
    return;
  }
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("message-item-highlight");
  window.setTimeout(() => {
    target.classList.remove("message-item-highlight");
  }, 1800);
}

function openQuoteModal(message) {
  const payload = message?.forward;
  if (!payload) {
    return;
  }
  const forwardItems = Array.isArray(payload.items) ? payload.items : [];
  els.quoteModal.classList.remove("is-hidden");
  els.quoteModal.setAttribute("aria-hidden", "false");
  els.quoteModalTitle.textContent = t(
    "pages.dashboard.forward.modal_title",
    "Forwarded Messages"
  );
  els.quoteModalMeta.textContent = t(
    "pages.dashboard.forward.modal_meta",
    "{count} messages"
  ).replace("{count}", String(forwardItems.length || Number(payload.item_count || 0) || 0));
  els.quoteModalBody.replaceChildren();

  for (const item of forwardItems) {
    const row = document.createElement("article");
    row.className = "message-item quote-modal-message";
    const avatar = document.createElement("div");
    avatar.className = "avatar quote-modal-avatar";
    setAvatar(
      avatar,
      avatarUrl(item.sender_id, "private"),
      text(item.sender_name || item.sender_id).slice(0, 1).toUpperCase()
    );

    const stack = document.createElement("div");
    stack.className = "message-stack";
    const meta = document.createElement("div");
    meta.className = "bubble-meta";
    const name = document.createElement("div");
    name.className = "bubble-name";
    name.textContent =
      text(item.sender_name).trim() ||
      text(item.sender_id).trim() ||
      t("pages.dashboard.messages.unknown_user", "Unknown User");
    meta.append(name);

    const bubble = document.createElement("div");
    bubble.className = "bubble quote-modal-bubble";
    const body = document.createElement("div");
    body.className = "bubble-text";
    body.textContent =
      text(item.text).trim() || t("pages.dashboard.messages.empty_message", "[Empty message]");
    bubble.append(body);
    stack.append(meta, bubble);
    row.append(avatar, stack);
    els.quoteModalBody.append(row);
  }
}

function buildQuoteInline(message) {
  const quote = message?.quote;
  if (!quote || (!quote.text && !quote.sender_name)) {
    return null;
  }
  const quoteInline = document.createElement("button");
  quoteInline.type = "button";
  quoteInline.className = "quote-inline";
  quoteInline.textContent = `${quote.sender_name || t("pages.dashboard.messages.reply", "Reply")}: ${quote.text || ""}`;
  quoteInline.addEventListener("click", () => {
    scrollToQuotedMessage(quote.message_id);
  });
  return quoteInline;
}

function buildForwardCard(message) {
  const payload = message?.forward;
  if (!payload) {
    return null;
  }
  const display = getForwardDisplayText(payload);
  if (!display) {
    return null;
  }
  const quoteCard = document.createElement("button");
  quoteCard.type = "button";
  quoteCard.className = "quote-card is-forward";
  quoteCard.addEventListener("click", () => {
    openQuoteModal(message);
  });

  const title = document.createElement("strong");
  title.className = "quote-card-title";
  title.textContent = t("pages.dashboard.forward.card_title", "Chat History");

  const content = document.createElement("div");
  content.className = "quote-card-content";

  if (Array.isArray(payload.items) && payload.items.length) {
    for (const item of payload.items.slice(0, 3)) {
      const line = document.createElement("span");
      line.className = "quote-card-line";
      line.textContent = buildForwardRecordPreview(item);
      content.append(line);
    }
  } else {
    const line = document.createElement("span");
    line.className = "quote-card-line";
    line.textContent = display;
    content.append(line);
  }

  const footer = document.createElement("div");
  footer.className = "quote-card-footer";
  footer.textContent = t("pages.dashboard.forward.card_footer", "Messages");
  quoteCard.append(title, content, footer);
  return quoteCard;
}

export function renderMessages(options = {}) {
  const { forceScrollToBottom = false } = options;
  const session = state.sessions.find((item) => item.session_id === state.activeSessionId);
  const sessionTitle = session?.title || state.activeSessionId;
  if (session?.chat_type === "group") {
    const memberCount =
      session.member_count != null ? Number(session.member_count) : state.members.length;
    els.chatTitle.textContent =
      memberCount > 0 ? `${sessionTitle}(${memberCount})` : sessionTitle;
  } else {
    els.chatTitle.textContent = sessionTitle;
  }
  const items = state.messagesBySession.get(state.activeSessionId) || [];
  const previousScrollTop = els.messageList.scrollTop;
  const previousScrollHeight = els.messageList.scrollHeight;
  const previousClientHeight = els.messageList.clientHeight;
  const shouldStickToBottom =
    forceScrollToBottom ||
    previousScrollHeight - (previousScrollTop + previousClientHeight) <= 24;
  if (!state.activeSessionId) {
    els.messageListContent.className = "message-list-content empty-state";
    els.messageListContent.textContent = t(
      "pages.dashboard.messages.select_session",
      "Select a conversation from the left side."
    );
    return;
  }
  if (!items.length) {
    els.messageListContent.className = "message-list-content empty-state";
    els.messageListContent.textContent = t(
      "pages.dashboard.messages.empty_session",
      "No cached messages for this session yet."
    );
    return;
  }
  els.messageListContent.className = "message-list-content";
  els.messageListContent.replaceChildren();
  for (const item of items) {
    const row = document.createElement("article");
    row.className = `message-item${item.is_self ? " self" : ""}`;
    row.dataset.messageId = text(item.message_id).trim();
    const isGroup = item.chat_type === "group";
    const member = isGroup ? findMemberProfile(item.sender_id) : null;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    setAvatar(
      avatar,
      avatarUrl(item.sender_id, "private"),
      text(item.sender_name || item.sender_id).slice(0, 1).toUpperCase()
    );

    const hasSegmentBody = hasRenderableSegmentBody(item);
    const inlineFaceImageKeys = new Set(
      (Array.isArray(item.segments) ? item.segments : [])
        .filter((segment) => text(segment?.type).trim().toLowerCase() === "face")
        .map((segment) => text(segment?.media_key).trim())
        .filter(Boolean)
    );
    const images =
      item.attachments?.filter(
        (attachment) =>
          isImageAttachment(attachment) &&
          !inlineFaceImageKeys.has(text(attachment?.media_key).trim())
      ) || [];
    const videos = item.attachments?.filter((attachment) => isVideoAttachment(attachment)) || [];
    const audios = item.attachments?.filter((attachment) => isAudioAttachment(attachment)) || [];
    const files =
      item.attachments?.filter(
        (attachment) =>
          !isImageAttachment(attachment) &&
          !isVideoAttachment(attachment) &&
          !isAudioAttachment(attachment)
      ) || [];
    const plainText = text(item.plain_text).trim();
    const forwardPreviewText = text(item.forward?.preview).trim();
    const isAttachmentPlaceholder =
      /^\[(image|video|audio|file|表情)\]$/i.test(plainText) &&
      (images.length || videos.length || audios.length || files.length);
    const shouldHideForwardFallbackText =
      Boolean(item.forward) && forwardPreviewText && plainText === forwardPreviewText;
    const displayText =
      hasSegmentBody || isAttachmentPlaceholder || shouldHideForwardFallbackText
        ? ""
        : plainText;
    const hasText = Boolean(displayText);
    const attachmentCount = images.length + videos.length + audios.length + files.length;
    const forwardPreviewOnly =
      Boolean(item.forward) && !hasText && !attachmentCount && !item.quote;
    const singleMediaOnly =
      attachmentCount === 1 &&
      !hasText &&
      !item.quote?.text &&
      !item.quote?.sender_name &&
      !item.forward?.preview;

    const bubble = document.createElement("div");
    bubble.className = forwardPreviewOnly
      ? "bubble bubble-forward-only"
      : singleMediaOnly
        ? "bubble bubble-media-only"
        : "bubble";
    const stack = document.createElement("div");
    stack.className = `message-stack${item.is_self ? " self" : ""}`;

    if (isGroup) {
      const badgeMeta = buildGroupBadge(member);
      const meta = document.createElement("div");
      meta.className = `bubble-meta${item.is_self ? " self" : ""}`;

      const badge = document.createElement("div");
      badge.className = `bubble-corner-badge role-${badgeMeta.role}${item.is_self ? " self" : ""}`;
      badge.textContent = badgeMeta.text;

      const name = document.createElement("div");
      name.className = `bubble-name${item.is_self ? " self" : ""}`;
      name.textContent = badgeMeta.name || item.sender_name || item.sender_id;
      meta.append(badge, name);
      stack.append(meta);
    }
    stack.append(bubble);
    row.append(avatar, stack);

    const quoteInline = buildQuoteInline(item);
    if (quoteInline) {
      bubble.append(quoteInline);
    }

    const forwardCard = buildForwardCard(item);
    if (forwardCard) {
      bubble.append(forwardCard);
    }

    const segmentBody = buildMessageBodyFromSegments(item);
    if (segmentBody) {
      bubble.append(segmentBody);
    } else if (displayText) {
      const body = document.createElement("div");
      body.className = "bubble-text markdown-content";
      body.append(renderMarkdownFragment(displayText));
      bubble.append(body);
    }

    if (item.attachments?.length) {
      const wrap = document.createElement("div");
      wrap.className =
        videos.length || audios.length || files.length
          ? "attachment-row"
          : "attachment-row images-only";

      for (const attachment of images) {
        const previewUrl = text(attachment.preview_url).trim();
        const link = document.createElement("a");
        link.className = `message-image-link${singleMediaOnly ? " is-standalone" : ""}`;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.href = previewUrl || "javascript:void(0)";
        const img = document.createElement("img");
        img.className = "message-image";
        img.loading = "lazy";
        img.alt = attachment.name || t("pages.dashboard.attachments.image_alt", "image");
        img.src = previewUrl;
        link.append(img);
        wrap.append(link);
      }

      for (const attachment of videos) {
        const previewUrl = text(attachment.preview_url).trim();
        const video = document.createElement("video");
        video.className = `message-video${singleMediaOnly ? " is-standalone" : ""}`;
        video.controls = true;
        video.preload = "metadata";
        video.src = previewUrl;
        wrap.append(video);
      }

      for (const attachment of audios) {
        const previewUrl = text(attachment.preview_url).trim();
        const audio = document.createElement("audio");
        audio.className = `message-audio${singleMediaOnly ? " is-standalone" : ""}`;
        audio.controls = true;
        audio.preload = "metadata";
        audio.src = previewUrl;
        wrap.append(audio);
      }

      for (const attachment of [...files]) {
        const link = document.createElement("a");
        link.className = `attachment-chip${singleMediaOnly ? " is-standalone" : ""}`;
        link.target = "_blank";
        link.rel = "noreferrer";
        const attachmentUrl =
          text(attachment.preview_url).trim() ||
          text(attachment.url).trim() ||
          "javascript:void(0)";
        const sizeText = formatFileSize(attachment.size);
        link.textContent = `${attachmentKindLabel(attachment)}: ${attachment.name || attachment.kind}${sizeText ? ` (${sizeText})` : ""}`;
        link.href = attachmentUrl;
        if (attachmentUrl === "javascript:void(0)") {
          link.style.pointerEvents = "none";
        }
        wrap.append(link);
      }

      bubble.append(wrap);
    }
    els.messageListContent.append(row);
  }
  if (shouldStickToBottom) {
    els.messageList.scrollTop = els.messageList.scrollHeight;
    return;
  }
  els.messageList.scrollTop = previousScrollTop;
}
