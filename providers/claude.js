// Claude extractor. Runs in the page's content-script world after shared.js.

(async () => {
  const { htmlToMd, sanitize, buildDocument, download, downloadAsset, report, resolveImgSrc } = globalThis.__aiExport;

  const SELECTORS = [
    '[data-testid="user-message"]',
    '[data-testid="assistant-message"]',
    ".font-user-message",
    ".font-claude-message",
  ];
  const messages = Array.from(document.querySelectorAll(SELECTORS.join(", ")));
  if (!messages.length) {
    console.error(`[ai-export] No messages found. Claude may have changed the DOM. Tried: ${SELECTORS.join(", ")}`);
    report(false, { reason: "no-messages" });
    return;
  }

  const isUser = (el) =>
    el.matches('[data-testid="user-message"], .font-user-message');

  const docTitle = document.title.replace(/\s*[-–—]\s*Claude\s*$/, "").trim();
  const title =
    (docTitle && docTitle.toLowerCase() !== "claude" ? docTitle : "") ||
    "Claude conversation";
  const baseName = sanitize(title);
  // Keep a shorter prefix for attachment filenames so the per-attachment
  // suffix (- image-1, etc.) survives any later size capping.
  const attachmentBase = baseName.slice(0, 50).trim();

  // Per-message image URLs.
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

  // Download images via the SW.
  const urlToLocal = new Map();
  let imgIdx = 0;
  for (const url of imgUrls) {
    imgIdx++;
    const filename = await downloadAsset(url, null, `${attachmentBase} - image-${imgIdx}`, "image");
    if (filename) urlToLocal.set(url, filename);
  }

  let inlined = 0;
  let appended = 0;
  const parts = messages.map((m, idx) => {
    const role = isUser(m) ? "user" : "assistant";
    const consumed = new Set();
    let md = htmlToMd(m, { urlToLocal, consumed }).replace(/\n{3,}/g, "\n\n").trim();
    inlined += consumed.size;

    const orphanImgs = [...imgsByMsg[idx]].filter((u) => urlToLocal.has(u) && !consumed.has(u));
    if (orphanImgs.length) {
      md += "\n\n" + orphanImgs.map((u) => `![[${urlToLocal.get(u)}]]`).join("\n");
      appended += orphanImgs.length;
    }

    const failedImgs = [...imgsByMsg[idx]].filter((u) => !urlToLocal.has(u));
    if (failedImgs.length) {
      md += "\n\n" + failedImgs.map((u) => `<!-- image failed to download: ${u} -->`).join("\n");
    }

    const heading = role === "user" ? "## User" : "## Assistant";
    return `${heading}\n\n${md}`;
  });

  const filename = `${baseName}.md`;
  const fileContent = buildDocument({
    source: "claude",
    title,
    parts,
    messageCount: messages.length,
  });

  download(filename, fileContent);
  console.log(
    `[ai-export] Exported ${messages.length} messages, ${urlToLocal.size} image(s) ` +
    `(${inlined} inlined, ${appended} appended) -> ${filename}`
  );
  report(true, {
    filename, messages: messages.length, attachments: urlToLocal.size,
    inlined, appended,
  });
})();
