const NUM_CONNECTIONS = 32;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

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

async function probeSize(url) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Range: "bytes=0-0" },
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

  return total;
}

async function streamIntoBuffer(response, target, startOffset, updateProgress) {
  if (!response.body) {
    const data = new Uint8Array(await response.arrayBuffer());
    target.set(data, startOffset);
    updateProgress(data.byteLength);
    return;
  }

  const reader = response.body.getReader();
  let writeOffset = startOffset;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      return;
    }

    target.set(value, writeOffset);
    writeOffset += value.byteLength;
    updateProgress(value.byteLength);
  }
}

export async function downloadToBlob(url, onProgress) {
  const total = await probeSize(url);

  if (!total) {
    throw new Error("Could not determine file size.");
  }

  const ranges = [];

  for (let start = 0; start < total; start += MAX_CHUNK_BYTES) {
    ranges.push({
      start,
      end: Math.min(start + MAX_CHUNK_BYTES - 1, total - 1),
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
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Range: `bytes=${start}-${end}` },
    });

    const fullRange = start === 0 && end === total - 1;

    if (response.status !== 206 && !(response.status === 200 && fullRange)) {
      throw new Error(`Range ${start}-${end} failed with HTTP ${response.status}`);
    }

    await streamIntoBuffer(response, buffer, start, updateProgress);
  }

  const workers = Array.from({ length: Math.min(NUM_CONNECTIONS, ranges.length) }, async () => {
    while (true) {
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
