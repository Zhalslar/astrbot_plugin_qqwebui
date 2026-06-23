const bridge = window.AstrBotPluginPage;
const REQUEST_TIMEOUT_MS = 15000;

function withTimeout(promise, message) {
  let timerId = 0;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = window.setTimeout(() => reject(new Error(message)), REQUEST_TIMEOUT_MS);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    window.clearTimeout(timerId);
  });
}

function normalize(result, fallbackMessage) {
  if (result && typeof result === "object") {
    if (Object.prototype.hasOwnProperty.call(result, "ok")) {
      if (!result.ok) {
        throw new Error(result.error?.message || result.message || fallbackMessage);
      }
      return result.data || {};
    }
    if (result.status === "error") {
      throw new Error(result.message || fallbackMessage);
    }
  }
  return result || {};
}

async function apiGet(endpoint, params = {}) {
  const result = await withTimeout(
    bridge.apiGet(endpoint, params),
    bridge?.t?.("pages.dashboard.errors.timeout", "AstrBot WebUI request timed out.") ||
      "AstrBot WebUI request timed out."
  );
  return normalize(
    result,
    bridge?.t?.("pages.dashboard.errors.request_failed", "Request failed.") ||
      "Request failed."
  );
}

async function apiPost(endpoint, body = {}) {
  const result = await withTimeout(
    bridge.apiPost(endpoint, body),
    bridge?.t?.("pages.dashboard.errors.timeout", "AstrBot WebUI request timed out.") ||
      "AstrBot WebUI request timed out."
  );
  return normalize(
    result,
    bridge?.t?.("pages.dashboard.errors.request_failed", "Request failed.") ||
      "Request failed."
  );
}

async function apiSendFace(endpoint, body = {}) {
  return apiPost(endpoint, body);
}

async function apiUpload(endpoint, file) {
  const result = await withTimeout(
    bridge.upload(endpoint, file),
    bridge?.t?.("pages.dashboard.errors.timeout", "AstrBot WebUI request timed out.") ||
      "AstrBot WebUI request timed out."
  );
  return normalize(
    result,
    bridge?.t?.("pages.dashboard.errors.upload_failed", "Upload failed.") ||
      "Upload failed."
  );
}

export {
  apiGet,
  apiPost,
  apiSendFace,
  apiUpload,
};
