// Service worker. Routes the toolbar click to the matching provider script
// based on the active tab's URL, and flashes an OK/ERR badge for feedback.
// Also registers a right-click "About" entry that opens about.html as a
// small popup window.

const ABOUT_MENU_ID = "ai-export-about";

// Context menu must be (re)created on install/update; doing it on every SW
// startup would throw on duplicate IDs.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: ABOUT_MENU_ID,
    title: "About Robot Therapist Transcriber",
    contexts: ["action"],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== ABOUT_MENU_ID) return;
  chrome.windows.create({
    url: chrome.runtime.getURL("about.html"),
    type: "popup",
    width: 640,
    height: 720,
  });
});

const PROVIDERS = [
  {
    id: "chatgpt",
    match: (u) =>
      u.hostname === "chatgpt.com" ||
      u.hostname.endsWith(".chatgpt.com") ||
      u.hostname === "chat.openai.com",
    file: "providers/chatgpt.js",
  },
  {
    id: "gemini",
    match: (u) => u.hostname === "gemini.google.com",
    file: "providers/gemini.js",
  },
  {
    id: "claude",
    match: (u) => u.hostname === "claude.ai" || u.hostname.endsWith(".claude.ai"),
    file: "providers/claude.js",
  },
];

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;

  let url;
  try { url = new URL(tab.url); } catch { return; }

  const provider = PROVIDERS.find((p) => p.match(url));
  if (!provider) {
    await flash(tab.id, "?", "#888");
    console.warn(`[ai-export] no provider for ${url.hostname}`);
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["providers/shared.js", provider.file],
    });
  } catch (e) {
    console.error("[ai-export] inject failed", e);
    await flash(tab.id, "ERR", "#c33");
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "download-asset") {
    handleDownloadAsset(msg).then(sendResponse);
    return true; // keep channel open for the async response
  }
  if (msg?.type === "ai-export-status") {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    if (msg.ok) flash(tabId, "OK", "#2a8");
    else flash(tabId, "ERR", "#c33");
  }
});

async function handleDownloadAsset(msg) {
  try {
    const id = await chrome.downloads.download({
      url: msg.url,
      filename: msg.filename,
      conflictAction: "overwrite",
      saveAs: false,
    });

    // For data: URLs the content script already set the right extension
    // from the real MIME type — no Chrome rewrite to worry about. For real
    // http(s) URLs (page-fetch fallback), Chrome may swap our extension
    // based on Content-Type, so wait for the download to finish and read
    // back the actual filename.
    if (msg.url.startsWith("data:")) {
      return { ok: true, id, filename: msg.filename };
    }
    const finalFilename = await waitForCompletedFilename(id, msg.filename);
    return { ok: true, id, filename: finalFilename };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function waitForCompletedFilename(id, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const finalize = async () => {
      if (done) return;
      done = true;
      chrome.downloads.onChanged.removeListener(handler);
      try {
        const items = await chrome.downloads.search({ id });
        const fullPath = items[0]?.filename || "";
        const fromPath = fullPath.split(/[/\\]/).pop();
        resolve(fromPath || fallback);
      } catch {
        resolve(fallback);
      }
    };
    const handler = (delta) => {
      if (delta.id !== id) return;
      const state = delta.state?.current;
      if (state === "complete" || state === "interrupted") finalize();
    };
    chrome.downloads.onChanged.addListener(handler);
    setTimeout(finalize, 15000); // safety timeout
  });
}

async function flash(tabId, text, color) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    setTimeout(
      () => chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {}),
      2500,
    );
  } catch (e) {
    console.warn("[ai-export] flash failed", e);
  }
}
