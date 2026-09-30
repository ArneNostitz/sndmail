import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import { access, chmod, copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { provisionTypesense, verifyTypesenseLicense } from "./provision-semantic-search.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = join(root, "src-tauri", "semantic-runtime");
const require = createRequire(join(root, "package.json"));
const args = process.argv.slice(2);
const semanticEnv = (name) => process.env[`SNDMAIL_SEMANTIC_${name}`] ?? process.env[`VELO_SEMANTIC_${name}`];
if (args.some((arg) => !["--strict", "--offline"].includes(arg))) throw new Error("Usage: node scripts/prepare-semantic-search.mjs [--strict] [--offline]");
const strict = args.includes("--strict") || semanticEnv("STRICT") === "1";
const offline = args.includes("--offline") || semanticEnv("OFFLINE") === "1";
const cargoTarget = process.env.CARGO_BUILD_TARGET || "";
const macTarget = cargoTarget ? cargoTarget.endsWith("-apple-darwin") : process.platform === "darwin";
const cargoArch = cargoTarget.startsWith("aarch64-") ? "arm64" : cargoTarget.startsWith("x86_64-") ? "x64" : undefined;
if (macTarget && cargoTarget && !cargoArch) throw new Error("Unsupported macOS CARGO_BUILD_TARGET; prepare a separate arm64 or x86_64 runtime.");
if (cargoTarget && cargoArch && semanticEnv("TARGET_ARCH") && semanticEnv("TARGET_ARCH") !== cargoArch) {
  throw new Error("SNDMAIL_SEMANTIC_TARGET_ARCH conflicts with CARGO_BUILD_TARGET.");
}
const targetArch = cargoArch || semanticEnv("TARGET_ARCH") || process.arch;
if (macTarget && (process.platform !== "darwin" || !["arm64", "x64"].includes(targetArch) || targetArch !== process.arch)) {
  throw new Error("Cross-architecture macOS semantic preparation is not supported; prepare on the matching target architecture.");
}
const results = [];

function report(resource, ready, reason = "") {
  results.push({ resource, ready, reason });
  console.log(`[semantic:prepare] ${resource}: ${ready ? "prepared" : "unavailable"}${reason ? " (" + reason + ")" : ""}`);
}

async function exists(path) { try { await access(path); return true; } catch { return false; } }

async function firstExisting(paths) {
  for (const path of paths.filter(Boolean)) if (await exists(path)) return path;
  return undefined;
}

async function atomicText(name, text) {
  const temporary = join(destination, "." + name + "." + randomUUID());
  try { await writeFile(temporary, text); await rename(temporary, join(destination, name)); }
  finally { await rm(temporary, { force: true }); }
}

async function removeGenerated(name) {
  // Only known generated resources in this repository, never live data or models.
  for (const file of [name, name + ".license.txt", ...(name === "typesense-server" ? ["typesense-server.source.txt"] : [])]) {
    await rm(join(destination, file), { force: true });
  }
}

async function assertPortable(binary) {
  const { stdout: architecture } = await exec("/usr/bin/file", ["-b", binary], { timeout: 10000 });
  const required = targetArch === "arm64" ? "arm64" : "x86_64";
  if (!architecture.includes("Mach-O") || !architecture.includes(required)) throw new Error("binary architecture does not match the selected macOS target");
  const { stdout } = await exec("/usr/bin/otool", ["-L", binary], { timeout: 10000 });
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("\t")) continue;
    const dependency = line.trim().split(" (")[0];
    if (!dependency.startsWith("/usr/lib/") && !dependency.startsWith("/System/Library/")) {
      throw new Error("binary links a non-system library; provision a self-contained build");
    }
  }
}

async function copyExecutable(name, source, licensePath) {
  if (!source) throw new Error("provision the executable locally or set its SNDMAIL_SEMANTIC_*_PATH override");
  if (!licensePath) throw new Error("the executable's actual license text is required; set its SNDMAIL_SEMANTIC_*_LICENSE_PATH override");
  const binary = await realpath(source);
  if (!(await stat(binary)).isFile()) throw new Error("executable source is not a regular file");
  const license = await readFile(licensePath, "utf8");
  if (license.trim().length < 100) throw new Error("the supplied license file does not contain full license text");
  if (name === "typesense-server") await verifyTypesenseLicense(licensePath);
  await assertPortable(binary);
  if (name === "node") {
    const { stdout } = await exec(binary, ["--version"], { timeout: 10000 });
    if (Number(stdout.trim().match(/^v(\d+)/)?.[1] || 0) < 22) throw new Error("the bundled Node runtime must be version 22 or newer");
  }
  const temporary = join(destination, "." + name + "." + randomUUID());
  try {
    await copyFile(binary, temporary);
    await chmod(temporary, 0o755);
    // Signing is optional here; the enclosing application still needs signing
    // and notarization. Do not describe a copied or ad-hoc binary as notarized.
    if (process.env.APPLE_SIGNING_IDENTITY && !offline) {
      await exec("/usr/bin/codesign", ["--force", "--options", "runtime", "--timestamp", "--sign", process.env.APPLE_SIGNING_IDENTITY,
        ...(name === "node" ? ["--entitlements", join(root, "src-tauri", "Entitlements.plist")] : []), temporary], { timeout: 120000 });
    } else if (process.env.APPLE_SIGNING_IDENTITY && offline) {
      console.log("[semantic:prepare] Offline mode skips timestamped executable signing; sign resources during online release preparation.");
    }
    await atomicText(name + ".license.txt", license);
    await rename(temporary, join(destination, name));
  } finally { await rm(temporary, { force: true }); }
}

