import { text } from "./utils.js";

export function areMessageListsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];
    if (
      leftItem.message_id !== rightItem.message_id ||
      leftItem.plain_text !== rightItem.plain_text ||
      JSON.stringify(leftItem.quote || null) !== JSON.stringify(rightItem.quote || null) ||
      (leftItem.attachments?.length || 0) !== (rightItem.attachments?.length || 0)
    ) {
      return false;
    }
  }
  return true;
}

export function areSessionListsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];
    if (
      leftItem.session_id !== rightItem.session_id ||
      leftItem.title !== rightItem.title ||
      leftItem.avatar !== rightItem.avatar ||
      leftItem.target_id !== rightItem.target_id ||
      leftItem.chat_type !== rightItem.chat_type ||
      leftItem.last_message_id !== rightItem.last_message_id ||
      leftItem.last_message_preview !== rightItem.last_message_preview ||
      leftItem.last_timestamp !== rightItem.last_timestamp ||
      Number(leftItem.unread_count || 0) !== Number(rightItem.unread_count || 0)
    ) {
      return false;
    }
  }
  return true;
}

export function areMemberListsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];
    if (
      leftItem.id !== rightItem.id ||
      leftItem.title !== rightItem.title ||
      leftItem.subtitle !== rightItem.subtitle ||
      text(leftItem.extra?.role) !== text(rightItem.extra?.role) ||
      text(leftItem.extra?.level) !== text(rightItem.extra?.level) ||
      text(leftItem.extra?.card) !== text(rightItem.extra?.card) ||
      text(leftItem.extra?.nickname) !== text(rightItem.extra?.nickname)
    ) {
      return false;
    }
  }
  return true;
}
