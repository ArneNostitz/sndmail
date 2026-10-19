#!/usr/bin/env node
/**
 * Per-workspace port allocation for Superset workspaces.
 *
 * Superset does not assign port ranges; it only discovers which ports a
 * workspace listens on. This helper reserves one free dev-server port per
 * workspace in a shared file (~/.superset/port-allocations.json) during setup,
 * hands it to the run script, and releases it on teardown.
 *
 * Usage:
 *   ports.mjs reserve --workspace <path> [--name <name>]   # prints the port
 *   ports.mjs get     --workspace <path>                   # prints the port ("" if none)
 *   ports.mjs release --workspace <path>                   # frees the reservation
 *   ports.mjs list                                         # prints the whole file
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const ALLOC_FILE =
  process.env.SNDMAIL_PORT_ALLOC_FILE ??
  path.join(os.homedir(), ".superset", "port-allocations.json");

const RANGE_START = Number(process.env.SNDMAIL_PORT_RANGE_START ?? 4300);
const RANGE_END = Number(process.env.SNDMAIL_PORT_RANGE_END ?? 4399);

function readAlloc() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ALLOC_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAlloc(alloc) {
  fs.mkdirSync(path.dirname(ALLOC_FILE), { recursive: true });
  fs.writeFileSync(ALLOC_FILE, `${JSON.stringify(alloc, null, 2)}\n`);
}

function isFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function pickPort(alloc) {
  const taken = new Set(Object.values(alloc).map((entry) => entry.port));
  for (let port = RANGE_START; port <= RANGE_END; port++) {
    if (taken.has(port)) continue;
    if (await isFree(port)) return port;
  }
  throw new Error(
    `No free port in range ${RANGE_START}-${RANGE_END}. Free one up or widen SNDMAIL_PORT_RANGE_*`,
  );
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const workspace = args.workspace ? path.resolve(args.workspace) : null;

  if (command === "list") {
    process.stdout.write(`${JSON.stringify(readAlloc(), null, 2)}\n`);
    return;
  }

  if (!workspace) {
    throw new Error("--workspace <path> is required");
  }

  const alloc = readAlloc();

  if (command === "get") {
    const entry = alloc[workspace];
    process.stdout.write(entry ? `${entry.port}\n` : "");
    return;
  }

  if (command === "release") {
    if (alloc[workspace]) {
      delete alloc[workspace];
      writeAlloc(alloc);
      process.stdout.write(`released port for ${workspace}\n`);
    } else {
      process.stdout.write(`no reservation for ${workspace}\n`);
    }
    return;
  }

  if (command === "reserve") {
    const existing = alloc[workspace];
    if (existing && (await isFree(existing.port))) {
      process.stdout.write(`${existing.port}\n`);
      return;
    }
    const port = await pickPort(alloc);
    alloc[workspace] = {
      port,
      name: args.name ?? path.basename(workspace),
      reservedAt: new Date().toISOString(),
    };
    writeAlloc(alloc);
    process.stdout.write(`${port}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command ?? "(none)"}`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
