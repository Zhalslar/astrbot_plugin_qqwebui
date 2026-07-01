import { apiGet } from "../core/api.js";
import { renderStatus } from "../core/status.js";
import { state } from "../core/state.js";

export async function loadStatus() {
  state.status = await apiGet("page/status");
  renderStatus();
}
