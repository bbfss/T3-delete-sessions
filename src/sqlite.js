import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const origEmitWarning = process.emitWarning;
process.emitWarning = function suppressSqliteExperimentalWarning(warning, ...args) {
  const msg = typeof warning === "string" ? warning : warning?.message || "";
  if (msg.includes("SQLite is an experimental feature")) {
    return;
  }
  return origEmitWarning.apply(this, [warning, ...args]);
};

const { DatabaseSync } = await import("node:sqlite");

export function normalizeDbPath(filePath) {
  const resolved = resolve(filePath);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function sameDbPath(pathA, pathB, platform = process.platform) {
  const normA = normalizeDbPath(pathA);
  const normB = normalizeDbPath(pathB);
  return platform === "win32"
    ? normA.toLowerCase() === normB.toLowerCase()
    : normA === normB;
}

export function openDatabase(dbPath, { readOnly = false } = {}) {
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly });
  if (!readOnly) {
    db.exec("PRAGMA busy_timeout = 5000");
  }
  return db;
}

export function withDatabase(dbPath, options, fn) {
  const db = openDatabase(dbPath, options);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function withTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore secondary rollback errors.
    }
    throw err;
  }
}
