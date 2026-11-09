import { nativeEndpoints, deleteNativeEndpoints } from './native.js';
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import readline from "node:readline";
import { resolveT3Cli } from "../bin/platform.js";
import { cleanFamily, cleanOrphans, removeDeletedScratch } from "./cleaner.js";
import { executeStep, planCleanup } from "./family.js";
import {
  defaultCleanupStateDir,
  runDetachedWorker,
  spawnDetachedSelfDelete,
} from "./self-delete.js";
import { normalizeDbPath, sameDbPath, withDatabase } from "./sqlite.js";
import { dispatchT3Commands } from "./ws-rpc.js";

export const SERVER_VERSION = "1.8.0";

export function toolDefinitions() {
  const common = {
    target_host: {
      type: "string",
      description: "Exact hostname returned by inspect_target.",
    },
    db_path: {
      type: "string",
      description: "Absolute database path returned by inspect_target.",
    },
    dry_run: { type: "boolean", default: true },
    offline_confirmed: {
      type: "boolean",
      default: false,
      description:
        "True only for an offline snapshot or a database whose T3 server is stopped.",
    },
  };

  const result = [
    {
      name: "inspect_target",
      description:
        "Show this MCP process's machine, configured database and write mode. Does not delete anything.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ];

  for (const name of [
    "delete_family",
    "delete_subsessions",
    "delete_orphans",
    "archive_family",
    "archive_subsessions",
    "archive_orphans",
  ]) {
    const isOrphans = name.endsWith("_orphans");
    const isFamily = name.endsWith("_family");
    const isArchiveTool = name.startsWith("archive_");
    const properties = { ...common };
    const required = ["target_host", "db_path"];
    if (!isOrphans) {
      properties.thread_id = { type: "string", minLength: 1 };
      required.push("thread_id");
    }
    if (isFamily) {
      properties.keep_parent = { type: "boolean", default: false };
    }
    if (!isArchiveTool) {
      properties.archive_only = { type: "boolean", default: false };
    }
    result.push({
      name,
      description: isArchiveTool
        ? "Preview by default. In online mode, stop and archive selected threads (recoverable) through T3 official commands. Offline mode requires explicit opt-in."
        : "Preview by default. In online mode, stop and delete selected threads through T3 official commands, delete and verify underlying native conversations (Codex/ChatGPT, Claude, Antigravity), and remove exclusive T3 scratch directories while preserving shared folders and external git worktrees.",
      inputSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    });
  }

  for (const [schedName, schedAction, cmdLabel] of [
    ["schedule_delete_family", "delete", "/deletefamily ($deletefamily)"],
    ["schedule_archive_family", "archive", "/archivefamily ($archivefamily)"],
  ]) {
    result.push({
      name: schedName,
      description: `Fast detached self-${schedAction} for ${cmdLabel}. Previews by default; when dry_run=false on a running T3 server, spawns an independent OS-detached worker that waits delay_ms and ${schedAction}s local descendants plus thread_id (keep_parent=false), writing a verified JSON receipt outside the session.`,
      inputSchema: {
        type: "object",
        properties: {
          target_host: common.target_host,
          db_path: common.db_path,
          thread_id: { type: "string", minLength: 1 },
          delay_ms: {
            type: "integer",
            minimum: 200,
            maximum: 30000,
            default: 1500,
          },
          dry_run: { type: "boolean", default: true },
        },
        required: ["target_host", "db_path", "thread_id"],
        additionalProperties: false,
      },
    });
  }

  result.push(
    {
      name: "plan_cross_device_cleanup",
      description:
        "Plan current-thread descendants or ancestor pruning: all remote endpoints must finish before any local step. Supports action='delete' or action='archive'.",
      inputSchema: {
        type: "object",
        properties: {
          registry: { type: "object" },
          anchor_node_id: { type: "string" },
          current_environment_id: { type: "string" },
          current_thread_id: { type: "string" },
          scope: {
            type: "string",
            enum: ["descendants_only", "preserve_current_subtree"],
            default: "descendants_only",
          },
          action: {
            type: "string",
            enum: ["delete", "archive"],
            default: "delete",
          },
        },
        required: [
          "registry",
          "anchor_node_id",
          "current_environment_id",
          "current_thread_id",
        ],
      },
    },
    {
      name: "execute_cleanup_step",
      description:
        "Execute one planned endpoint on its owning machine (delete or archive per plan.action). Remote success receipts are mandatory before local execution. Current coordinator and worker are protected. Defaults to preview.",
      inputSchema: {
        type: "object",
        properties: {
          plan: { type: "object" },
          node_id: { type: "string" },
          receipts: { type: "array", items: { type: "object" } },
          worker_thread_id: { type: "string" },
          dry_run: { type: "boolean", default: true },
        },
        required: ["plan", "node_id", "receipts", "worker_thread_id"],
      },
    }
  );

  result.push({
    name: "delete_native_sessions",
    description:
      "Delete and verify native conversations (and exclusive scratch directories if the T3 thread is already deleted) mapped to one exact T3 thread. Preview by default.",
    inputSchema: {
      type: "object",
      properties: { ...common, thread_id: { type: "string" } },
      required: ["target_host", "db_path", "thread_id"],
      additionalProperties: false,
    },
  });
  return result;
}

export async function callTool(
  name,
  args = {},
  config = {},
  { dispatchFn = dispatchT3Commands, spawnSelfDeleteFn = spawnDetachedSelfDelete } = {}
) {
  if (name === "plan_cross_device_cleanup") {
    return planCleanup(
      args.registry,
      args.anchor_node_id,
      args.current_environment_id,
      args.current_thread_id,
      args.scope ?? "descendants_only",
      args.action ?? "delete"
    );
  }

  const dbConfigPath = config.db ? normalizeDbPath(String(config.db)) : null;
  const allowOfflineWrites = Boolean(
    config.allowOfflineWrites ?? config.allow_offline_writes
  );
  const t3Url = config.t3Url ?? config.t3_url ?? null;
  const t3Cli = config.t3Cli ?? config.t3_cli ?? "t3";

  if (name === "execute_cleanup_step") {
    if (!dbConfigPath || !args?.worker_thread_id) {
      throw new Error("Configured database and exact worker_thread_id required");
    }
    const stepDryRun = args.dry_run === undefined ? true : args.dry_run;
    if (typeof stepDryRun !== "boolean") {
      throw new Error("dry_run must be a boolean");
    }
    return executeStep(
      args.plan,
      args.node_id,
      args.receipts,
      { db: dbConfigPath, t3Url, t3Cli },
      args.worker_thread_id,
      stepDryRun,
      { dispatchFn }
    );
  }

  const target = {
    hostname: os.hostname(),
    db_path: dbConfigPath,
    offline_writes_enabled: allowOfflineWrites,
    t3_url: t3Url,
    native_files: "delete_and_verify_per_endpoint",
    scratch_directories: "remove_exclusive_after_delete",
    worktrees: "preserved",
  };

  if (dbConfigPath) {
    const identityFile = join(dirname(dbConfigPath), "environment-id");
    target.environment_id = existsSync(identityFile)
      ? readFileSync(identityFile, "utf8").trim()
      : null;
  }

  if (name === "inspect_target") {
    return target;
  }

  const definition = toolDefinitions().find((t) => t.name === name);
  if (!definition) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const schema = definition.inputSchema;
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).some((k) => !(k in schema.properties))
  ) {
    throw new Error("Unknown or invalid arguments");
  }

  for (const key of schema.required) {
    if (typeof args[key] !== "string" || !args[key].trim()) {
      throw new Error(`Explicit ${key} is required; no session or machine is inferred`);
    }
  }

  for (const [key, value] of Object.entries(args)) {
    if (schema.properties[key].type === "boolean" && typeof value !== "boolean") {
      throw new Error(`${key} must be a boolean`);
    }
    if (schema.properties[key].type === "integer") {
      if (!Number.isInteger(value) || value < 200 || value > 30000) {
        throw new Error(`${key} must be an integer between 200 and 30000`);
      }
    }
  }

  if (!dbConfigPath) {
    throw new Error(
      "No database configured. Start this server with --db /absolute/path/to/offline.sqlite"
    );
  }

  const suppliedPath = args.db_path;
  if (
    args.target_host !== target.hostname ||
    !isAbsolute(suppliedPath) ||
    !sameDbPath(suppliedPath, dbConfigPath)
  ) {
    throw new Error("Target mismatch: call inspect_target on the intended machine first");
  }

  const dryRun = args.dry_run === undefined ? true : args.dry_run;
  if (name === "delete_native_sessions") {
    const endpoints = nativeEndpoints(dbConfigPath, [args.thread_id]);
    if (dryRun) return { target, status: "preview", endpoints };
    const native = await deleteNativeEndpoints(endpoints, { dbPath: dbConfigPath });
    const scratchDirectories = removeDeletedScratch(dbConfigPath, [args.thread_id]);
    return {
      target,
      status: native.complete ? "completed" : "incomplete_native",
      native,
      scratchDirectories,
    };
  }
  if (name === "schedule_delete_family" || name === "schedule_archive_family") {
    const schedAction = name === "schedule_archive_family" ? "archive" : "delete";
    if (!t3Url) {
      throw new Error(
        `${name} requires a running online T3 server (--t3-url or --auto-local)`
      );
    }
    const preview = cleanFamily(args.thread_id, dbConfigPath, {
      dryRun: true,
      keepParent: false,
      action: schedAction,
    });
    if (!preview.parentSelected) {
      throw new Error(
        `Thread ${args.thread_id} was not found or is already ${schedAction}d`
      );
    }
    const delayMs = args.delay_ms ?? 1500;
    const subDir = schedAction === "archive" ? "self-archive" : "self-delete";
    if (dryRun) {
      return {
        target,
        ...preview,
        delay_ms: delayMs,
        receipt_dir: join(defaultCleanupStateDir(), subDir),
      };
    }
    const scheduled = spawnSelfDeleteFn({
      action: schedAction,
      target_host: args.target_host,
      db_path: dbConfigPath,
      thread_id: args.thread_id,
      delay_ms: delayMs,
      config: { db: dbConfigPath, t3Url, t3Cli },
    });
    return {
      target,
      ...preview,
      status:
        schedAction === "archive"
          ? "scheduled_detached_archive"
          : "scheduled_detached_delete",
      ...scheduled,
    };
  }

  if (
    !dryRun &&
    !t3Url &&
    !(allowOfflineWrites && args.offline_confirmed === true)
  ) {
    throw new Error(
      "Writes require --allow-offline-writes and offline_confirmed=true. Use the official T3 API for a running server."
    );
  }

  const action =
    name.startsWith("archive_") || args.archive_only === true ? "archive" : "delete";
  const isOrphans = name.endsWith("_orphans");
  const isSubsessions = name.endsWith("_subsessions");
  const result = isOrphans
    ? cleanOrphans(dbConfigPath, {
        dryRun: t3Url ? true : dryRun,
        action,
      })
    : cleanFamily(args.thread_id, dbConfigPath, {
        dryRun: t3Url ? true : dryRun,
        keepParent: isSubsessions
          ? true
          : args.keep_parent === undefined
            ? false
            : args.keep_parent,
        action,
      });

  if (t3Url && !dryRun) {
    const items = result.orphans ?? result.children ?? [];
    const ids = items.map((r) => r.threadId);
    if (result.parentSelected) {
      ids.push(args.thread_id);
    }

    const nativePlan = action === "delete" ? nativeEndpoints(dbConfigPath, ids) : [];
    const commands = [];
    for (const tid of ids) {
      commands.push(
        { type: "thread.stop", threadId: tid },
        { type: `thread.${action}`, threadId: tid }
      );
    }

    if (commands.length > 0) {
      try {
        await dispatchFn({
          cli: t3Cli,
          baseDir: dirname(dirname(dbConfigPath)),
          url: t3Url,
          commands,
        });
      } catch (err) {
        throw new Error(
          `T3 command failed; some earlier commands may have completed: ${String(
            err?.message || err
          ).slice(-1500)}`
        );
      }

      const col = action === "archive" ? "archived_at" : "deleted_at";
      withDatabase(dbConfigPath, { readOnly: true }, (db) => {
        const stmt = db.prepare(
          `SELECT ${col} AS state_val FROM orchestration_v2_projection_threads WHERE thread_id = ?`
        );
        for (const tid of ids) {
          const row = stmt.get(tid);
          if (!row || row.state_val == null) {
            throw new Error(`T3 did not confirm the requested state for ${tid}`);
          }
        }
      });
    }

    result.status = "completed_via_t3";
    if (action === "delete") {
      result.native = await deleteNativeEndpoints(nativePlan, {
        dbPath: dbConfigPath,
      });
      result.scratchDirectories = removeDeletedScratch(dbConfigPath, ids);
      result.status = result.native.complete ? "completed" : "incomplete_native";
    }
    result.parentDeleted = Boolean(result.parentSelected) && action === "delete";
    result.parentArchived = Boolean(result.parentSelected) && action === "archive";
    for (const item of items) {
      delete item.dryRun;
    }
  }

  return { target, ...result };
}

