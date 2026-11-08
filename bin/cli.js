#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverPy = join(__dirname, "..", "server.py");

const child = spawn("python3", [serverPy, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("error", (err) => {
  console.error("Failed to start python process for t3-delete-sessions:", err);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
