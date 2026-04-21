import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateExtension } from "./check-extension.mjs";
import { prepareFfmpegAssets } from "./prepare-ffmpeg.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

export async function buildExtension(projectRoot = rootDir) {
  const sourceDir = path.join(projectRoot, "extension");
  const distRoot = path.join(projectRoot, "dist");
  const outputDir = path.join(distRoot, "drive-video-downloader");

  await prepareFfmpegAssets(projectRoot);
  await validateExtension(sourceDir);

  await rm(outputDir, { force: true, recursive: true });
  await mkdir(distRoot, { recursive: true });
  await cp(sourceDir, outputDir, { recursive: true });

  await validateExtension(outputDir);

  console.log(`Built extension to ${path.relative(projectRoot, outputDir)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  buildExtension().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
