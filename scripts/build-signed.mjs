#!/usr/bin/env node
/**
 * Build the macOS app with the best signing identity this machine has.
 *
 *   source ~/.config/matchmii/apple.env && npm run build:signed
 *
 * Three rungs, in order:
 *
 *   Developer ID Application  — signs *and* notarises. The only combination
 *                               that opens on someone else's Mac without them
 *                               being told the app is damaged.
 *   Apple Development         — a real signature with a stable identity, good
 *                               on this machine. It also gives Little Snitch
 *                               and Keychain a durable app identity across
 *                               rebuilds. Gatekeeper still stops it elsewhere,
 *                               and notarisation refuses it.
 *   ad-hoc ("-")              — what `tauri.conf.json` falls back to. Enough
 *                               for the notification centre to register the
 *                               app, which an unsigned bundle is not.
 *
 * The rung is reported before the build starts, so a release never quietly
 * goes out one step below what was intended.
 *
 * Identities are picked and passed by certificate SHA-1 hash, never by name:
 * two certificates can share one common name (a renewal and the original live
 * side by side), and `codesign --sign <name>` fails with "ambiguous" then.
 * The hash selects exactly one certificate. The first match wins, so when a
 * short-lived certificate expires the next one in the list takes over.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' })

function identities() {
  // Every keychain in the search list, so the one `macos-signing.mjs` makes
  // counts without having to name it here
  try {
    return sh('security', ['find-identity', '-v', '-p', 'codesigning'])
  } catch {
    return ''
  }
}

const found = identities()
// Each identity line is: `  N) <40-hex SHA-1> "<common name>"`. Return both:
// the hash signs, the name is only for the report.
const pick = (needle) => {
  const m = found.split('\n').find((l) => l.includes(needle))?.match(/([0-9A-F]{40})\s+"(.+)"/)
  return m ? { hash: m[1], name: m[2] } : undefined
}

const developerId = pick('Developer ID Application')
const development = pick('Apple Development')

const env = { ...process.env }
let rung

if (developerId) {
  rung = `Developer ID — ${developerId.name} [${developerId.hash.slice(0, 8)}]`
  env.APPLE_SIGNING_IDENTITY = developerId.hash

  // Notarisation credentials, named the way the Tauri bundler expects them.
  // The App Store Connect key doubles as the notarytool key.
  const keyPath = process.env.ASC_KEY_PATH?.replace('$HOME', homedir())
  if (keyPath && existsSync(keyPath) && process.env.ASC_KEY_ID && process.env.ASC_ISSUER_ID) {
    env.APPLE_API_KEY = process.env.ASC_KEY_ID
    env.APPLE_API_ISSUER = process.env.ASC_ISSUER_ID
    env.APPLE_API_KEY_PATH = keyPath
    rung += ' + notarisation'
  } else {
    rung += ' (not notarised — source ~/.config/matchmii/apple.env for that)'
  }
} else if (development) {
  rung = `Apple Development — ${development.name} [${development.hash.slice(0, 8)}]`
  env.APPLE_SIGNING_IDENTITY = development.hash
} else {
  rung = 'ad-hoc — no signing identity on this machine'
  console.log('  run `node scripts/macos-signing.mjs` to set up a Developer ID')
}

console.log(`→ signing: ${rung}\n`)

// The identity has to reach the bundler through the config as well: an
// `APPLE_SIGNING_IDENTITY` in the environment does not override a
// `signingIdentity` already written there, and the config's is "-".
const args = ['run', 'tauri', 'build']
if (env.APPLE_SIGNING_IDENTITY) {
  args.push('--', '--config', JSON.stringify({
    bundle: { macOS: { signingIdentity: env.APPLE_SIGNING_IDENTITY } },
  }))
}

const result = spawnSync('npm', args, { stdio: 'inherit', env })
process.exit(result.status ?? 1)
