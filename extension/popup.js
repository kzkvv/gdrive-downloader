import { downloadToBlob } from "./downloader.js";
import { mergeAV } from "./merger.js";

const DEFAULT_NAME = "call";
const FAST_CAPTURE_POLL_MS = 100;
const STABLE_CAPTURE_POLL_MS = 1000;
const DRIVE_QUALITY_LABELS = new Map([
  ["tiny", "144p"],
  ["small", "240p"],
  ["medium", "360p"],
  ["large", "480p"],
  ["hd720", "720p"],
  ["hd1080", "1080p"],
  ["hd1440", "1440p"],
  ["hd2160", "2160p"],
  ["highres", "4320p"],
]);
const ITAG_QUALITY_LABELS = new Map([
  ["18", "360p"],
  ["22", "720p"],
  ["37", "1080p"],
  ["38", "3072p"],
  ["59", "480p"],
  ["133", "240p"],
  ["134", "360p"],
  ["135", "480p"],
  ["136", "720p"],
  ["137", "1080p"],
  ["160", "144p"],
  ["212", "480p"],
  ["264", "1440p"],
  ["266", "2160p"],
  ["278", "144p"],
  ["298", "720p"],
  ["299", "1080p"],
]);

const elements = {
  audioCard: document.getElementById("audioCard"),
  audioMeta: document.getElementById("audioMeta"),
  audioState: document.getElementById("audioState"),
  closePanel: document.getElementById("closePanel"),
  copyLogs: document.getElementById("copyLogs"),
  downloadAudio: document.getElementById("downloadAudio"),
  downloadMerged: document.getElementById("downloadMerged"),
  downloadVideo: document.getElementById("downloadVideo"),
  log: document.getElementById("log"),
  phase: document.getElementById("phase"),
  progressBar: document.getElementById("progressBar"),
  progressCopy: document.getElementById("progressCopy"),
  qualityHint: document.getElementById("qualityHint"),
  summary: document.getElementById("summary"),
  videoCard: document.getElementById("videoCard"),
  videoMeta: document.getElementById("videoMeta"),
  videoQuality: document.getElementById("videoQuality"),
  videoState: document.getElementById("videoState"),
};

let busy = false;
let capture = null;
let baseName = DEFAULT_NAME;
let capturePollTimer = null;
let capturePollInFlight = false;
let lastCaptureSnapshot = "";
let pollMode = "fast";
let selectedVideoKey = "";

function formatBytes(bytes) {
  if (!bytes) {
    return "unknown size";
  }

  if (bytes >= 1e9) {
    return `${(bytes / 1e9).toFixed(2)} GB`;
  }

  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");

  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join("-")
    + `_`
    + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join("-");
}

function sanitizeBaseName(title) {
  const stripped = (title || "").replace(/\s+-\s+Google Drive$/i, "").trim();
  const fallback = stripped || DEFAULT_NAME;

  return fallback
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || DEFAULT_NAME;
}

function makeFilename(suffix) {
  return `${baseName}_${timestamp()}${suffix}`;
}

function addLog(message) {
  if (!message) {
    return;
  }

  const stamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  elements.log.textContent = `[${stamp}] ${message}\n${elements.log.textContent}`.trim();
}

function videoKey(stream) {
  return stream?.itag || stream?.url || "";
}

function baseQualityLabel(stream) {
  if (!stream) {
    return "";
  }

  if (stream.qualityLabel) {
    return stream.qualityLabel;
  }

  if (stream.quality && DRIVE_QUALITY_LABELS.has(stream.quality)) {
    return DRIVE_QUALITY_LABELS.get(stream.quality);
  }

  if (stream.itag && ITAG_QUALITY_LABELS.has(stream.itag)) {
    return ITAG_QUALITY_LABELS.get(stream.itag);
  }

  if (stream.quality) {
    return stream.quality;
  }

  return stream.itag ? `itag ${stream.itag}` : "Unknown quality";
}

function displayQualityLabel(stream) {
  if (!stream) {
    return "Unknown quality";
  }

  let label = baseQualityLabel(stream);

  if (stream.fps > 30 && !label.includes(`${stream.fps}`) && !/fps$/i.test(label)) {
    label = `${label} ${stream.fps} fps`;
  }

  return label;
}

function inferHeight(stream) {
  if (!stream) {
    return 0;
  }

  const label = baseQualityLabel(stream);
  const match = /^(\d{3,4})p$/i.exec(label);

  if (match) {
    return Number.parseInt(match[1], 10);
  }

  return 0;
}

