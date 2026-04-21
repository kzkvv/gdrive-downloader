const STRIP_PARAMS = new Set(["range", "rn", "rbuf", "ump", "srfvp", "alr"]);
const STREAM_FILTER = {
  urls: [
    "*://*.googlevideo.com/*",
    "*://*.c.drive.google.com/*",
    "*://*.googleusercontent.com/*",
  ],
};

const capturedByTab = new Map();
const DEBUG = false;

function sanitizeLogDetails(details) {
  if (!details || Array.isArray(details) || typeof details !== "object") {
    return details;
  }

  const filtered = Object.fromEntries(
    Object.entries(details).filter(([, value]) => {
      if (value === "" || value === null || value === undefined) {
        return false;
      }

      if (Array.isArray(value) && value.length === 0) {
        return false;
      }

      return true;
    }),
  );

  return Object.keys(filtered).length ? filtered : undefined;
}

function debugLog(message, details) {
  if (!DEBUG) {
    return;
  }

  const sanitized = sanitizeLogDetails(details);

  if (sanitized === undefined) {
    console.log("[Drive Video Downloader]", message);
    return;
  }

  console.log("[Drive Video Downloader]", message, sanitized);
}

function parseSize(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanUrl(rawUrl) {
  const url = new URL(rawUrl);

  for (const param of STRIP_PARAMS) {
    url.searchParams.delete(param);
  }

  return url.toString();
}

function getStreamInfo(rawUrl) {
  const url = new URL(rawUrl);

  return {
    url: cleanUrl(rawUrl),
    mime: decodeURIComponent(url.searchParams.get("mime") || ""),
    itag: url.searchParams.get("itag") || "",
    clen: parseSize(url.searchParams.get("clen")),
    driveId: url.searchParams.get("driveid") || "",
    fps: parseSize(url.searchParams.get("fps")),
    id: url.searchParams.get("id") || "",
    quality: url.searchParams.get("quality") || "",
    qualityLabel: url.searchParams.get("quality_label") || "",
  };
}

function isBetterCandidate(current, next) {
  if (!current) {
    return true;
  }

  if (next.clen !== current.clen) {
    return next.clen > current.clen;
  }

  return parseSize(next.itag) > parseSize(current.itag);
}

function upsertStreamByItag(streams, next) {
  const key = next.itag || next.url;
  const index = streams.findIndex((stream) => (stream.itag || stream.url) === key);

  if (index === -1) {
    streams.push(next);
    return true;
  }

  if (isBetterCandidate(streams[index], next)) {
    streams[index] = next;
    return true;
  }

  return false;
}

function summarizeCapture(capture) {
  if (!capture) {
    return {
      audio: false,
      pageUrl: "",
      updatedAt: 0,
      video: false,
      videoCount: 0,
    };
  }

  return {
    audio: Boolean(capture.audio),
    audioClen: capture.audio?.clen ?? 0,
    audioItag: capture.audio?.itag ?? "",
    pageUrl: capture.pageUrl,
    updatedAt: capture.updatedAt,
    video: Boolean(capture.video),
    videoClen: capture.video?.clen ?? 0,
    videoCount: capture.videos?.length ?? (capture.video ? 1 : 0),
    videoItag: capture.video?.itag ?? "",
  };
}

function clearTab(tabId) {
  debugLog("Clearing captured streams for tab.", {
    hadCapture: capturedByTab.has(tabId),
    tabId,
  });
  capturedByTab.delete(tabId);
}

function onBeforeRequest(details) {
  if (!details.url.includes("videoplayback")) {
    return;
  }

  if (details.tabId < 0) {
    debugLog("Ignoring videoplayback request without a real tab id.", {
      initiator: details.initiator || "",
      tabId: details.tabId,
      type: details.type,
      url: details.url,
    });
    return;
  }

  let stream;

  try {
    stream = getStreamInfo(details.url);
  } catch (error) {
    debugLog("Failed to parse videoplayback request.", {
      error: error instanceof Error ? error.message : String(error),
      tabId: details.tabId,
      url: details.url,
    });
    return;
  }

  const kind = stream.mime.startsWith("video/")
    ? "video"
    : stream.mime.startsWith("audio/")
      ? "audio"
      : null;

  debugLog("Observed videoplayback request.", {
    clen: stream.clen,
    documentUrl: details.documentUrl || "",
    host: new URL(details.url).hostname,
    initiator: details.initiator || "",
    itag: stream.itag,
    kind: kind || "unsupported",
    mime: stream.mime,
    tabId: details.tabId,
    type: details.type,
  });

  if (!kind) {
    debugLog("Ignoring videoplayback request with unsupported mime.", {
      mime: stream.mime,
      tabId: details.tabId,
      url: details.url,
    });
    return;
  }

  const current = capturedByTab.get(details.tabId) ?? {
    audio: null,
    pageUrl: "",
    updatedAt: 0,
    video: null,
    videos: [],
  };

  current.pageUrl = details.documentUrl || details.initiator || current.pageUrl;
  current.updatedAt = Date.now();

  if (kind === "video") {
    current.videos ||= [];
    upsertStreamByItag(current.videos, stream);

    if (isBetterCandidate(current.video, stream)) {
      current.video = stream;
    }

    debugLog("Stored stream candidate for tab.", {
      kind,
      summary: summarizeCapture(current),
      tabId: details.tabId,
    });

    capturedByTab.set(details.tabId, current);
    return;
  }

  if (isBetterCandidate(current.audio, stream)) {
    current.audio = stream;

    debugLog("Stored stream candidate for tab.", {
      kind,
      summary: summarizeCapture(current),
      tabId: details.tabId,
    });
  } else if (kind === "audio") {
    debugLog("Kept existing stream candidate for tab.", {
      existingClen: current.audio?.clen ?? 0,
      kind,
      nextClen: stream.clen,
      tabId: details.tabId,
    });
  }

  capturedByTab.set(details.tabId, current);
}

debugLog("Service worker started.");
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .then(() => {
    debugLog("Configured side panel action behavior.", {
      openPanelOnActionClick: true,
    });
  })
  .catch((error) => {
    debugLog("Failed to configure side panel action behavior.", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, STREAM_FILTER);
debugLog("Registered webRequest listener.", {
  hasListener: chrome.webRequest.onBeforeRequest.hasListener(onBeforeRequest),
  urls: STREAM_FILTER.urls,
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    clearTab(tabId);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "getCapture") {
    return undefined;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      debugLog("Failed to resolve active tab for getCapture.", {
        error: chrome.runtime.lastError.message,
      });
      sendResponse({ error: chrome.runtime.lastError.message });
      return;
    }

    const [tab] = tabs;
    const capture = tab ? capturedByTab.get(tab.id) ?? null : null;

    debugLog("Responding to getCapture.", {
      activeTabId: tab?.id ?? null,
      capture: summarizeCapture(capture),
      trackedTabIds: Array.from(capturedByTab.keys()),
      url: tab?.url ?? "",
    });

    sendResponse({
      capture,
      tabId: tab?.id ?? null,
      tabTitle: tab?.title ?? "",
      tabUrl: tab?.url ?? "",
    });
  });

  return true;
});
