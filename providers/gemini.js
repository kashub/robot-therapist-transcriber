// Gemini extractor. Runs in the page's content-script world after shared.js.

(async () => {
  const { htmlToMd, sanitize, buildDocument, download, downloadAsset, report, resolveImgSrc } = globalThis.__aiExport;

  // Gemini renders each turn as a custom element: <user-query> then <model-response>.
  const turns = Array.from(document.querySelectorAll("user-query, model-response"));
  if (!turns.length) {
    console.error("[ai-export] No turns found. Gemini may have changed the DOM. Selectors: user-query, model-response");
    report(false, { reason: "no-turns" });
    return;
  }

  // Gemini's <title> is typically just "Gemini" - try the selected sidebar item first.
  const sidebarTitle =
    document.querySelector("[data-test-id='conversation'].selected")?.textContent?.trim() ??
    document.querySelector(".conversation.selected .conversation-title")?.textContent?.trim() ??
    document.querySelector("[aria-current='true']")?.textContent?.trim() ??
    "";
  const docTitle = document.title.replace(/\s*[-–—]\s*Gemini\s*$/, "").trim();
  const title =
    sidebarTitle ||
    (docTitle && docTitle.toLowerCase() !== "gemini" ? docTitle : "") ||
    `Gemini chat ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const baseName = sanitize(title);
  // Keep a shorter prefix for attachment filenames so the per-attachment
  // suffix (- image-1, etc.) survives any later size capping.
  const attachmentBase = baseName.slice(0, 50).trim();

  // Per-turn image URLs.
  const imgsByTurn = turns.map((t) => {
    const set = new Set();
    for (const img of t.querySelectorAll("img")) {
      const src = resolveImgSrc(img);
      if (src) set.add(src);
    }
    return set;
  });
  const imgUrls = new Set();
  for (const s of imgsByTurn) for (const u of s) imgUrls.add(u);

  // Diagnostic: where are images on the page, vs. inside turns? Helps spot
  // images that live outside <user-query>/<model-response>, or that use
  // background-image / custom elements instead of <img>.
  const allImgs = document.querySelectorAll("img");
  const insideTurns = [...allImgs].filter((i) => i.closest("user-query, model-response")).length;
  console.log(
    `[ai-export] doc-wide: ${allImgs.length} <img> total, ${insideTurns} inside turns, ` +
    `${allImgs.length - insideTurns} outside`
  );
  if (allImgs.length - insideTurns > 0) {
    const outside = [...allImgs]
      .filter((i) => !i.closest("user-query, model-response"))
      .map((i) => resolveImgSrc(i))
      .filter(Boolean);
    console.log("  outside img urls (sample):", outside.slice(0, 10));
  }
  const customTags = new Set();
  for (const t of turns) {
    for (const el of t.querySelectorAll("*")) {
      if (el.tagName.includes("-")) customTags.add(el.tagName.toLowerCase());
    }
  }
  console.log("  custom elements inside turns:", [...customTags].sort().join(", ") || "(none)");
  const interesting = turns.map((t, i) => {
    const role = t.tagName.toLowerCase() === "user-query" ? "user" : "assistant";
    const imgs = t.querySelectorAll("img").length;
    const bgs = t.querySelectorAll("[style*='background-image']").length;
    const customImg = [...t.querySelectorAll("*")].filter(
      (e) => e.tagName.includes("-") && /image|picture|media|figure|gallery/i.test(e.tagName)
    ).length;
    const html = t.outerHTML.length;
    return { turn: i + 1, role, imgs, bgs, customImg, html };
  }).filter((s) => s.imgs > 0 || s.bgs > 0 || s.customImg > 0 || s.html > 5000);
  if (interesting.length) {
    console.log("[ai-export] interesting turns (have images or large HTML):");
    console.table(interesting);
  }

  // Download images via the SW.
  const urlToLocal = new Map();
  let imgIdx = 0;
  for (const url of imgUrls) {
    imgIdx++;
    const filename = await downloadAsset(url, null, `${attachmentBase} - image-${imgIdx}`, "image");
    if (filename) urlToLocal.set(url, filename);
  }

  console.log(
    `[ai-export] gemini: ${turns.length} turn(s), ${imgUrls.size} unique image url(s), ` +
    `${urlToLocal.size} downloaded successfully`
  );

  let inlined = 0;
  let appended = 0;
  const parts = turns.map((t, idx) => {
    const role = t.tagName.toLowerCase() === "user-query" ? "user" : "assistant";
    const content =
      t.querySelector(".markdown") ??
      t.querySelector("message-content") ??
      t.querySelector(".query-text") ??
      t;
    const consumed = new Set();
    let md = htmlToMd(content, { urlToLocal, consumed }).replace(/\n{3,}/g, "\n\n").trim();
    inlined += consumed.size;

    const orphanImgs = [...imgsByTurn[idx]].filter((u) => urlToLocal.has(u) && !consumed.has(u));
    if (orphanImgs.length) {
      md += "\n\n" + orphanImgs.map((u) => `![[${urlToLocal.get(u)}]]`).join("\n");
      appended += orphanImgs.length;
    }

    const failedImgs = [...imgsByTurn[idx]].filter((u) => !urlToLocal.has(u));
    if (failedImgs.length) {
      md += "\n\n" + failedImgs.map((u) => `<!-- image failed to download: ${u} -->`).join("\n");
    }

    if (imgsByTurn[idx].size > 0 || consumed.size > 0) {
      console.log(
        `  turn ${idx + 1} (${role}): collected=${imgsByTurn[idx].size}, ` +
        `inlined=${consumed.size}, appended=${orphanImgs.length}, ` +
        `content-tag=${content.tagName?.toLowerCase()}`
      );
    }

    const heading = role === "user" ? "## User" : "## Assistant";
    return `${heading}\n\n${md}`;
  });

  const filename = `${baseName}.md`;
  const fileContent = buildDocument({
    source: "gemini",
    title,
    parts,
    messageCount: turns.length,
  });

  download(filename, fileContent);
  console.log(
    `[ai-export] Exported ${turns.length} turns, ${urlToLocal.size} image(s) ` +
    `(${inlined} inlined, ${appended} appended) -> ${filename}`
  );
  report(true, {
    filename, messages: turns.length, attachments: urlToLocal.size,
    inlined, appended,
  });
})();
