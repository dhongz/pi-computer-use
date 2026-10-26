import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-chrome-release-test-"));
try {
  const binary = path.join(temp, "binary");
  await fs.writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const version = "v0.0.0-test";
  const name = `pi-computer-use-${version}-macos-universal`;
  await run("bash", ["scripts/package-release.sh", version, binary, temp], { cwd: root });
  const archive = path.join(temp, `${name}.tar.gz`);
  const { stdout } = await run("tar", ["-tzf", archive]);
  for (const file of ["scripts/install-chrome.sh", "scripts/chrome-mcp-server.sh", "scripts/chrome-daemon.sh", "scripts/install-pi-extension.sh", "browser/install.mjs", "browser/server.mjs", "browser/daemon.mjs", "extensions/pi-chrome.js", "skills/pi-chrome/SKILL.md", "package.json", "browser/package-lock.json"]) {
    assert.ok(stdout.includes(`${name}/${file}`), `Missing release file: ${file}`);
  }
  assert.ok(!stdout.includes("node_modules/"), "releases must not contain installed dependencies");
  assert.ok(!stdout.includes("/bridge-config.js"), "releases must not contain a local bridge token");
  await fs.mkdir(path.join(temp, "unpacked"));
  await run("tar", ["-xzf", archive, "-C", path.join(temp, "unpacked")]);
  const extracted = path.join(temp, "unpacked", name);
  const help = await run("bash", ["scripts/install-chrome.sh", "--help"], { cwd: extracted, env: { ...process.env, NODE_BIN: process.execPath, NPM_BIN: "/does-not-exist" } });
  assert.ok(help.stdout.includes("Install Pi Chrome Bridge"), "packaged installer must find its browser entry point without installing dependencies for --help");
  const checksum = await fs.readFile(`${archive}.sha256`, "utf8");
  assert.match(checksum, new RegExp(`^[a-f0-9]{64}  ${name.replaceAll(".", "\\.")}\\.tar\\.gz\\n$`));
  await assert.rejects(() => run("bash", ["scripts/package-release.sh", "../bad", binary, temp], { cwd: root }));
  console.log("PASS: release layout, installer entry point, dependency/token exclusion, and version validation");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
