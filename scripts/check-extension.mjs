import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRootDir = path.resolve(__dirname, "..");

export const builtFfmpegFiles = [
  "classes.js",
  "const.js",
  "errors.js",
  "index.js",
  "types.js",
  "utils.js",
  "worker.js",
  "ffmpeg-core.js",
  "ffmpeg-core.wasm",
];

async function assertExists(baseDir, relativePath) {
  const absolutePath = path.join(baseDir, relativePath);
  await access(absolutePath);
}

export async function validateExtension(extensionDir = path.join(defaultRootDir, "extension")) {
  const manifestPath = path.join(extensionDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  const requiredFiles = [
    manifest.background.service_worker,
    "popup.js",
    "downloader.js",
    "merger.js",
    manifest.declarative_net_request.rule_resources[0].path,
    manifest.side_panel?.default_path,
    ...builtFfmpegFiles.map((fileName) => path.join("ffmpeg", fileName)),
  ].filter(Boolean);

  for (const filePath of requiredFiles) {
    await assertExists(extensionDir, filePath);
  }

  console.log(
    `Validated ${manifest.name} ${manifest.version} with ${requiredFiles.length} required files.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  validateExtension().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
