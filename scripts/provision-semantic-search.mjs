import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const VERSION = "30.2";
const ARCHIVES = {
  arm64: { name: "arm64", sha256: "7d8d6d0c33930ad20ea23dd184250547b16615944be891b2078e8a075152fa7e" },
  x64: { name: "amd64", sha256: "6aa4d2d85838e03fdde9dcef4bf1584a46fc1840a215e5cbed288b63365eae75" },
};
const LICENSE_URL = "https://raw.githubusercontent.com/typesense/typesense/v30.2/LICENSE.txt";
// Derived from the coordinator-provided official 30.2 license file.
const LICENSE_SHA256 = "8b1ba204bb69a0ade2bfcf65ef294a920f6bb361b317dba43c7ef29d96332b9b";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function requireDigest(path, expected) {
  if (!(await stat(path)).isFile() || await sha256(path) !== expected) {
    throw new Error("Semantic runtime asset checksum mismatch: " + path);
  }
}

export async function verifyTypesenseLicense(path) {
  await requireDigest(path, LICENSE_SHA256);
}

async function ensureAsset(path, url, expected, offline, maxBytes) {
  try { await requireDigest(path, expected); return; }
  catch (error) {
    if (offline) throw new Error("Offline semantic preparation requires an intact cached asset: " + path);
    if (error.code && error.code !== "ENOENT") throw error;
    // Missing/corrupt cache entries are replaced only by verified bytes.
  }
  const temporary = path + ".partial-" + randomUUID();
  const signal = AbortSignal.timeout(180000);
  try {
    const response = await fetch(url, { redirect: "error", signal });
    if (!response.ok || !response.body) throw new Error("Official semantic asset download failed (HTTP " + response.status + ").");
    if (Number(response.headers.get("content-length") || 0) > maxBytes) {
      await response.body.cancel();
      throw new Error("Official semantic asset exceeds its size limit.");
    }
    let bytes = 0;
    const hash = createHash("sha256");
    const bounded = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) { callback(new Error("Semantic asset exceeded its download size limit.")); return; }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), bounded, createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal });
    if (hash.digest("hex") !== expected) throw new Error("Official semantic asset checksum mismatch; downloaded bytes were not installed.");
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function extractServer(archive, destination, architecture) {
  // The archive hash is checked before even listing its members.
  const { stdout } = await exec("/usr/bin/tar", ["-tzf", archive], { timeout: 30000, maxBuffer: 1024 * 1024 });
  const allowed = new Set(["typesense-server", "./typesense-server",
    "typesense-server-" + VERSION + "-darwin-" + architecture + "/typesense-server",
    "./typesense-server-" + VERSION + "-darwin-" + architecture + "/typesense-server"]);
  const members = stdout.split("\n").filter((name) => allowed.has(name));
  if (members.length !== 1) throw new Error("The verified archive must contain exactly one recognized Typesense executable.");
  const temporary = destination + ".partial-" + randomUUID();
  const signal = AbortSignal.timeout(120000);
  const child = spawn("/usr/bin/tar", ["-xzOf", archive, "--", members[0]], { stdio: ["ignore", "pipe", "pipe"], signal });
  let diagnostic = "";
  child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(0, 4096); });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => status === 0 ? resolve() : reject(new Error("Verified server extraction failed: " + diagnostic)));
  });
  let bytes = 0;
  const bounded = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > MAX_ARCHIVE_BYTES ? new Error("Extracted server exceeded its size limit.") : null, chunk);
    },
  });
  try {
    await Promise.all([completion, pipeline(child.stdout, bounded, createWriteStream(temporary, { flags: "wx", mode: 0o700 }), { signal })]);
    if (!bytes) throw new Error("The verified archive did not yield executable bytes.");
    await chmod(temporary, 0o755);
    await rename(temporary, destination);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await rm(temporary, { force: true });
  }
}

export async function provisionTypesense({ root, architecture, offline = false }) {
  const target = ARCHIVES[architecture];
  if (!target) throw new Error("No pinned Typesense archive is configured for this architecture.");
  const directory = join(root, "node_modules", ".cache", "sndmail-semantic-search", "typesense", VERSION, architecture);
  await mkdir(directory, { recursive: true });
  const archive = join(directory, "typesense-server.tar.gz");
  const binary = join(directory, "typesense-server");
  const license = join(directory, "LICENSE.txt");
  const url = "https://dl.typesense.org/releases/" + VERSION + "/typesense-server-" + VERSION + "-darwin-" + target.name + ".tar.gz";
  await ensureAsset(archive, url, target.sha256, offline, MAX_ARCHIVE_BYTES);
  await ensureAsset(license, LICENSE_URL, LICENSE_SHA256, offline, 1024 * 1024);
  // Always re-extract from a revalidated archive, not a mutable cached binary.
  // tar writes only the selected member to stdout, not archive-selected paths.
  await extractServer(archive, binary, target.name);
  const sourceNotice = [
    "Typesense " + VERSION,
    "Verified official archive: " + url,
    "Archive SHA256: " + target.sha256,
    "Extracted executable SHA256: " + await sha256(binary),
    "License: " + LICENSE_URL,
    "License SHA256: " + LICENSE_SHA256,
    "Corresponding upstream source: https://github.com/typesense/typesense/tree/v" + VERSION,
    "Upstream source archive: https://github.com/typesense/typesense/archive/refs/tags/v" + VERSION + ".tar.gz",
    "Release owner must provide the corresponding source and notices required for the distributed binary.",
    "No model files are provisioned by this helper.",
  ].join("\n") + "\n";
  const notice = join(directory, "SOURCE.txt");
  const temporary = notice + ".partial-" + randomUUID();
  try { await writeFile(temporary, sourceNotice); await rename(temporary, notice); }
  finally { await rm(temporary, { force: true }); }
  return { source: binary, license, sourceNotice };
}
