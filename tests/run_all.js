import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePython } from "../bin/platform.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const nodeTests = spawnSync(
  process.execPath,
  ["--test", join(__dirname, "test_platform.mjs")],
  { cwd: rootDir, stdio: "inherit" }
);
if (nodeTests.status !== 0) {
  process.exit(nodeTests.status ?? 1);
}

const python = resolvePython();
const pyTests = spawnSync(
  python.command,
  [...python.prefixArgs, "-m", "unittest", "discover", "-s", "tests", "-v"],
  { cwd: rootDir, env: python.env, stdio: "inherit" }
);
process.exit(pyTests.status ?? 0);
