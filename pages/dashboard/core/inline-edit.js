import { text } from "./utils.js";

export function startInlineTextEdit(target, options = {}) {
  const value = text(options.value).trim();
  const allowEmpty = Boolean(options.allowEmpty);
  const onSave = typeof options.onSave === "function" ? options.onSave : null;
  const onError = typeof options.onError === "function" ? options.onError : null;
  if (!target || target.dataset.inlineEditing === "true" || !onSave) {
    return;
  }

  target.dataset.inlineEditing = "true";
  target.classList.add("is-inline-editing");
  const previousText = target.textContent;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-edit-input";
  input.value = value;
  input.placeholder = text(options.placeholder).trim();
  target.replaceChildren(input);
  input.focus();
  input.select();

  let finished = false;
  let canceling = false;
  const restore = (displayText) => {
    target.textContent = displayText;
    target.classList.remove("is-inline-editing", "is-inline-saving");
    delete target.dataset.inlineEditing;
  };
  const commit = async () => {
    if (finished) {
      return;
    }
    const nextValue = text(input.value).trim();
    if (!allowEmpty && !nextValue) {
      finished = true;
      restore(previousText);
      return;
    }
    if (nextValue === value) {
      finished = true;
      restore(previousText);
      return;
    }

    finished = true;
    input.disabled = true;
    target.classList.add("is-inline-saving");
    try {
      const savedValue = await onSave(nextValue);
      restore(text(savedValue ?? nextValue).trim() || previousText);
    } catch (error) {
      restore(previousText);
      if (onError) {
        onError(error);
      }
    }
  };
  const cancel = () => {
    if (finished) {
      return;
    }
    finished = true;
    canceling = true;
    restore(previousText);
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });
  input.addEventListener("blur", () => {
    if (canceling) {
      return;
    }
    void commit();
  });
}
