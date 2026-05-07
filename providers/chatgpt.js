// ChatGPT extractor. Runs in the page's content-script world after shared.js.

(async () => {
  const { htmlToMd, sanitize, buildDocument, download, downloadAsset, report, resolveImgSrc } = globalThis.__aiExport;

  const messages = Array.from(document.querySelectorAll("[data-message-author-role]"));
  if (!messages.length) {
    console.error("[ai-export] No messages found. ChatGPT may have changed the DOM. Selector: [data-message-author-role]");
    report(false, { reason: "no-messages" });
    return;
  }

  const title =
    document.title.replace(/\s*[-–—]\s*ChatGPT\s*$/, "").trim() ||
    "ChatGPT conversation";
  const baseName = sanitize(title);
  // Keep a shorter prefix for attachment filenames so the per-attachment
  // suffix (- image-1, etc.) survives any later size capping.
  const attachmentBase = baseName.slice(0, 50).trim();

  // Pass 1a: collect inline image URLs per message (so we can append
  // any that aren't rendered inline at the end of that message).
  const imgsByMsg = messages.map((m) => {
    const set = new Set();
    for (const img of m.querySelectorAll("img")) {
      const src = resolveImgSrc(img);
      if (src) set.add(src);
    }
    return set;
  });
  const imgUrls = new Set();
  for (const s of imgsByMsg) for (const u of s) imgUrls.add(u);

  // Pass 1b: file cards. ChatGPT renders user uploads as elements with the
  // canonical filename in `aria-label` (the file tile is `[role="group"]`
  // with the same aria-label on its inner <button>). The actual file URL
  // is fetched on demand via an authenticated API and isn't in the DOM, so
  // we record the filename and reference it as a wikilink in the markdown
  // — the user saves the file manually from ChatGPT and drops it in the
  // vault to make the wikilink resolve.
  const FILE_RE = /^[\w\-.() ]+\.(pdf|docx?|xlsx?|csv|txt|md|json|zip|html?|png|jpe?g|gif|webp|svg)$/i;
  const fileCards = []; // { msgIdx, url, name }
  const orphanFiles = []; // { msgIdx, name, source }
  const orphansByMsg = new Map();
  const fileCardsByMsg = new Map(); // tracks every attempted card so we can flag failed downloads

  const recordOrphan = (msgIdx, name, source) => {
    const already =
      fileCards.some((f) => f.msgIdx === msgIdx && f.name?.toLowerCase() === name.toLowerCase()) ||
      orphanFiles.some((o) => o.msgIdx === msgIdx && o.name?.toLowerCase() === name.toLowerCase());
    if (already) return;
    orphanFiles.push({ msgIdx, name, source });
    if (!orphansByMsg.has(msgIdx)) orphansByMsg.set(msgIdx, []);
    orphansByMsg.get(msgIdx).push(name);
  };

  for (let idx = 0; idx < messages.length; idx++) {
    const seen = new Set();
    for (const el of messages[idx].querySelectorAll("[aria-label]")) {
      const aria = (el.getAttribute("aria-label") || "").trim();
      if (!FILE_RE.test(aria)) continue;
      const key = aria.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      // Look for a downloadable URL in or around the card. ChatGPT typically
      // doesn't expose one, but other providers using the same script might.
      const card = el.closest("[role='group']") || el;
      const link = card.querySelector("a[href]");
      const url = link?.href;
      if (url && !imgUrls.has(url)) {
        fileCards.push({ msgIdx: idx, url, name: aria });
        if (!fileCardsByMsg.has(idx)) fileCardsByMsg.set(idx, []);
        fileCardsByMsg.get(idx).push({ url, name: aria });
      } else {
        recordOrphan(idx, aria, "aria-label");
      }
    }
  }

  // Pass 1c: text-content fallback. Catches filenames that show up as
  // visible text in user messages but didn't have an aria-label. The
  // negative lookahead replaces `\b`, which fails when ChatGPT runs the
  // filename and the format label together (e.g. "Report.pdfPDF12 KB").
  const TEXT_FILE_RE = /[\w\-.()][\w\-.()\s]{0,80}\.(pdf|docx?|xlsx?|csv|txt|md|zip|json)(?![a-zA-Z0-9])/gi;
  for (let idx = 0; idx < messages.length; idx++) {
    const m = messages[idx];
    if (m.getAttribute("data-message-author-role") !== "user") continue;
    const text = m.textContent || "";
    for (const match of text.matchAll(TEXT_FILE_RE)) {
      const name = match[0].trim();
      recordOrphan(idx, name, "text-scan");
    }
  }

  // Pass 2: download attachments via the SW (chrome.downloads).
  const urlToLocal = new Map();
  let imgIdx = 0;
  for (const url of imgUrls) {
    imgIdx++;
    const filename = await downloadAsset(url, null, `${attachmentBase} - image-${imgIdx}`, "image");
    if (filename) urlToLocal.set(url, filename);
  }
  const filesByMsg = new Map();
  for (let i = 0; i < fileCards.length; i++) {
    const f = fileCards[i];
    const filename = await downloadAsset(f.url, f.name, `${attachmentBase} - file-${i + 1}`, "document");
    if (filename) {
      urlToLocal.set(f.url, filename);
      if (!filesByMsg.has(f.msgIdx)) filesByMsg.set(f.msgIdx, []);
      filesByMsg.get(f.msgIdx).push(filename);
    }
  }

  if (orphanFiles.length) {
    console.log(
      `[ai-export] ${orphanFiles.length} file attachment(s) recorded as wikilinks. ` +
      `ChatGPT doesn't expose a download URL for uploaded files, so they need to be saved ` +
      `manually: in ChatGPT, click the file → download → drop it into the same folder as your .md.`
    );
    for (const o of orphanFiles) console.log(`  - "${o.name}" (message #${o.msgIdx + 1})`);
  }

  // Diagnostic dump: only fires if we found nothing of any kind. With the
  // aria-label detection above we shouldn't normally hit this, but it stays
  // as a safety net for future ChatGPT redesigns.
  const totalDetected = imgUrls.size + fileCards.length + orphanFiles.length;
  if (totalDetected === 0) {
    console.warn(
      "[ai-export] No attachments of any kind detected. If this chat has " +
      "uploaded files, the DOM may have changed or the message may be " +
      "virtualised off-screen (try scrolling to the very top first). " +
      "Diagnostic dump follows:"
    );
    for (let idx = 0; idx < messages.length; idx++) {
      const m = messages[idx];
      if (m.getAttribute("data-message-author-role") !== "user") continue;
      const html = m.innerHTML;
      if (m.children.length > 1 || html.length > 600) {
        console.warn(
          `  User msg #${idx + 1}: ${m.children.length} children, ${html.length} chars of HTML — first 2000 chars:`
        );
        console.warn(html.slice(0, 2000));
      }
    }
    const ariaCandidates = document.querySelectorAll(
      "[aria-label*='pdf' i], [aria-label*='document' i], [aria-label*='attachment' i], [aria-label*='file' i]"
    );
    if (ariaCandidates.length) {
      console.warn(`  ${ariaCandidates.length} document-wide element(s) with attachment-shaped aria-label:`);
      let shown = 0;
      for (const el of ariaCandidates) {
        if (shown++ >= 5) { console.warn(`  …and ${ariaCandidates.length - 5} more`); break; }
        console.warn(`    <${el.tagName.toLowerCase()}> aria-label="${el.getAttribute("aria-label")}"`);
        console.warn(el.outerHTML.slice(0, 600));
      }
    }
  }

  // Pass 3: build markdown, with inline-image substitution, fallback append
  // for any collected images htmlToMd didn't render, file-card wikilinks
  // (when a URL was discoverable), and orphan wikilinks (filename only —
  // user must save those manually).
  let inlined = 0;
  let appended = 0;
  const partsArr = [];
  for (let idx = 0; idx < messages.length; idx++) {
    const m = messages[idx];
    const role = m.getAttribute("data-message-author-role"); // user | assistant | tool | system
    const content = m.querySelector(".markdown") ?? m;
    const consumed = new Set();
    let md = htmlToMd(content, { urlToLocal, consumed }).replace(/\n{3,}/g, "\n\n").trim();
    inlined += consumed.size;

    const orphanImgs = [...imgsByMsg[idx]].filter((u) => urlToLocal.has(u) && !consumed.has(u));
    if (orphanImgs.length) {
      md += "\n\n" + orphanImgs.map((u) => `![[${urlToLocal.get(u)}]]`).join("\n");
      appended += orphanImgs.length;
    }

    const files = filesByMsg.get(idx) || [];
    const orphans = orphansByMsg.get(idx) || [];
    const cards = fileCardsByMsg.get(idx) || [];
    const failedCards = cards.filter((c) => !urlToLocal.has(c.url));
    const failedImgs = [...imgsByMsg[idx]].filter((u) => !urlToLocal.has(u));
    const fileLines = [
      ...files.map((f) => `![[${f}]]`),
      ...failedCards.map((c) => `![[${c.name}]] <!-- download failed (source: ${c.url}) -->`),
      ...orphans.map((n) => `![[${n}]] <!-- save manually from ChatGPT — file may have expired -->`),
      ...failedImgs.map((u) => `<!-- image failed to download: ${u} -->`),
    ];
    if (fileLines.length) {
      md += (md ? "\n\n" : "") + fileLines.join("\n");
    }

    const heading =
      role === "user" ? "## User" :
      role === "assistant" ? "## Assistant" :
      `## ${role}`;
    partsArr.push(`${heading}\n\n${md}`);
  }

  const filename = `${baseName}.md`;
  const fileContent = buildDocument({
    source: "chatgpt",
    title,
    parts: partsArr,
    messageCount: messages.length,
  });

  download(filename, fileContent);
  const dl = urlToLocal.size;
  console.log(
    `[ai-export] Exported ${messages.length} messages, ${dl} attachment(s) downloaded ` +
    `(${inlined} inlined, ${appended} appended) -> ${filename}` +
    (orphanFiles.length ? `, ${orphanFiles.length} file(s) referenced as wikilinks (save manually)` : "")
  );
  report(true, {
    filename, messages: messages.length, attachments: dl,
    inlined, appended, orphans: orphanFiles.length,
  });
})();
