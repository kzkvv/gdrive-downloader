import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRootDir = path.resolve(__dirname, "..");

export const ffmpegFiles = [
  "classes.js",
  "const.js",
  "errors.js",
  "index.js",
  "types.js",
  "utils.js",
  "worker.js",
];

export const coreFiles = [
  "ffmpeg-core.js",
  "ffmpeg-core.wasm",
];

async function copyGroup(sourceDir, files, targetDir, rootDir) {
  for (const fileName of files) {
    const sourcePath = path.join(sourceDir, fileName);
    const targetPath = path.join(targetDir, fileName);
    await copyFile(sourcePath, targetPath);
    console.log(`copied ${path.relative(rootDir, targetPath)}`);
  }
}

export async function prepareFfmpegAssets(rootDir = defaultRootDir) {
  const ffmpegDir = path.join(rootDir, "node_modules", "@ffmpeg", "ffmpeg", "dist", "esm");
  const coreDir = path.join(rootDir, "node_modules", "@ffmpeg", "core", "dist", "esm");
  const targetDir = path.join(rootDir, "extension", "ffmpeg");

  await rm(targetDir, { force: true, recursive: true });
  await mkdir(targetDir, { recursive: true });

  await copyGroup(ffmpegDir, ffmpegFiles, targetDir, rootDir);
  await copyGroup(coreDir, coreFiles, targetDir, rootDir);

  console.log(`ffmpeg assets prepared in ${path.relative(rootDir, targetDir)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  prepareFfmpegAssets().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
