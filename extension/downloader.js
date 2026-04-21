export const DEFAULT_NUM_CONNECTIONS = 4;
export const DEFAULT_MAX_CHUNK_BYTES = 8 * 1024 * 1024;

function createAbortError() {
  return new DOMException("Download stopped.", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : createAbortError();
  }
}

function detectMime(url) {
  const mime = new URL(url).searchParams.get("mime");
  return mime ? decodeURIComponent(mime) : "application/octet-stream";
}

function parseTotalSize(response, url) {
  const contentRange = response.headers.get("content-range");

  if (contentRange?.includes("/")) {
    return Number.parseInt(contentRange.split("/").pop() || "0", 10);
  }

  const params = new URL(url).searchParams;
  const fallback = params.get("clen") || response.headers.get("content-length") || "0";
  return Number.parseInt(fallback, 10) || 0;
}

function normalizeInt(value, fallback, min, max) {
  const parsed = Number.parseInt(`${value ?? ""}`, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function normalizeDownloadSettings(settings = {}) {
  return {
    maxChunkBytes: normalizeInt(settings.maxChunkBytes, DEFAULT_MAX_CHUNK_BYTES, 1, 64 * 1024 * 1024),
    numConnections: normalizeInt(settings.numConnections, DEFAULT_NUM_CONNECTIONS, 1, 32),
  };
}

async function probeSize(url, signal) {
  throwIfAborted(signal);

  const response = await fetch(url, {
    cache: "no-store",
    headers: { Range: "bytes=0-0" },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Probe failed with HTTP ${response.status}`);
  }

  const total = parseTotalSize(response, url);

  if (response.body) {
    try {
      await response.body.cancel();
    } catch {
      // Ignore; some implementations lock the body immediately.
    }
  }

  throwIfAborted(signal);
  return total;
}

async function streamIntoBuffer(response, target, startOffset, updateProgress, signal) {
  if (!response.body) {
    throwIfAborted(signal);
    const data = new Uint8Array(await response.arrayBuffer());
    throwIfAborted(signal);
    target.set(data, startOffset);
    updateProgress(data.byteLength);
    return;
  }

  const reader = response.body.getReader();
  let writeOffset = startOffset;

  while (true) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();

    if (done) {
      return;
    }

    throwIfAborted(signal);
    target.set(value, writeOffset);
    writeOffset += value.byteLength;
    updateProgress(value.byteLength);
  }
}

export async function downloadToBlob(url, onProgress, settings = {}, { signal } = {}) {
  const { maxChunkBytes, numConnections } = normalizeDownloadSettings(settings);
  const total = await probeSize(url, signal);

  if (!total) {
    throw new Error("Could not determine file size.");
  }

  const ranges = [];

  for (let start = 0; start < total; start += maxChunkBytes) {
    ranges.push({
      start,
      end: Math.min(start + maxChunkBytes - 1, total - 1),
    });
  }

  const buffer = new Uint8Array(total);
  let downloaded = 0;
  let nextIndex = 0;

  const updateProgress = (size) => {
    downloaded += size;
    onProgress?.(downloaded, total);
  };

  async function fetchRange({ start, end }) {
    throwIfAborted(signal);
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Range: `bytes=${start}-${end}` },
      signal,
    });

    const fullRange = start === 0 && end === total - 1;

    if (response.status !== 206 && !(response.status === 200 && fullRange)) {
      throw new Error(`Range ${start}-${end} failed with HTTP ${response.status}`);
    }

    await streamIntoBuffer(response, buffer, start, updateProgress, signal);
  }

  const workers = Array.from({ length: Math.min(numConnections, ranges.length) }, async () => {
    while (true) {
      throwIfAborted(signal);
      const currentIndex = nextIndex;
      nextIndex += 1;

      const range = ranges[currentIndex];

      if (!range) {
        return;
      }

      await fetchRange(range);
    }
  });

  await Promise.all(workers);

  return new Blob([buffer], { type: detectMime(url) });
}