async function binaryInputs(kind) {
  const variable = kind === "node" ? "NODE" : "TYPESENSE";
  const executable = kind === "node" ? "node" : "typesense-server";
  const explicit = semanticEnv(`${variable}_PATH`);
  const source = explicit || await firstExisting([
    join(destination, executable), ...(kind === "node" ? [process.execPath] : []),
    `/opt/homebrew/bin/${executable}`, `/usr/local/bin/${executable}`,
    `/opt/homebrew/opt/${kind}/bin/${executable}`, `/usr/local/opt/${kind}/bin/${executable}`,
  ]);
  const resolved = source && await exists(source) ? await realpath(source) : undefined;
  const prefix = resolved ? dirname(dirname(resolved)) : "";
  const license = semanticEnv(`${variable}_LICENSE_PATH`) || await firstExisting([
    ...(source === join(destination, executable) ? [join(destination, executable + ".license.txt")] : []),
    ...(prefix ? [join(prefix, "LICENSE"), join(prefix, "LICENSE.txt"), join(prefix, "COPYING"),
      join(prefix, "share", "doc", kind, "LICENSE"), join(prefix, "share", "doc", kind, "LICENSE.txt")] : []),
  ]);
  return { source, license };
}

function loadEsbuild() {
  const modules = semanticEnv("BUILD_NODE_MODULES");
  if (modules) return require(join(resolve(modules), "esbuild"));
  try { return require("esbuild"); }
  catch { return createRequire(require.resolve("vite/package.json"))("esbuild"); }
}

async function dependencyLicenses(inputs) {
  const packages = new Set();
  for (const input of Object.keys(inputs)) {
    const absolute = resolve(root, input);
    const marker = absolute.lastIndexOf("/node_modules/");
    if (marker < 0) continue;
    const suffix = absolute.slice(marker + 14).split("/");
    packages.add(absolute.slice(0, marker + 14) + suffix.slice(0, suffix[0].startsWith("@") ? 2 : 1).join("/"));
  }
  const notices = ["Bundled indexer dependency licenses. Generated from the packages actually included by esbuild."];
  for (const directory of [...packages].sort()) {
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    let licenseDirectory = directory;
    let files = (await readdir(licenseDirectory)).filter((file) => /^(LICENSE|COPYING|NOTICE)([.-].*)?$/i.test(file));
    if (!files.length && manifest.name === "@selderee/plugin-htmlparser2") {
      // This package is published from the Selderee monorepo without its own
      // LICENSE file. Only reuse the installed sibling's text when its pinned
      // version, SPDX declaration, and source repository all match exactly.
      const marker = directory.lastIndexOf("/node_modules/");
      const sibling = join(directory.slice(0, marker + 14), "selderee");
      const siblingManifest = JSON.parse(await readFile(join(sibling, "package.json"), "utf8"));
      const repository = (value) => typeof value === "string" ? value : value?.url;
      if (siblingManifest.version !== manifest.version || siblingManifest.license !== manifest.license ||
          repository(siblingManifest.repository) !== repository(manifest.repository)) {
        throw new Error("the Selderee license fallback does not match the bundled plugin");
      }
      licenseDirectory = sibling;
      files = (await readdir(licenseDirectory)).filter((file) => /^(LICENSE|COPYING|NOTICE)([.-].*)?$/i.test(file));
    }
    if (!files.length) throw new Error("a bundled dependency is missing its license text");
    notices.push(`\n===== ${manifest.name} ${manifest.version} (${manifest.license || "see license"}) =====\n`);
    for (const file of files) {
      if ((await stat(join(licenseDirectory, file))).isFile()) notices.push(await readFile(join(licenseDirectory, file), "utf8"));
    }
  }
  return notices.join("\n");
}

