#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceExtension = path.join(root, "browser", "extension");
const defaultAgentDir = path.join(os.homedir(), ".pi", "agent");
const defaultExtensionDir = path.join(defaultAgentDir, "chrome-extension");
const defaultTokenFile = path.join(defaultAgentDir, "chrome-bridge-token");
const defaultMcpConfig = path.join(defaultAgentDir, "mcp.json");
const defaultPort = 37842;

function parseArgs(argv) {
  const options = { configurePi: true, openExtensions: false, port: defaultPort };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-configure-pi") options.configurePi = false;
    else if (arg === "--open-extensions") options.openExtensions = true;
    else if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--extension-dir") options.extensionDir = path.resolve(argv[++i]);
    else if (arg === "--token-file") options.tokenFile = path.resolve(argv[++i]);
    else if (arg === "--mcp-config") options.mcpConfig = path.resolve(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log(`Install Pi Chrome Bridge.\n\nOptions:\n  --no-configure-pi       Do not update ~/.pi/agent/mcp.json\n  --open-extensions        Open chrome://extensions after staging\n  --port <n>               Local bridge port (default ${defaultPort})\n  --extension-dir <path>   Extension install directory\n  --token-file <path>      Bridge token file\n  --mcp-config <path>      Pi MCP config path\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error("--port must be an integer between 1024 and 65535");
  options.extensionDir ??= defaultExtensionDir;
  options.tokenFile ??= defaultTokenFile;
  options.mcpConfig ??= defaultMcpConfig;
  return options;
}

async function rejectSymlink(file, label) {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${file}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function tokenAt(file) {
  await rejectSymlink(file, "token file");
  try {
    const value = (await fs.readFile(file, "utf8")).trim();
    if (value.length >= 32) return value;
  } catch {
    // Generate below.
  }
  const value = crypto.randomBytes(32).toString("hex");
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${value}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
  return value;
}

async function stageExtension(extensionDir, port, token) {
  await rejectSymlink(extensionDir, "extension directory");
  await fs.mkdir(extensionDir, { recursive: true, mode: 0o700 });
  await fs.chmod(extensionDir, 0o700).catch(() => {});
  for (const name of ["manifest.json", "background.js"]) {
    await fs.copyFile(path.join(sourceExtension, name), path.join(extensionDir, name));
  }
  const configPath = path.join(extensionDir, "bridge-config.js");
  await fs.writeFile(configPath, `globalThis.PI_CHROME_CONFIG = ${JSON.stringify({ port, token }, null, 2)};\n`, { mode: 0o600 });
  await fs.chmod(configPath, 0o600).catch(() => {});
  return extensionDir;
}

async function configurePi(mcpConfig, command, options) {
  await rejectSymlink(mcpConfig, "Pi MCP config");
  let config = {};
  try {
    config = JSON.parse(await fs.readFile(mcpConfig, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  config.mcpServers ??= {};
  const previous = config.mcpServers["pi-chrome"] ?? {};
  config.mcpServers["pi-chrome"] = {
    ...previous,
    command,
    args: [],
    cwd: root,
    env: {
      ...(previous.env ?? {}),
      PI_CHROME_PORT: String(options.port),
      PI_CHROME_TOKEN_FILE: options.tokenFile,
    },
    lifecycle: "lazy-keep-alive",
    directTools: true,
  };
  await fs.mkdir(path.dirname(mcpConfig), { recursive: true });
  await fs.writeFile(mcpConfig, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(mcpConfig, 0o600).catch(() => {});
}

async function openExtensionsPage() {
  await new Promise((resolve, reject) => {
    const child = spawn("open", ["-a", "Google Chrome", "chrome://extensions/"], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

const options = parseArgs(process.argv.slice(2));
const token = await tokenAt(options.tokenFile);
const extensionDir = await stageExtension(options.extensionDir, options.port, token);
const command = path.join(root, "scripts", "chrome-mcp-server.sh");
if (options.configurePi) await configurePi(options.mcpConfig, command, options);
if (options.openExtensions) await openExtensionsPage();

console.log("Pi Chrome Bridge staged.");
console.log(`Extension directory: ${extensionDir}`);
console.log("In Chrome, open chrome://extensions, enable Developer mode, choose Load unpacked, and select that directory.");
console.log(`MCP server: ${command}`);
if (options.configurePi) console.log(`Updated Pi MCP config: ${options.mcpConfig}`);
console.log("After loading the extension, reload Pi's MCP servers (or restart Pi).");
