function toText(value) {
  return String(value ?? "");
}

function escapeHtml(value) {
  return toText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeUrl(value) {
  const raw = toText(value).trim();
  if (!raw) {
    return "";
  }
  try {
    const url = new URL(raw, window.location.href);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
      return url.href;
    }
  } catch {}
  return "";
}

function renderInlineMarkdown(value) {
  const tokens = [];
  let html = toText(value).replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `%%MDCODE${tokens.length}%%`;
    tokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  html = escapeHtml(html);
  html = html.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_, label, url) => {
    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) {
      return escapeHtml(label);
    }
    return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
  });
  html = html
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/_([^_\n]+)_/g, "<em>$1</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

  for (let index = 0; index < tokens.length; index += 1) {
    html = html.replace(`%%MDCODE${index}%%`, tokens[index]);
  }
  return html;
}

function isMarkdownBlockStart(line) {
  return /^(#{1,6})\s+/.test(line) || /^>\s?/.test(line) || /^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line);
}

function renderMarkdownBlocks(source) {
  const lines = source.split("\n");
  const parts = [];

  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      parts.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      parts.push(`<blockquote>${renderMarkdownBlocks(quoteLines.join("\n"))}</blockquote>`);
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index])) {
        items.push(`<li>${renderInlineMarkdown(lines[index].replace(/^[-*+]\s+/, ""))}</li>`);
        index += 1;
      }
      parts.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) {
        items.push(`<li>${renderInlineMarkdown(lines[index].replace(/^\d+\.\s+/, ""))}</li>`);
        index += 1;
      }
      parts.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    parts.push(`<p>${renderInlineMarkdown(paragraphLines.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }

  return parts.join("");
}

export function renderMarkdownFragment(value, inline = false) {
  const source = toText(value).replace(/\r\n?/g, "\n");
  const fragment = document.createDocumentFragment();
  if (!source.trim()) {
    return fragment;
  }

  const template = document.createElement("template");
  if (inline) {
    template.innerHTML = renderInlineMarkdown(source).replace(/\n/g, "<br>");
    fragment.append(template.content.cloneNode(true));
    return fragment;
  }

  const sections = [];
  const codeFencePattern = /```([\w-]+)?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match = codeFencePattern.exec(source);
  while (match) {
    const leading = source.slice(lastIndex, match.index);
    if (leading.trim()) {
      sections.push(renderMarkdownBlocks(leading));
    }
    const language = toText(match[1]).trim();
    const code = match[2].replace(/\n$/, "");
    sections.push(
      `<pre><code${language ? ` data-lang="${escapeHtml(language)}"` : ""}>${escapeHtml(code)}</code></pre>`
    );
    lastIndex = match.index + match[0].length;
    match = codeFencePattern.exec(source);
  }

  const trailing = source.slice(lastIndex);
  if (trailing.trim()) {
    sections.push(renderMarkdownBlocks(trailing));
  }

  template.innerHTML = sections.join("");
  fragment.append(template.content.cloneNode(true));
  return fragment;
}
