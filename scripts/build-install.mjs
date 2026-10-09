#!/usr/bin/env node
/**
 * Build the app and put it in /Applications — the one command for local builds.
 *
 *   npm run build:app                # build + install + relaunch
 *   npm run build:app -- --no-pull   # keep the current checkout
 *   npm run build:app -- --no-launch # install without relaunching
 *
 * Steps: pull main → install deps → signed release build (build-signed.mjs)
 * → quit a running sndmail → replace /Applications/sndmail.app → verify →
 * relaunch. The swap is the only step that needs the app down, so a long
 * build never interrupts a running client.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const APP_SRC = join(ROOT, 'src-tauri/target/release/bundle/macos/sndmail.app')
const APP_DEST = '/Applications/sndmail.app'
const BINARY_REL = 'Contents/MacOS/sndmail'

const args = process.argv.slice(2)
const skip = (flag) => args.includes(flag)

const sh = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { encoding: 'utf8' }).trim()

function run(cmd, cmdArgs) {
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: ROOT })
  if (res.status !== 0) {
    console.error(`✗ ${cmd} ${cmdArgs.join(' ')} failed (exit ${res.status ?? 'signal ' + res.signal})`)
    process.exit(res.status ?? 1)
  }
}

const wait = (ms) => spawnSync('sleep', [String(ms / 1000)])

function runningPids() {
  try {
    return sh('pgrep', ['-x', 'sndmail']).split('\n').filter(Boolean)
  } catch {
    return [] // pgrep exits 1 when nothing matches
  }
}

function quitRunningApp() {
  const pids = runningPids()
  if (pids.length === 0) return
  console.log(`→ quitting running sndmail (pid ${pids.join(', ')})`)
  try {
    sh('osascript', ['-e', 'tell application "sndmail" to quit'])
  } catch {
    // not scriptable right now — fall through to signals
  }
  for (let i = 0; i < 20 && runningPids().length > 0; i++) wait(250)
  let left = runningPids()
  if (left.length > 0) {
    for (const pid of left) spawnSync('kill', ['-TERM', pid])
    for (let i = 0; i < 8 && runningPids().length > 0; i++) wait(250)
    left = runningPids()
    for (const pid of left) spawnSync('kill', ['-KILL', pid])
  }
  if (runningPids().length > 0) {
    console.error('✗ could not quit the running sndmail — close it and re-run')
    process.exit(1)
  }
}

// 1. current main, unless the caller is deliberately building another tree
if (skip('--no-pull')) {
  console.log('→ keeping the current checkout (--no-pull)')
} else {
  run('git', ['pull', '--ff-only', 'origin', 'main'])
}

// 2. dependencies, so a fresh clone works and version drift is picked up
if (skip('--no-install')) {
  console.log('→ keeping the current node_modules (--no-install)')
} else {
  run('npm', ['install', '--no-audit', '--no-fund'])
}

// 3. signed release build (reports which signing rung it picked)
run('npm', ['run', 'build:signed'])

if (!existsSync(join(APP_SRC, BINARY_REL))) {
  console.error(`✗ build finished but ${APP_SRC} is missing`)
  process.exit(1)
}

// 4./5. swap the installed app — the only step that needs it down
quitRunningApp()
console.log('→ installing to /Applications')
rmSync(APP_DEST, { recursive: true, force: true })
run('ditto', [APP_SRC, APP_DEST])

// 6. verify: hashes must match and the bundle must carry the version
const hash = (p) => sh('shasum', ['-a', '256', p]).split(/\s+/)[0]
const srcHash = hash(join(APP_SRC, BINARY_REL))
const destHash = hash(join(APP_DEST, BINARY_REL))
if (srcHash !== destHash) {
  console.error(`✗ installed binary differs from the build (${destHash} != ${srcHash})`)
  process.exit(1)
}
const version = sh('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(APP_DEST, 'Contents/Info.plist')])
const fix = sh('plutil', ['-extract', 'CFBundleVersion', 'raw', join(APP_DEST, 'Contents/Info.plist')])
let sha = 'unknown'
try {
  sha = sh('git', ['rev-parse', '--short', 'HEAD'])
} catch {
  // no git — the About panel will still name the commit it was built from
}
console.log(`→ installed ${APP_DEST} — ${version} (${fix}) from ${sha}`)
console.log(`  binary sha256 ${destHash.slice(0, 16)}…`)

// 7. relaunch so the new build is what the user sees next
if (skip('--no-launch')) {
  console.log('→ not relaunching (--no-launch)')
} else {
  run('open', [APP_DEST])
}
