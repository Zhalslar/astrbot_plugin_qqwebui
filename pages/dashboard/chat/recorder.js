import { uploadSelectedMedia, updateSendAvailability } from "./composer.js";
import { els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { setStatus } from "../core/status.js";
import { state } from "../core/state.js";

const RECORDER_PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
];

let activeRecorder = null;
let activeStream = null;
let activeChunks = [];

function supportsRecording() {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined"
  );
}

function preferredMimeType() {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }
  if (typeof MediaRecorder.isTypeSupported !== "function") {
    return RECORDER_PREFERRED_MIME_TYPES[0];
  }
  return (
    RECORDER_PREFERRED_MIME_TYPES.find((item) => MediaRecorder.isTypeSupported(item)) ||
    ""
  );
}

function extensionForMimeType(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("ogg")) {
    return "ogg";
  }
  if (normalized.includes("mp4") || normalized.includes("m4a")) {
    return "m4a";
  }
  if (normalized.includes("wav")) {
    return "wav";
  }
  return "webm";
}

function stopActiveStreamTracks() {
  if (!activeStream) {
    return;
  }
  for (const track of activeStream.getTracks()) {
    track.stop();
  }
  activeStream = null;
}

function micIconMarkup() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 15a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      ></path>
      <path
        d="M19 11a7 7 0 0 1-14 0"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      ></path>
      <line
        x1="12"
        y1="18"
        x2="12"
        y2="21"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      ></line>
      <line
        x1="8"
        y1="21"
        x2="16"
        y2="21"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      ></line>
    </svg>
  `;
}

function stopIconMarkup() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"></rect>
    </svg>
  `;
}

export function renderRecorderButton() {
  if (!els.recordButton) {
    return;
  }
  const supported = supportsRecording();
  const isRecording = state.isRecording;
  const isBusy = state.recordingBusy;
  const label = !supported
    ? t("pages.dashboard.status.recording_unsupported", "Recording is not supported")
    : isRecording
      ? t("pages.dashboard.status.recording_stop", "Stop recording")
      : isBusy
        ? t("pages.dashboard.status.recording_processing", "Processing recording...")
        : t("pages.dashboard.status.recording_start", "Record voice");
  els.recordButton.title = label;
  els.recordButton.setAttribute("aria-label", label);
  els.recordButton.classList.toggle("is-recording", isRecording);
  els.recordButton.innerHTML = isRecording ? stopIconMarkup() : micIconMarkup();
  if (!supported) {
    els.recordButton.disabled = true;
  }
}

async function finalizeRecording() {
  const chunks = activeChunks;
  const mimeType = activeRecorder?.mimeType || preferredMimeType() || "audio/webm";
  activeChunks = [];
  activeRecorder = null;
  stopActiveStreamTracks();
  state.isRecording = false;
  if (!chunks.length) {
    state.recordingBusy = false;
    updateSendAvailability();
    renderRecorderButton();
    setStatus(t("pages.dashboard.status.recording_empty", "No audio captured."));
    return;
  }
  const fileExtension = extensionForMimeType(mimeType);
  const blob = new Blob(chunks, { type: mimeType });
  const file = new File([blob], `recording-${Date.now()}.${fileExtension}`, {
    type: mimeType,
  });
  try {
    await uploadSelectedMedia([file], () =>
      t("pages.dashboard.status.recording_ready", "Recorded voice message is ready to send.")
    );
  } catch (error) {
    setStatus(
      error?.message || t("pages.dashboard.status.recording_upload_failed", "Recording upload failed.")
    );
  } finally {
    state.recordingBusy = false;
    updateSendAvailability();
    renderRecorderButton();
  }
}

async function startRecording() {
  if (!supportsRecording()) {
    setStatus(t("pages.dashboard.status.recording_unsupported", "Recording is not supported."));
    return;
  }
  if (!state.activeSessionId) {
    setStatus(
      t("pages.dashboard.status.recording_select_session", "Open a chat session before recording.")
    );
    return;
  }
  if (state.recordingBusy || state.isRecording) {
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = preferredMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    activeChunks = [];
    activeRecorder = recorder;
    activeStream = stream;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        activeChunks.push(event.data);
      }
    });
    recorder.addEventListener("stop", () => {
      void finalizeRecording();
    });
    recorder.start();
    state.isRecording = true;
    state.recordingBusy = false;
    updateSendAvailability();
    renderRecorderButton();
    setStatus(t("pages.dashboard.status.recording_started", "Recording... click again to stop."));
  } catch (error) {
    stopActiveStreamTracks();
    activeChunks = [];
    activeRecorder = null;
    state.isRecording = false;
    state.recordingBusy = false;
    updateSendAvailability();
    renderRecorderButton();
    setStatus(
      error?.message ||
        t("pages.dashboard.status.recording_permission_denied", "Microphone access was denied.")
    );
  }
}

function stopRecording() {
  if (!activeRecorder || activeRecorder.state === "inactive" || state.recordingBusy) {
    return;
  }
  state.recordingBusy = true;
  updateSendAvailability();
  renderRecorderButton();
  activeRecorder.stop();
}

export function bindRecorderEvents() {
  if (!els.recordButton) {
    return;
  }
  els.recordButton.addEventListener("click", async () => {
    if (state.isRecording) {
      stopRecording();
      return;
    }
    await startRecording();
  });
}

export function cleanupRecorder() {
  activeChunks = [];
  activeRecorder = null;
  stopActiveStreamTracks();
  state.isRecording = false;
  state.recordingBusy = false;
}
