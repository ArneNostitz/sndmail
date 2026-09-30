#!/usr/bin/env node
/**
 * The Developer ID identity sndmail is signed with, made without Xcode.
 *
 * A Mac app distributed outside the App Store needs a *Developer ID
 * Application* certificate — it is the only kind Gatekeeper accepts from a
 * download, and the only kind notarisation will take. Xcode's automatic
 * signing will not create one, so the pieces are made directly through the
 * App Store Connect API instead.
 *
 *   source ~/.config/matchmii/apple.env && node scripts/macos-signing.mjs
 *
 * Idempotent: a second run finds the certificate the first one made and
 * changes nothing. The private key never leaves this machine — the API only
 * ever sees the CSR — and key, certificate and keychain live in
 * ~/.config/sndmail/signing/.
 *
 * Adapted from matchmii's scripts/ios-signing.mjs, which does the same for an
 * iOS distribution certificate.
 */
import { execFileSync } from 'node:child_process'
import { createSign } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CERT_TYPE = 'DEVELOPER_ID_APPLICATION'
const SUBJECT = '/CN=sndmail Developer ID/O=anydaysomething/C=AT'

const DIR = join(homedir(), '.config/sndmail/signing')
const KEY = join(DIR, 'developer-id.key')
const CSR = join(DIR, 'developer-id.csr')
const CER = join(DIR, 'developer-id.cer')
const PEM = join(DIR, 'developer-id.pem')
const P12 = join(DIR, 'developer-id.p12')
const KEYCHAIN = join(DIR, 'sndmail-signing.keychain-db')
const KEYCHAIN_PASSWORD = 'sndmail-signing'

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts })

// ── App Store Connect ────────────────────────────────────────────────────────

const keyPath = process.env.ASC_KEY_PATH?.replace('$HOME', homedir())
for (const [name, value] of Object.entries({
  ASC_KEY_ID: process.env.ASC_KEY_ID,
  ASC_ISSUER_ID: process.env.ASC_ISSUER_ID,
  ASC_KEY_PATH: keyPath,
})) {
  if (!value) {
    console.error(`✗ ${name} is not set — source ~/.config/matchmii/apple.env first`)
    process.exit(1)
  }
}
const authKey = readFileSync(keyPath, 'utf8')

function jwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' })}.${b64({
    iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1',
  })}`
  const sig = createSign('SHA256').update(unsigned).sign({ key: authKey, dsaEncoding: 'ieee-p1363' })
  return `${unsigned}.${sig.toString('base64url')}`
}

async function api(path, init = {}) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${jwt()}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : {}
  if (!res.ok) {
    const detail = json.errors?.map((e) => e.detail ?? e.title).join('; ') ?? JSON.stringify(json)
    throw Object.assign(new Error(`${res.status} ${path}: ${detail.slice(0, 400)}`), { status: res.status })
  }
  return json
}

// ── 1. The certificate ───────────────────────────────────────────────────────

mkdirSync(DIR, { recursive: true, mode: 0o700 })

const certs = await api(`/v1/certificates?filter[certificateType]=${CERT_TYPE}&limit=200`)
let cert = certs.data[0]

// A certificate downloaded by hand is already on disk before the account query
// can see it as ours, so an existing .cer with its key beside it wins outright
if (!cert && existsSync(CER) && existsSync(KEY)) {
  console.log(`→ found a certificate at ${CER}`)
}

// A certificate is worthless without the private key that requested it, and
// Apple will not hand that back — so a certificate on the account with no key
// here is a dead end that has to be revoked deliberately, not worked around.
if (cert && !existsSync(KEY)) {
  console.error(`✗ a ${CERT_TYPE} certificate exists (${cert.id}, ${cert.attributes.displayName})`)
  console.error(`  but its private key is not at ${KEY}`)
  console.error('  copy the key here, or revoke the certificate in App Store Connect and run again')
  process.exit(1)
}

if (!cert && !existsSync(CER)) {
  // The key and the CSR are made here either way: whoever ends up submitting
  // the request has to submit *this* CSR, or the certificate that comes back
  // cannot be used on this machine.
  if (!existsSync(KEY)) sh('openssl', ['genrsa', '-out', KEY, '2048'], { stdio: 'ignore' })
  if (!existsSync(CSR)) writeFileSync(CSR, sh('openssl', ['req', '-new', '-key', KEY, '-subj', SUBJECT]))

  try {
    console.log('→ requesting a Developer ID Application certificate')
    const created = await api('/v1/certificates', {
      method: 'POST',
      body: JSON.stringify({
        data: { type: 'certificates', attributes: { certificateType: CERT_TYPE, csrContent: readFileSync(CSR, 'utf8') } },
      }),
    })
    cert = created.data
  } catch (err) {
    // Apple lets an API key create development and distribution certificates,
    // but not this one: "This operation can only be performed by the Account
    // Holder", whatever role the key has. It is a rule about who may vouch for
    // software shipped outside the App Store, so it can only be done signed in
    // as the account holder, in a browser. Everything up to that point is done
    // here, and everything after it resumes on the next run.
    if (err.status !== 403) throw err
    console.log('\n  Apple will not issue this one to an API key:')
    console.log(`  ${err.message.replace(/^403 [^:]+: /, '')}\n`)
    console.log('  One step in a browser, as the account holder:')
    console.log('   1. https://developer.apple.com/account/resources/certificates/add')
    console.log('   2. pick "Developer ID Application", then "Manually create a certificate"')
    console.log(`   3. upload ${CSR}`)
    console.log(`   4. download the .cer and save it as ${CER}`)
    console.log('   5. run this script again — it does the rest\n')
    process.exit(2)
  }
}

if (cert) {
  writeFileSync(CER, Buffer.from(cert.attributes.certificateContent, 'base64'))
  console.log(`→ certificate ${cert.id} (${cert.attributes.displayName}) valid to ${cert.attributes.expirationDate.slice(0, 10)}`)
} else {
  console.log(`→ using the certificate at ${CER}`)
}

// ── 2. Its own keychain ──────────────────────────────────────────────────────
//
// Not the login keychain: this password is known, so codesign never stops to
// ask for the user's during a build nobody is watching.

sh('openssl', ['x509', '-inform', 'DER', '-in', CER, '-out', PEM])
// OpenSSL 3 defaults to AES-256 with a SHA-256 MAC, which macOS `security`
// refuses to read ("MAC verification failed"). The old algorithms are what the
// keychain understands, and the file lives for exactly one import.
sh('openssl', ['pkcs12', '-export', '-inkey', KEY, '-in', PEM, '-out', P12,
  '-passout', `pass:${KEYCHAIN_PASSWORD}`, '-name', 'sndmail Developer ID',
  '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'])

if (!existsSync(KEYCHAIN)) {
  sh('security', ['create-keychain', '-p', KEYCHAIN_PASSWORD, KEYCHAIN])
  console.log('→ created the signing keychain')
}
// Unlock before setting anything: `set-keychain-settings` on a locked keychain
// asks for the password through the window server, which during an unattended
// build is a cancelled dialog and a dead release.
sh('security', ['unlock-keychain', '-p', KEYCHAIN_PASSWORD, KEYCHAIN])
sh('security', ['set-keychain-settings', KEYCHAIN]) // no auto-lock timeout

const search = sh('security', ['list-keychains', '-d', 'user'])
  .split('\n').map((l) => l.trim().replace(/"/g, '')).filter(Boolean)
if (!search.includes(KEYCHAIN)) {
  sh('security', ['list-keychains', '-d', 'user', '-s', ...search, KEYCHAIN])
  console.log('→ added it to the search list')
}

const identities = sh('security', ['find-identity', '-v', '-p', 'codesigning', KEYCHAIN])
if (!identities.includes('Developer ID Application')) {
  sh('security', ['import', P12, '-k', KEYCHAIN, '-P', KEYCHAIN_PASSWORD, '-A',
    '-T', '/usr/bin/codesign', '-T', '/usr/bin/security'])
  sh('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s',
    '-k', KEYCHAIN_PASSWORD, KEYCHAIN], { stdio: 'ignore' })
  console.log('→ imported the identity')
} else {
  console.log('· identity already in the keychain')
}

// ── 3. What to build with ────────────────────────────────────────────────────

const line = sh('security', ['find-identity', '-v', '-p', 'codesigning', KEYCHAIN])
  .split('\n').find((l) => l.includes('Developer ID Application'))
const name = line?.match(/"(.+)"/)?.[1]
if (!name) {
  console.error('✗ the identity is not in the keychain after importing it')
  process.exit(1)
}

console.log(`\n✓ ${name}`)
console.log('  npm run build:signed  — signs and notarises with it')
