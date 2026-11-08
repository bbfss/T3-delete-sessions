#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolvePython } from "./platform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverPy = join(__dirname, "..", "server.py");

let python;
try {
  python = resolvePython();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const child = spawn(
  python.command,
  [...python.prefixArgs, serverPy, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: python.env,
    windowsHide: true,
  }
);

child.on("error", (err) => {
  console.error("Failed to start python process for t3-delete-sessions:", err);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