export async function handleRpc(config, input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const writeJson = (obj) => {
    output.write(`${JSON.stringify(obj)}\n`);
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch (err) {
      writeJson({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: String(err.message || err) },
      });
      continue;
    }

    if (!req || typeof req !== "object" || !("id" in req)) {
      continue;
    }

    const method = req.method;
    let result;
    if (method === "initialize") {
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "t3-delete-sessions-mcp",
          version: SERVER_VERSION,
        },
      };
    } else if (method === "tools/list") {
      result = { tools: toolDefinitions() };
    } else if (method === "ping") {
      result = {};
    } else if (method === "tools/call") {
      try {
        const params = req.params || {};
        const data = await callTool(params.name, params.arguments || {}, config);
        result = {
          content: [{ type: "text", text: JSON.stringify(data) }],
        };
      } catch (err) {
        result = {
          isError: true,
          content: [{ type: "text", text: String(err.message || err) }],
        };
      }
    } else {
      writeJson({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: "Unknown method" },
      });
      continue;
    }

    writeJson({ jsonrpc: "2.0", id: req.id, result });
  }
}

const HELP_TEXT = `Usage: t3-delete-sessions [options]

MCP session cleanup through a running T3 server or an offline database.
Runs natively in Node.js (node:sqlite) with zero external Python or npm dependencies.

Options:
  --db <path>              Explicit absolute path to the target T3 database
  --allow-offline-writes   Permit writes to an offline database snapshot
  --t3-url <url>           Running T3 URL for official online deletion
  --t3-cli <path>          T3 CLI on this machine (default: "t3")
  --auto-local             Use this host's running T3 runtime metadata; no session ID inference
  --call <tool>            Call one tool and exit
  --arguments-file <file>  JSON tool arguments file, or - for stdin
  -h, --help               Show this help message and exit
`;