function compareVideoStreams(left, right) {
  const heightDiff = inferHeight(right) - inferHeight(left);

  if (heightDiff !== 0) {
    return heightDiff;
  }

  const fpsDiff = (right?.fps ?? 0) - (left?.fps ?? 0);

  if (fpsDiff !== 0) {
    return fpsDiff;
  }

  const sizeDiff = (right?.clen ?? 0) - (left?.clen ?? 0);

  if (sizeDiff !== 0) {
    return sizeDiff;
  }

  return (Number.parseInt(right?.itag ?? "0", 10) || 0)
    - (Number.parseInt(left?.itag ?? "0", 10) || 0);
}

function availableVideos(nextCapture = capture) {
  if (!nextCapture) {
    return [];
  }

  const streams = [];
  const seen = new Set();
  const push = (stream) => {
    if (!stream) {
      return;
    }

    const key = videoKey(stream);

    if (!key || seen.has(key)) {
      return;
    }

    seen.add(key);
    streams.push(stream);
  };

  for (const stream of nextCapture.videos || []) {
    push(stream);
  }

  push(nextCapture.video || null);

  return streams.sort(compareVideoStreams);
}

function selectedVideo(nextCapture = capture) {
  const streams = availableVideos(nextCapture);

  if (!streams.length) {
    return null;
  }

  return streams.find((stream) => videoKey(stream) === selectedVideoKey) || streams[0];
}

function syncSelectedVideo(nextCapture = capture) {
  const stream = selectedVideo(nextCapture);
  selectedVideoKey = stream ? videoKey(stream) : "";
  return stream;
}

function describeCaptureState(nextCapture) {
  if (!nextCapture) {
    return "capture: none";
  }

  return [
    `audio=${nextCapture.audio ? "yes" : "no"}`,
    `videoQualities=${availableVideos(nextCapture).length}`,
    `updatedAt=${nextCapture.updatedAt || 0}`,
  ].join(" | ");
}

function captureSnapshot(nextCapture, tabId, tabUrl) {
  return JSON.stringify({
    audioClen: nextCapture?.audio?.clen ?? 0,
    audioItag: nextCapture?.audio?.itag ?? "",
    tabId: tabId ?? null,
    tabUrl: tabUrl ?? "",
    videos: availableVideos(nextCapture).map((stream) => ({
      clen: stream.clen ?? 0,
      fps: stream.fps ?? 0,
      itag: stream.itag ?? "",
      key: videoKey(stream),
      label: displayQualityLabel(stream),
    })),
  });
}

function captureReady(nextCapture) {
  return Boolean(nextCapture?.audio && availableVideos(nextCapture).length);
}

function nextPollDelay() {
  return captureReady(capture) ? STABLE_CAPTURE_POLL_MS : FAST_CAPTURE_POLL_MS;
}

function clearCapturePollTimer() {
  if (capturePollTimer !== null) {
    clearTimeout(capturePollTimer);
    capturePollTimer = null;
  }
}

function scheduleCapturePoll(delay = nextPollDelay()) {
  clearCapturePollTimer();
  capturePollTimer = setTimeout(() => {
    void pollCapture();
  }, delay);
}

function logCaptureTransition(previousCapture, nextCapture) {
  const previousVideos = availableVideos(previousCapture);
  const nextVideos = availableVideos(nextCapture);
  const previousKeys = new Set(previousVideos.map((stream) => videoKey(stream)));
  const hadVideo = previousVideos.length > 0;
  const hasVideo = nextVideos.length > 0;
  const hadAudio = Boolean(previousCapture?.audio);
  const hasAudio = Boolean(nextCapture?.audio);

  if (!hadVideo && hasVideo) {
    addLog("Detected video stream.");
  }

  for (const stream of nextVideos) {
    if (!previousKeys.has(videoKey(stream))) {
      addLog(`Detected video quality: ${displayQualityLabel(stream)}.`);
    }
  }

  if (!hadAudio && hasAudio) {
    addLog("Detected audio stream.");
  }

  if ((hadVideo || hadAudio) && !hasVideo && !hasAudio) {
    addLog("Streams are no longer available for the active tab.");
  }
}

function setSummary(message) {
  elements.summary.textContent = message;
}

function setProgressLabel(phase, detail = "") {
  elements.phase.textContent = phase;
  elements.progressCopy.textContent = detail;
}

function hideProgress() {
  elements.progressBar.hidden = true;
  elements.progressBar.max = 100;
  elements.progressBar.value = 0;
  setProgressLabel("Idle");
}

function showProgress(phase, done, total) {
  const percent = total > 0 ? (done / total) * 100 : 0;

  elements.progressBar.hidden = false;
  elements.progressBar.max = 100;
  elements.progressBar.value = percent;

  setProgressLabel(
    phase,
    `${formatBytes(done)} / ${formatBytes(total)} (${percent.toFixed(1)}%)`,
  );
}

function showIndeterminate(phase, detail = "Working...") {
  elements.progressBar.hidden = false;
  elements.progressBar.removeAttribute("value");
  setProgressLabel(phase, detail);
}