async function prepareWorker() {
  const esbuild = loadEsbuild();
  const output = join(destination, ".indexer." + randomUUID() + ".cjs");
  try {
    const result = await esbuild.build({ absWorkingDir: root, entryPoints: ["scripts/semantic-search/worker.ts"],
      outfile: output, bundle: true, platform: "node", format: "cjs", target: "node22", metafile: true,
      sourcemap: false, minify: false, legalComments: "inline", logLevel: "silent",
      nodePaths: semanticEnv("BUILD_NODE_MODULES") ? [resolve(semanticEnv("BUILD_NODE_MODULES"))] : [],
    });
    const builtins = new Set([...builtinModules, ...builtinModules.map((name) => "node:" + name)]);
    for (const file of Object.values(result.metafile.outputs)) for (const dependency of file.imports) {
      if (dependency.external && !builtins.has(dependency.path)) throw new Error("the worker bundle still has an external non-Node dependency");
    }
    await atomicText("indexer.cjs.license.txt", await dependencyLicenses(result.metafile.inputs));
    await rename(output, join(destination, "indexer.cjs"));
  } finally { await rm(output, { force: true }); }
}

await mkdir(destination, { recursive: true });
const supported = macTarget && process.platform === "darwin" && ["arm64", "x64"].includes(targetArch);
if (!supported) {
  for (const name of ["node", "typesense-server", "indexer.cjs"]) await removeGenerated(name);
  report("runtime", false, "only macOS arm64/x64 resources are prepared by this script");
} else {
  for (const [name, action] of [
    ["indexer.cjs", prepareWorker],
    ["node", async () => { const input = await binaryInputs("node"); await copyExecutable("node", input.source, input.license); }],
    ["typesense-server", async () => {
      const explicitBinary = semanticEnv("TYPESENSE_PATH");
      if (explicitBinary) {
        const expected = semanticEnv("TYPESENSE_SHA256");
        if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) {
          throw new Error("explicit Typesense overrides require SNDMAIL_SEMANTIC_TYPESENSE_SHA256 from verified Typesense 30.2 binary provenance");
        }
        const actual = createHash("sha256").update(await readFile(await realpath(explicitBinary))).digest("hex");
        if (actual !== expected.toLowerCase()) throw new Error("explicit Typesense binary does not match its pinned SHA256");
      }
      const input = semanticEnv("TYPESENSE_PATH")
        ? await binaryInputs("typesense")
        : await provisionTypesense({ root, architecture: targetArch, offline });
      await copyExecutable("typesense-server", input.source, input.license);
      await atomicText("typesense-server.source.txt", input.sourceNotice ||
        "Typesense 30.2; explicitly provisioned executable. Upstream license and supplied binary SHA256 checked without executing the server.\n" +
        "Expected binary SHA256: " + semanticEnv("TYPESENSE_SHA256") + "\n" +
        "Release/version provenance for this checksum was supplied by the release owner, not established by an official archive download.\n" +
        "Upstream corresponding source: https://github.com/typesense/typesense/tree/v30.2\n" +
        "Release owner must supply corresponding source and notices for this exact binary.\n");
    }],
  ]) {
    try { await action(); report(name, true); }
    catch (error) {
      await removeGenerated(name);
      report(name, false, name === "indexer.cjs" ? "worker bundling failed; provision esbuild and html-to-text@10.0.1 with their license files" : error.message);
    }
  }
}

const resources = [];
for (const result of results.filter((item) => item.ready)) {
  const data = await readFile(join(destination, result.resource));
  resources.push({ name: result.resource, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
  const license = await readFile(join(destination, result.resource + ".license.txt"));
  if (license.length < 100) throw new Error("Prepared resource license text is missing or incomplete.");
  resources.push({ name: result.resource + ".license.txt", bytes: license.length, sha256: createHash("sha256").update(license).digest("hex") });
  if (result.resource === "typesense-server") {
    const notice = await readFile(join(destination, "typesense-server.source.txt"));
    resources.push({ name: "typesense-server.source.txt", bytes: notice.length, sha256: createHash("sha256").update(notice).digest("hex") });
  }
}
const ready = supported && results.length === 3 && results.every((item) => item.ready);
await atomicText("runtime-manifest.json", JSON.stringify({ ready, platform: process.platform, architecture: targetArch, cargoTarget, offline,
  signedByPreparation: Boolean(process.env.APPLE_SIGNING_IDENTITY) && !offline && ready,
  preparedAt: new Date().toISOString(), resources, status: results,
  distributionStatus: "Requires enclosing-app signing, license/source review, and release validation.",
  model: { name: "ts/multilingual-e5-small", license: "MIT", bundled: false,
    source: "https://huggingface.co/intfloat/multilingual-e5-small", downloadOwner: "sndmail Settings" },
}, null, 2) + "\n");
if (!ready) {
  console.warn(supported
    ? "[semantic:prepare] Required macOS semantic resources are incomplete. Build failed; provision Node/license and build dependencies, then retry."
    : "[semantic:prepare] Semantic search is explicitly disabled for this unsupported target.");
  if (strict || supported) process.exitCode = 1;
}