export function parseCliArgs(argv, { env = process.env, homedir = os.homedir() } = {}) {
  const config = {
    db: null,
    allowOfflineWrites: false,
    t3Url: null,
    t3Cli: "t3",
    autoLocal: false,
    call: null,
    argumentsFile: null,
    detachedWorker: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      config.help = true;
      return config;
    }
    if (arg === "--allow-offline-writes") {
      config.allowOfflineWrites = true;
    } else if (arg === "--auto-local") {
      config.autoLocal = true;
    } else if (
      arg === "--db" ||
      arg === "--t3-url" ||
      arg === "--t3-cli" ||
      arg === "--call" ||
      arg === "--arguments-file" ||
      arg === "--detached-worker"
    ) {
      if (i + 1 >= argv.length) {
        throw new Error(`Argument ${arg} expected one value`);
      }
      const val = argv[i + 1];
      i += 1;
      if (arg === "--db") config.db = val;
      else if (arg === "--t3-url") config.t3Url = val;
      else if (arg === "--t3-cli") config.t3Cli = val;
      else if (arg === "--call") config.call = val;
      else if (arg === "--arguments-file") config.argumentsFile = val;
      else if (arg === "--detached-worker") config.detachedWorker = val;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (config.autoLocal) {
    if (config.db || config.t3Url) {
      throw new Error("--auto-local cannot be combined with --db or --t3-url");
    }
    const base = normalizeDbPath(env.T3CODE_HOME || join(homedir, ".t3"));
    const runtime = JSON.parse(
      readFileSync(join(base, "userdata", "server-runtime.json"), "utf8")
    );
    config.db = join(base, "userdata", "statev2.sqlite");
    config.t3Url = runtime.origin;
    config.t3Cli = resolveT3Cli(config.t3Cli, { env, homedir });
  }

  if (config.db) {
    if (!isAbsolute(config.db)) {
      throw new Error("--db must be absolute");
    }
    config.db = normalizeDbPath(config.db);
  }

  if (config.call && !config.argumentsFile) {
    throw new Error("--call requires --arguments-file (use - for stdin)");
  }

  return config;
}

export async function runMain(argv = process.argv.slice(2)) {
  let config;
  try {
    config = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }

  if (config.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  if (config.detachedWorker) {
    try {
      await runDetachedWorker(config.detachedWorker, (args, jobConfig, jobAction) =>
        callTool(
          jobAction === "archive" ? "archive_family" : "delete_family",
          args,
          jobConfig
        )
      );
    } catch {
      process.exit(1);
    }
    return;
  }

  if (config.call) {
    let rawArgs;
    try {
      if (config.argumentsFile === "-") {
        let chunks = "";
        for await (const chunk of process.stdin) {
          chunks += chunk;
        }
        rawArgs = JSON.parse(chunks);
      } else {
        rawArgs = JSON.parse(readFileSync(config.argumentsFile, "utf8"));
      }
      const data = await callTool(config.call, rawArgs, config);
      process.stdout.write(`${JSON.stringify(data)}\n`);
    } catch (err) {
      process.stdout.write(
        `${JSON.stringify({ status: "failed", reason: String(err.message || err) })}\n`
      );
      process.exit(1);
    }
    return;
  }

  await handleRpc(config);
}