function describeVideoStream(stream, count) {
  if (!stream) {
    return {
      meta: "No video qualities captured yet.",
      state: "Waiting for playback",
    };
  }

  const meta = [
    `${count} ${count === 1 ? "quality" : "qualities"} captured`,
    `itag ${stream.itag || "?"}`,
    formatBytes(stream.clen),
  ].join(" | ");

  return {
    meta,
    state: count > 1 ? `${displayQualityLabel(stream)} selected` : `${displayQualityLabel(stream)} ready`,
  };
}

function describeAudioStream(stream) {
  if (!stream) {
    return {
      meta: "Let the Drive player run a little longer.",
      state: "Not detected",
    };
  }

  return {
    meta: `itag ${stream.itag || "?"} | ${formatBytes(stream.clen)}`,
    state: "Track ready",
  };
}

function describeVideoOption(stream) {
  return `${displayQualityLabel(stream)} | itag ${stream.itag || "?"} | ${formatBytes(stream.clen)}`;
}

function renderVideoSelector() {
  const streams = availableVideos();
  const selected = syncSelectedVideo();

  elements.videoQuality.textContent = "";

  if (!streams.length) {
    elements.videoQuality.add(new Option("Waiting for video qualities...", ""));
    elements.qualityHint.textContent = "Only qualities already requested by the Drive player appear here.";
    return null;
  }

  for (const stream of streams) {
    const option = new Option(describeVideoOption(stream), videoKey(stream));
    option.selected = videoKey(stream) === selectedVideoKey;
    elements.videoQuality.add(option);
  }

  elements.videoQuality.value = selectedVideoKey;
  elements.qualityHint.textContent = streams.length > 1
    ? `${streams.length} qualities are captured. Keep playback running or switch quality in Drive to discover more.`
    : "Only one quality has been captured so far. Switch quality in the Drive player to discover more.";

  return selected;
}

function refreshButtons() {
  const videoCount = availableVideos().length;
  const video = selectedVideo();

  elements.downloadAudio.disabled = busy || !capture?.audio;
  elements.downloadVideo.disabled = busy || !video;
  elements.downloadMerged.disabled = busy || !(capture?.audio && video);
  elements.videoQuality.disabled = busy || videoCount < 2;
}

function renderCapture() {
  const video = renderVideoSelector();
  const audio = capture?.audio ?? null;
  const videoCount = availableVideos().length;
  const videoInfo = describeVideoStream(video, videoCount);
  const audioInfo = describeAudioStream(audio);

  elements.videoCard.dataset.found = String(videoCount > 0);
  elements.audioCard.dataset.found = String(Boolean(audio));
  elements.videoState.textContent = videoInfo.state;
  elements.videoMeta.textContent = videoInfo.meta;
  elements.audioState.textContent = audioInfo.state;
  elements.audioMeta.textContent = audioInfo.meta;

  if (video && audio && videoCount > 1) {
    setSummary("Audio is ready and multiple video qualities are captured. Pick the quality you want, then download or merge.");
  } else if (video && audio) {
    setSummary("Both streams are captured. You can download them now; the panel will keep checking in the background.");
  } else if (videoCount > 0 || audio) {
    setSummary("One stream is captured so far. Keep playback running; the panel is still watching for the other stream and more video qualities.");
  } else {
    setSummary("No Drive streams are captured yet. Start playback and keep this panel open; it will detect streams automatically.");
  }

  refreshButtons();
}

function setBusy(nextBusy) {
  busy = nextBusy;
  refreshButtons();
  elements.closePanel.disabled = busy;
  elements.copyLogs.disabled = false;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
}

function startDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(downloadId);
    });
  });
}

