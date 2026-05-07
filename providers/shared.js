// Utilities shared by every provider script. Injected first by the SW so
// each provider can pull helpers off globalThis.__aiExport.
//
// Always reassigns on (re)injection so reloading the extension picks up
// edits without forcing a chat-page reload too.

globalThis.__aiExport = (() => {
  const MIME_TO_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/avif": "avif",
    "image/heic": "heic",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "text/csv": "csv",
    "text/markdown": "md",
    "application/json": "json",
    "application/zip": "zip",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  };

  // Resolve a usable URL from an <img>. Falls back through lazy-loading
  // attributes when src is empty or a placeholder. Keeps blob: URLs (Gemini's
  // generated images live there) — those are handled specially by downloadAsset.
  const resolveImgSrc = (img) => {
    if (!img || img.tagName?.toUpperCase?.() !== "IMG") return null;
    const src = img.src;
    if (src && !src.startsWith("data:")) return src;
    const dataSrc = img.getAttribute?.("data-src") || img.getAttribute?.("data-original-src");
    if (dataSrc && !dataSrc.startsWith("data:")) return dataSrc;
    const srcset = img.getAttribute?.("srcset") || "";
    if (srcset) {
      const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
      if (first && !first.startsWith("data:")) return first;
    }
    return null;
  };

  const htmlToMd = (node, opts = {}) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toLowerCase();
    const kids = () => Array.from(node.childNodes).map((n) => htmlToMd(n, opts)).join("");

    switch (tag) {
      case "br": return "\n";
      case "hr": return "\n---\n";
      case "strong": case "b": return `**${kids()}**`;
      case "em": case "i": return `_${kids()}_`;
      case "code":
        if (node.parentElement?.tagName.toLowerCase() === "pre") return kids();
        return `\`${node.textContent}\``;
      case "pre": {
        const codeEl = node.querySelector("code");
        const lang = codeEl?.className?.match(/language-(\S+)/)?.[1] ?? "";
        const txt = codeEl ? codeEl.textContent : node.textContent;
        return `\n\`\`\`${lang}\n${txt.replace(/\n$/, "")}\n\`\`\`\n`;
      }
      case "a": {
        const href = node.getAttribute("href") ?? "";
        return `[${kids()}](${href})`;
      }
      case "img": {
        // Use the same resolver providers used for collection so the lookup
        // key matches (e.g. when src is empty and the URL lives in data-src).
        const src = resolveImgSrc(node) || "";
        const alt = node.getAttribute("alt") || "image";
        const local = opts.urlToLocal?.get(src);
        if (local) {
          opts.consumed?.add(src);
          return `![[${local}]]`;
        }
        if (!src || src.startsWith("data:") || src.startsWith("blob:")) return "";
        return `![${alt}](${src})`;
      }
      case "h1": return `\n# ${kids()}\n`;
      case "h2": return `\n## ${kids()}\n`;
      case "h3": return `\n### ${kids()}\n`;
      case "h4": return `\n#### ${kids()}\n`;
      case "h5": return `\n##### ${kids()}\n`;
      case "h6": return `\n###### ${kids()}\n`;
      case "p": return `\n${kids()}\n`;
      case "ul": case "ol": {
        const ordered = tag === "ol";
        return "\n" + Array.from(node.children)
          .filter((c) => c.tagName.toLowerCase() === "li")
          .map((li, i) => `${ordered ? `${i + 1}.` : "-"} ${htmlToMd(li, opts).trim()}`)
          .join("\n") + "\n";
      }
      case "li": return kids();
      case "blockquote":
        return "\n" + kids().split("\n").map((l) => `> ${l}`).join("\n") + "\n";
      case "table": {
        const rows = Array.from(node.querySelectorAll("tr"));
        if (!rows.length) return kids();
        const cells = (r) => Array.from(r.children).map((c) => htmlToMd(c, opts).trim().replace(/\n/g, " "));
        const head = cells(rows[0]);
        const sep = head.map(() => "---");
        const body = rows.slice(1).map(cells);
        return "\n" + [head, sep, ...body].map((r) => `| ${r.join(" | ")} |`).join("\n") + "\n";
      }
      case "script": case "style": case "noscript": return "";
      default: return kids();
    }
  };

  const sanitize = (s) =>
    s.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").slice(0, 120).trim();

  const buildDocument = ({ source, title, parts, messageCount }) => {
    const frontmatter = [
      "---",
      `source: ${source}`,
      `title: ${JSON.stringify(title)}`,
      `url: ${location.href}`,
      `exported: ${new Date().toISOString()}`,
      `messages: ${messageCount}`,
      "---",
      "",
    ].join("\n");
    return frontmatter + `# ${title}\n\n${parts.join("\n\n")}\n`;
  };

  // The .md is created in-page and downloaded via anchor click — works for
  // a single text file without tripping Chrome's multi-download prompt.
  const download = (filename, content) => {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const extFromUrl = (url) =>
    (url.match(/\.(\w{1,5})(?:[?#]|$)/)?.[1] || "").toLowerCase();
  const extFromName = (name) =>
    (name?.match(/\.(\w{1,5})$/)?.[1] || "").toLowerCase();
  const defaultExt = (kind) =>
    kind === "image" ? "png" : kind === "document" ? "pdf" : "bin";

  const blobToDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error("FileReader failed"));
      fr.readAsDataURL(blob);
    });

  // Fetches every asset (blob: or http(s)) here in the page context, reads
  // the real MIME via blob.type, picks the right extension, then hands a data
  // URL to the SW for chrome.downloads. This keeps Chrome from rewriting our
  // requested extension based on its own content-type sniffing — the data URL
  // has no inherent type, so chrome.downloads honours our filename verbatim.
  const downloadAsset = async (url, suggestedName, fallbackBase, kind = "any") => {
    if (!url || url.startsWith("data:")) return null;

    let urlForDownload = url;
    let blobMime = null;

    if (url.startsWith("blob:")) {
      // blob: only resolves in page context — no fallback path possible.
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        blobMime = blob.type;
        urlForDownload = await blobToDataUrl(blob);
      } catch (e) {
        console.warn(`[ai-export] failed to read blob ${url}: ${e.message}`);
        return null;
      }
    } else if (url.startsWith("http")) {
      // Try page-context fetch first (gives us the real MIME type so we can
      // set the right extension upfront). If CORS or auth blocks us — common
      // for cross-site CDN assets that need cross-site cookies — fall back to
      // direct chrome.downloads, which uses Chrome's network stack and the
      // browser's cookie jar.
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        blobMime = blob.type;
        urlForDownload = await blobToDataUrl(blob);
      } catch (e) {
        console.warn(`[ai-export] page-fetch failed for ${url} (${e.message}); falling back to direct download`);
        // Keep urlForDownload = url (original); blobMime stays null and we
        // rely on the SW to report Chrome's chosen filename after completion.
      }
    }

    let ext = extFromName(suggestedName) || extFromUrl(url);
    if (!ext && blobMime) ext = MIME_TO_EXT[blobMime] || "";
    if (!ext) ext = defaultExt(kind);

    const baseFromName = suggestedName
      ? sanitize(suggestedName.replace(/\.[^.]+$/, ""))
      : "";
    const cleanFallback = (fallbackBase || "attachment")
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
    const base = baseFromName || cleanFallback;
    const requestedFilename = `${base}.${ext}`;

    try {
      const result = await chrome.runtime.sendMessage({
        type: "download-asset",
        url: urlForDownload,
        filename: requestedFilename,
      });
      if (!result?.ok) {
        console.warn(`[ai-export] download failed for ${url}: ${result?.error || "unknown"}`);
        return null;
      }
      return result.filename || requestedFilename;
    } catch (e) {
      console.warn(`[ai-export] download relay error for ${url}:`, e.message);
      return null;
    }
  };

  const report = (ok, info = {}) => {
    try {
      chrome.runtime.sendMessage({ type: "ai-export-status", ok, ...info });
    } catch (e) {
      console.warn("[ai-export] report failed", e);
    }
  };

  return { htmlToMd, sanitize, buildDocument, download, downloadAsset, report, resolveImgSrc };
})();
