#!/usr/bin/env node
// Build the small native mail helper before Tauri assembles the app bundle.
// A universal macOS build needs a universal helper too; lipo joins the two
// target binaries after Cargo has compiled each architecture.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = join(root, 'src-tauri', 'Cargo.toml')
const outputDir = join(root, 'src-tauri', 'binaries')
const output = join(outputDir, process.platform === 'win32' ? 'sndmail-worker.exe' : 'sndmail-worker')
const helperApp = join(outputDir, 'SndmailWorker.app')
const targets = execFileSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)
const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1]
const explicitTarget = process.env.SNDMAIL_WORKER_TARGET || process.env.CARGO_BUILD_TARGET ||
  process.env.TAURI_ENV_TARGET_TRIPLE
const requested = explicitTarget || host
if (!requested) throw new Error('Cannot determine the worker build target')

function build(target) {
  const args = ['build', '--release', '--manifest-path', manifest, '--bin', 'sndmail-worker']
  // Tauri sets TAURI_ENV_TARGET_TRIPLE even for a normal host build. Reuse
  // Cargo's host layout so helper and app share dependencies and disk space.
  const useHostLayout = target === host
  if (!useHostLayout) args.push('--target', target)
  execFileSync('cargo', args, { stdio: 'inherit' })
  return join(root, 'src-tauri', 'target', ...(useHostLayout ? [] : [target]), 'release', process.platform === 'win32' ? 'sndmail-worker.exe' : 'sndmail-worker')
}

mkdirSync(outputDir, { recursive: true })
if (requested === 'universal-apple-darwin') {
  if (!targets.includes('aarch64-apple-darwin') || !targets.includes('x86_64-apple-darwin')) {
    throw new Error('A universal mail worker requires both macOS Rust targets')
  }
  const arm = build('aarch64-apple-darwin')
  const intel = build('x86_64-apple-darwin')
  execFileSync('lipo', ['-create', '-output', output, arm, intel], { stdio: 'inherit' })
} else {
  if (!targets.includes(requested)) throw new Error(`Rust target ${requested} is not installed`)
  copyFileSync(build(requested), output)
}

if (!existsSync(output)) throw new Error(`Mail worker build produced no binary at ${output}`)
if (process.platform === 'darwin') {
  const helperContents = join(helperApp, 'Contents')
  const helperMacOS = join(helperContents, 'MacOS')
  rmSync(helperApp, { recursive: true, force: true })
  mkdirSync(helperMacOS, { recursive: true })
  copyFileSync(output, join(helperMacOS, 'sndmail-worker'))
  writeFileSync(join(helperContents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>sndmail-worker</string>
  <key>CFBundleIdentifier</key><string>com.anydaysomething.sndmail.worker</string>
  <key>CFBundleName</key><string>SndmailWorker</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`)
  const identity = process.env.APPLE_SIGNING_IDENTITY || '-'
  const args = ['--force', '--identifier', 'com.anydaysomething.sndmail.worker', '--sign', identity]
  if (identity !== '-') args.push('--options', 'runtime')
  args.push(helperApp)
  execFileSync('codesign', args, { stdio: 'inherit' })
}
console.log(`Prepared native mail worker: ${process.platform === 'darwin' ? helperApp : output}`)
