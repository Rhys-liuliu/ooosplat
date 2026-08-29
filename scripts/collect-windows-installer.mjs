import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8"));
const version = packageMetadata.version;
const architecture = { x64: "x64", arm64: "arm64" }[process.arch];

if (process.platform !== "win32") {
  throw new Error(`Windows installer collection must run on Windows, not ${process.platform}.`);
}

if (!version || typeof version !== "string") {
  throw new Error("package.json does not contain a valid version.");
}

if (!architecture) {
  throw new Error(`Unsupported Windows architecture: ${process.arch}`);
}

const bundleDirectory = path.join(workspace, "src-tauri", "target", "release", "bundle", "nsis");
const candidates = (await readdir(bundleDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".exe") && entry.name.includes(version))
  .map((entry) => path.join(bundleDirectory, entry.name));

if (candidates.length === 0) {
  throw new Error(`No Windows NSIS installer for version ${version} was found in ${bundleDirectory}.`);
}

const installers = await Promise.all(
  candidates.map(async (candidate) => ({ path: candidate, modifiedAt: (await stat(candidate)).mtimeMs })),
);
installers.sort((left, right) => right.modifiedAt - left.modifiedAt);

const artifactDirectory = path.join(workspace, "dist-artifacts");
const artifactName = `OOOSplat-${version}-${architecture}-windows.exe`;
const artifactPath = path.join(artifactDirectory, artifactName);

await mkdir(artifactDirectory, { recursive: true });
await copyFile(installers[0].path, artifactPath);

const hash = createHash("sha256");
for await (const chunk of createReadStream(artifactPath)) {
  hash.update(chunk);
}
await writeFile(
  path.join(artifactDirectory, "SHA256SUMS.txt"),
  `${hash.digest("hex")}  ${artifactName}\n`,
  "utf8",
);

console.log(`Windows installer: ${artifactPath}`);