async function saveBlob(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);

  try {
    await startDownload({
      conflictAction: "uniquify",
      filename,
      saveAs: false,
      url: objectUrl,
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }
}

async function runJob(job) {
  setBusy(true);

  try {
    await job();
  } catch (error) {
    addLog(`ERROR: ${error.message}`);
    setSummary(error.message);
  } finally {
    setBusy(false);
    hideProgress();
  }
}

async function refreshCapture({ silent = false } = {}) {
  if (!silent) {
    addLog("Requesting captured streams from background worker...");
  }

  const response = await sendMessage({ type: "getCapture" });

  if (response?.error) {
    throw new Error(response.error);
  }

  const previousCapture = capture;
  baseName = sanitizeBaseName(response?.tabTitle);
  capture = response?.capture ?? null;
  const snapshot = captureSnapshot(capture, response?.tabId, response?.tabUrl);
  const changed = snapshot !== lastCaptureSnapshot;
  const ready = captureReady(capture);

  if (!silent || changed) {
    addLog(
      [
        `Active tab id=${response?.tabId ?? "?"}`,
        `title=${response?.tabTitle || "(untitled)"}`,
        `url=${response?.tabUrl || "(no url)"}`,
        describeCaptureState(capture),
      ].join(" | "),
    );
  }

  if (changed) {
    logCaptureTransition(previousCapture, capture);
    lastCaptureSnapshot = snapshot;
  }

  if (ready && pollMode !== "stable") {
    pollMode = "stable";
    addLog(`Streams found. Switching auto-refresh to ${STABLE_CAPTURE_POLL_MS} ms.`);
  } else if (!ready && pollMode !== "fast") {
    pollMode = "fast";
    addLog(`Streams missing. Switching auto-refresh to ${FAST_CAPTURE_POLL_MS} ms.`);
  }

  renderCapture();
}

async function pollCapture() {
  if (capturePollInFlight) {
    scheduleCapturePoll();
    return;
  }

  capturePollInFlight = true;

  try {
    await refreshCapture({ silent: true });
  } catch (error) {
    addLog(`ERROR: ${error.message}`);
    setSummary("Could not read captured Drive streams from the background worker.");
  } finally {
    capturePollInFlight = false;
    scheduleCapturePoll();
  }
}

async function copyLogsToClipboard() {
  const text = elements.log.textContent.trim();

  if (!text) {
    addLog("No logs to copy.");
    return;
  }

  await navigator.clipboard.writeText(text);
  addLog("Copied logs to clipboard.");
}

async function closeSidePanel() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  const windowId = activeTab?.windowId;

  if (typeof windowId !== "number") {
    throw new Error("Could not determine the current window.");
  }

  await chrome.sidePanel.close({ windowId });
}

elements.downloadAudio.addEventListener("click", () => {
  void runJob(async () => {
    addLog("Downloading audio stream...");
    const audioBlob = await downloadToBlob(capture.audio.url, (done, total) => {
      showProgress("Audio download", done, total);
    });

    await saveBlob(audioBlob, makeFilename(".m4a"));
    addLog("Saved audio track.");
  });
});

elements.downloadVideo.addEventListener("click", () => {
  void runJob(async () => {
    const video = selectedVideo();

    if (!video) {
      throw new Error("No video quality is selected.");
    }

    addLog(`Downloading video stream (${displayQualityLabel(video)})...`);
    const videoBlob = await downloadToBlob(video.url, (done, total) => {
      showProgress("Video download", done, total);
    });

    await saveBlob(videoBlob, makeFilename("_video-only.mp4"));
    addLog(`Saved video track (${displayQualityLabel(video)}).`);
  });
});

elements.downloadMerged.addEventListener("click", () => {
  void runJob(async () => {
    const video = selectedVideo();

    if (!video) {
      throw new Error("No video quality is selected.");
    }

    addLog(`Downloading video stream (${displayQualityLabel(video)})...`);
    const videoBlob = await downloadToBlob(video.url, (done, total) => {
      showProgress("Video download", done, total);
    });

    addLog("Downloading audio stream...");
    const audioBlob = await downloadToBlob(capture.audio.url, (done, total) => {
      showProgress("Audio download", done, total);
    });

    addLog("Merging with ffmpeg.wasm...");
    showIndeterminate("Muxing", "ffmpeg.wasm is working...");

    const mergedBlob = await mergeAV(videoBlob, audioBlob, {
      onLog: (message) => addLog(message),
      onProgress: (progress) => {
        elements.progressBar.max = 100;
        elements.progressBar.value = Math.max(0, Math.min(progress * 100, 100));
        setProgressLabel("Muxing", `${(progress * 100).toFixed(1)}%`);
      },
    });

    await saveBlob(mergedBlob, makeFilename(".mp4"));
    addLog(`Saved merged MP4 (${displayQualityLabel(video)}).`);
  });
});

elements.copyLogs.addEventListener("click", () => {
  void copyLogsToClipboard().catch((error) => {
    addLog(`ERROR: ${error.message}`);
  });
});

elements.closePanel.addEventListener("click", () => {
  void closeSidePanel().catch((error) => {
    addLog(`ERROR: ${error.message}`);
  });
});

elements.videoQuality.addEventListener("change", () => {
  selectedVideoKey = elements.videoQuality.value;
  const video = selectedVideo();

  if (video) {
    addLog(`Selected video quality: ${displayQualityLabel(video)}.`);
  }

  renderCapture();
});

hideProgress();
setBusy(false);
addLog(`Auto-detect is active. Polling every ${FAST_CAPTURE_POLL_MS} ms until streams appear.`);

void refreshCapture()
  .catch((error) => {
    addLog(`ERROR: ${error.message}`);
    setSummary("Could not read captured Drive streams from the background worker.");
  })
  .finally(() => {
    scheduleCapturePoll();
  });

window.addEventListener("beforeunload", () => {
  clearCapturePollTimer();
});
