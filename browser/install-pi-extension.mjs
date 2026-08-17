#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpConfig = process.env.PI_MCP_CONFIG || path.join(os.homedir(), ".pi", "agent", "mcp.json");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function disablePiChromeMcp() {
  let config;
  try {
    config = JSON.parse(await fs.readFile(mcpConfig, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  const server = config.mcpServers?.["pi-chrome"];
  if (!server) return false;
  if (server.disabled === true) return true;
  server.disabled = true;
  await fs.writeFile(mcpConfig, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(mcpConfig, 0o600).catch(() => {});
  return true;
}

if (!process.env.PI_SKIP_PACKAGE_INSTALL) {
  const pi = process.env.PI_BIN || "pi";
  await run(pi, ["install", root]);
}
const disabled = await disablePiChromeMcp();
console.log("Pi Chrome extension adapter installed.");
console.log("Restart Pi or run /reload so the direct pi_chrome_* tools are registered.");
if (disabled) console.log("Disabled the standalone pi-chrome MCP tools in Pi config; all Pi sessions now share the daemon.");
