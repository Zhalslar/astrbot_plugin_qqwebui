import { apiSendFace } from "../api.js";
import { els } from "../dom.js";
import { t } from "../i18n.js";
import {
  attachmentKindLabel,
  ensureMediaObjectUrl,
  hydrateMessageAttachments,
  hydrateMessageSegments,
} from "../media.js";
import { setStatus } from "../status.js";
import { state } from "../store.js";
import { text } from "../utils.js";

export function updateSendAvailability() {
  const enabled = Boolean(state.activeSessionId);
  els.composerInput.disabled = !enabled;
  els.facePickerBtn.disabled = !enabled;
  els.attachmentInput.disabled = !enabled;
  els.sendBtn.disabled = !enabled;
}

export async function renderComposerPreview() {
  if (!state.pendingAttachments.length) {
    els.composerPreview.classList.add("is-hidden");
    els.composerPreview.replaceChildren();
    return;
  }
  els.composerPreview.classList.remove("is-hidden");
  els.composerPreview.replaceChildren();
  for (const item of state.pendingAttachments) {
    const chip = document.createElement("div");
    chip.className = "preview-chip";
    const kind = text(item.kind).trim().toLowerCase();
    if (kind === "image") {
      const previewUrl =
        text(item.preview_url).trim() ||
        (await ensureMediaObjectUrl({ media_key: item.key }));
      const img = document.createElement("img");
      img.alt = item.name || t("pages.dashboard.attachments.image_alt", "image");
      img.src = previewUrl;
      chip.append(img);
    } else {
      const label = document.createElement("div");
      label.className = "preview-chip-label";
      label.textContent = attachmentKindLabel(item);
      chip.append(label);
    }
    const name = document.createElement("span");
    name.className = "preview-chip-name";
    name.textContent = item.name || attachmentKindLabel(item);
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "preview-remove";
    removeBtn.textContent = "x";
    removeBtn.addEventListener("click", () => {
      state.pendingAttachments = state.pendingAttachments.filter((entry) => entry.key !== item.key);
      void renderComposerPreview();
    });
    chip.append(name, removeBtn);
    els.composerPreview.append(chip);
  }
}

export async function renderFacePicker(loadSessions, renderMessages) {
  els.facePickerList.replaceChildren();
  if (!state.faces.length) {
    const empty = document.createElement("div");
    empty.className = "face-picker-empty";
    empty.textContent = t("pages.dashboard.face_picker.empty", "No QQ faces available.");
    els.facePickerList.append(empty);
    return;
  }
  for (const item of state.faces) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "face-picker-item";
    button.title = `QQ Face ${item.id}`;

    const img = document.createElement("img");
    img.alt = `QQ Face ${item.id}`;
    img.loading = "lazy";
    const previewUrl = text(item.preview_url).trim();
    if (previewUrl) {
      img.src = previewUrl;
    } else {
      img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
      const mediaKey = text(item.media_key).trim();
      if (mediaKey) {
        void ensureMediaObjectUrl({ media_key: mediaKey })
          .then((url) => {
            item.preview_url = url;
            img.src = url;
          })
          .catch(() => {});
      }
    }

    button.append(img);
    button.addEventListener("click", async () => {
      if (!state.activeSessionId) {
        return;
      }
      els.facePickerBtn.disabled = true;
      try {
        const data = await apiSendFace("page/send-face", {
          session_id: state.activeSessionId,
          face_id: item.id,
        });
        const hydrated = await hydrateMessageSegments(
          await hydrateMessageAttachments([data.message])
        );
        const existing = state.messagesBySession.get(state.activeSessionId) || [];
        state.messagesBySession.set(state.activeSessionId, [...existing, ...hydrated]);
        state.facePickerPinned = false;
        els.facePickerWrap.classList.remove("is-open", "is-pinned");
        els.facePickerPanel.classList.add("is-hidden");
        els.facePickerPanel.setAttribute("aria-hidden", "true");
        renderMessages({ forceScrollToBottom: true });
        await loadSessions();
        setStatus(
          state.status?.login?.user_id
            ? `QQ ${state.status.login.user_id}`
            : t("pages.dashboard.status.message_sent", "Message sent")
        );
      } catch (error) {
        setStatus(error.message || t("pages.dashboard.status.send_failed", "Send failed."));
      } finally {
        updateSendAvailability();
      }
    });
    els.facePickerList.append(button);
  }
}
