import { FFmpeg } from "./ffmpeg/index.js";

let ffmpegPromise;

function createAbortError() {
  return new DOMException("Merge stopped.", "AbortError");
}

function resetFFmpegPromise() {
  ffmpegPromise = undefined;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : createAbortError();
  }
}

async function loadFFmpeg() {
  const ffmpeg = new FFmpeg();
  const baseUrl = chrome.runtime.getURL("ffmpeg/");

  await ffmpeg.load({
    classWorkerURL: chrome.runtime.getURL("ffmpeg/worker.js"),
    coreURL: `${baseUrl}ffmpeg-core.js`,
    wasmURL: `${baseUrl}ffmpeg-core.wasm`,
  });

  return ffmpeg;
}

function getFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = loadFFmpeg().catch((error) => {
      resetFFmpegPromise();
      throw error;
    });
  }

  return ffmpegPromise;
}

async function safeDelete(ffmpeg, filePath) {
  try {
    await ffmpeg.deleteFile(filePath);
  } catch {
    // Ignore missing files from previous attempts.
  }
}

export async function mergeAV(videoBlob, audioBlob, { onLog, onProgress, signal } = {}) {
  throwIfAborted(signal);
  const ffmpeg = await getFFmpeg();
  throwIfAborted(signal);

  const logHandler = onLog
    ? ({ message, type }) => {
        const prefix = type ? `${type}: ` : "";
        onLog(`${prefix}${message}`.trim());
      }
    : null;

  const progressHandler = onProgress
    ? ({ progress, time }) => onProgress(progress, time)
    : null;

  if (logHandler) {
    ffmpeg.on("log", logHandler);
  }

  if (progressHandler) {
    ffmpeg.on("progress", progressHandler);
  }

  const abortHandler = () => {
    ffmpeg.terminate();
    resetFFmpegPromise();
  };

  if (signal) {
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    await Promise.all([
      safeDelete(ffmpeg, "video.mp4"),
      safeDelete(ffmpeg, "audio.m4a"),
      safeDelete(ffmpeg, "out.mp4"),
    ]);

    const [videoBytes, audioBytes] = await Promise.all([
      videoBlob.arrayBuffer(),
      audioBlob.arrayBuffer(),
    ]);
    throwIfAborted(signal);

    await ffmpeg.writeFile("video.mp4", new Uint8Array(videoBytes), { signal });
    await ffmpeg.writeFile("audio.m4a", new Uint8Array(audioBytes), { signal });

    const exitCode = await ffmpeg.exec([
      "-i",
      "video.mp4",
      "-i",
      "audio.m4a",
      "-c",
      "copy",
      "out.mp4",
    ], -1, { signal });

    if (exitCode !== 0) {
      throw new Error(`ffmpeg exited with code ${exitCode}`);
    }

    const output = await ffmpeg.readFile("out.mp4", "binary", { signal });
    return new Blob([output], { type: "video/mp4" });
  } finally {
    await Promise.all([
      safeDelete(ffmpeg, "video.mp4"),
      safeDelete(ffmpeg, "audio.m4a"),
      safeDelete(ffmpeg, "out.mp4"),
    ]);

    if (logHandler) {
      ffmpeg.off("log", logHandler);
    }

    if (progressHandler) {
      ffmpeg.off("progress", progressHandler);
    }

    signal?.removeEventListener("abort", abortHandler);
  }
}
