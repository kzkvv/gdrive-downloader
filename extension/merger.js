import { FFmpeg } from "./ffmpeg/index.js";

let ffmpegPromise;

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
    ffmpegPromise = loadFFmpeg();
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

export async function mergeAV(videoBlob, audioBlob, { onLog, onProgress } = {}) {
  const ffmpeg = await getFFmpeg();

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

    await ffmpeg.writeFile("video.mp4", new Uint8Array(videoBytes));
    await ffmpeg.writeFile("audio.m4a", new Uint8Array(audioBytes));

    const exitCode = await ffmpeg.exec([
      "-i",
      "video.mp4",
      "-i",
      "audio.m4a",
      "-c",
      "copy",
      "out.mp4",
    ]);

    if (exitCode !== 0) {
      throw new Error(`ffmpeg exited with code ${exitCode}`);
    }

    const output = await ffmpeg.readFile("out.mp4");
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
  }
}
