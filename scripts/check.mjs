#!/usr/bin/env node
// scripts/check.mjs — everything CI enforces, runnable in one command on a laptop.
//
// WHY this exists instead of a linter: style is not what would hurt this repo. Five things
// would, and each one is silent until it is expensive:
//
//   1. A SYNTAX ERROR reaching the container. There is no test suite and no framework to catch
//      it; the first sign would be a crash-looping deploy.
//   2. A CREDENTIAL landing in a repo that publicly promises it has none. This service is
//      ungated and anonymous by design (docs/decisions/0003-no-secrets.md); the day a key
//      appears here, that claim silently stops being true.
//   3. A SOURCE MODULE missing a field. `/api` describes itself from the registry, so a source
//      without `label`, or an operation without `summary`/`ttlMs`, does not throw — it just
//      renders as a blank row in the public API listing.
//   4. AN UPSTREAM HOSTNAME reaching the browser bundle. The whole reason upstream calls happen
//      server-side is that `connect-src 'self'` means the browser may talk to this origin and
//      nothing else. One absolute URL in a page module and the promise is gone, without any
//      error to notice.
//   5. A DOCUMENT the markdown renderer would mangle. `docs/` is rendered to static HTML at
//      build time and published at /knowledge/, so a construct the renderer does not support
//      does not fail — it renders as literal asterisks on a public page, and a link to a file
//      that was renamed renders as plain text that reads like prose.
//   6. SOMEBODY'S LAPTOP in the repository. A drive letter or a home directory says who wrote
//      the line and how their machine is laid out, and it is meaningless to every other reader.
//      In a script it is worse than a disclosure: it is a default that works for exactly one
//      person, so the command runs on one machine and fails everywhere else with a path nobody
//      recognises. That is how `npm run data:netflows` came to be unreproducible.
//
// Dependency-free on purpose. `vite` is this repo's only dependency and it is a devDependency;
// a verification script that needed its own toolchain would be the first crack in that.
//
// Usage:
//   node scripts/check.mjs                    run everything
//   node scripts/check.mjs --only=secrets     run one group (syntax|secrets|registry|urls|docs|paths)
//   node scripts/check.mjs --list             show the group names and exit

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, dirname, extname, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The same modules the build uses. Not a second implementation of the rules: what this check
// validates is literally what scripts/knowledge-plugin.mjs will emit.
import { UNSUPPORTED } from './markdown.mjs'
import { DOCS_DIR, PUBLISHED_SECTIONS, SECTIONS, collectDocuments } from './knowledge.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ------------------------------------------------------------------------- plumbing ---- */

// Colour only when it will not end up as literal escape bytes in a log file. GitHub Actions
// renders ANSI, so the check is NO_COLOR rather than isTTY.
const colour = !process.env.NO_COLOR
const green = (s) => (colour ? `\u001b[32m${s}\u001b[0m` : s)
const red = (s) => (colour ? `\u001b[31m${s}\u001b[0m` : s)
const yellow = (s) => (colour ? `\u001b[33m${s}\u001b[0m` : s)
const dim = (s) => (colour ? `\u001b[2m${s}\u001b[0m` : s)

/** Every failure collected here; nothing exits early, so one run reports every problem. */
const failures = []
/** Things a human should see but that are not a reason to fail the build. */
const notes = []

const fail = (group, message, hint) => failures.push({ group, message, hint })
const note = (message) => notes.push(message)

/** Repo-relative, forward-slashed — so messages are copy-pasteable on Windows too. */
const rel = (abs) => relative(ROOT, abs).split(sep).join('/')

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vite', '.cache'])

/**
 * Depth-first file walk. Returns absolute paths. Missing directories are simply empty.
 *
 * Dotfiles are deliberately INCLUDED. Skipping them would be the obvious thing to do and
 * exactly wrong for the secret scan: `.env` and `.npmrc` are where a credential actually ends
 * up. Only the directories above are pruned, and each for a concrete reason (huge, generated,
 * or git's own object store).
 */
function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out // directory does not exist yet (e.g. src/data before the first dataset build)
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

/* ------------------------------------------------------------- group 1: syntax check ---- */

/**
 * `node --check` parses without executing. That matters: these modules open sockets and read
 * files at import time in some cases, and a check that ran them would be a check that needs
 * the network.
 *
 * Node 22 resolves the module goal for a `.js` file from the nearest package.json `type`, so
 * ESM `.js` files under this repo (`"type": "module"`) parse correctly. The `.mjs` retry below
 * exists because that resolution has moved around between Node versions and a false failure
 * here would be maddening to debug — if a `.js` file fails as ambiguous, we prove it is valid
 * ESM before declaring a real syntax error.
 */
function checkSyntax() {
  const files = [
    ...walk(join(ROOT, 'server')),
    ...walk(join(ROOT, 'src')),
    ...walk(join(ROOT, 'scripts')),
  ].filter((f) => ['.js', '.mjs'].includes(extname(f)))

  if (files.length === 0) {
    fail('syntax', 'Found no .js/.mjs files under server/, src/ or scripts/.', 'Run this from the repo root.')
    return
  }

  let scratch = null
  for (const file of files) {
    const first = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (first.status === 0) continue

    if (extname(file) === '.js') {
      // Retry as an explicit ESM file. If it passes, the original failure was module-goal
      // ambiguity in this Node build, not broken code.
      scratch ??= mkdtempSync(join(tmpdir(), 'pa-check-'))
      const copy = join(scratch, 'probe.mjs')
      writeFileSync(copy, readFileSync(file))
      const second = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' })
      if (second.status === 0) {
        note(`${rel(file)} only parses when forced to ESM — this Node build did not infer the module goal.`)
        continue
      }
    }

    fail('syntax', `${rel(file)} does not parse.`, (first.stderr || '').trim().split('\n').slice(0, 6).join('\n'))
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true })

  console.log(dim(`  syntax: parsed ${files.length} module${files.length === 1 ? '' : 's'}`))
}

/* ------------------------------------------------------------ group 2: secret tripwire ---- */

/**
 * Shapes that a credential has and ordinary source code does not.
 *
 * This is a TRIPWIRE, not a scanner. It cannot prove the repo is clean — nothing can. What it
 * can do is make the common accidents (a downloaded service-account JSON, a pasted key, an
 * `.env` that got `git add -A`'d) impossible to commit quietly. The same list runs in CI, so a
 * green laptop and a green pipeline mean the same thing.
 *
 * Deliberately NOT using gitleaks: its GitHub Action requires a `GITLEAKS_LICENSE` secret for
 * organisation-owned repositories, and adding a mandatory secret to the repo whose entire
 * premise is "there are no secrets" is a worse trade than fifteen regexes we can read.
 */
const SECRET_PATTERNS = [
  { name: 'PEM/OpenSSH private key header', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'PEM block of any kind', re: /-----BEGIN (?:CERTIFICATE|RSA|DSA|EC|PGP|OPENSSH)/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GCP service-account key', re: /"type"\s*:\s*"service_account"/ },
  { name: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'generic sk- API key', re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { name: 'hardcoded bearer token', re: /[Aa]uthorization['"\s:]+Bearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  { name: 'assigned secret-ish literal', re: /\b(?:api[_-]?key|secret|passwd|password|private[_-]?key)\b\s*[:=]\s*['"][A-Za-z0-9._~+/=-]{16,}['"]/i },
]

/** Only applied to `.json`: a long unbroken base64 run is what an exported key looks like. */
const JSON_BASE64_BLOB = /"[A-Za-z0-9+/]{120,}={0,2}"/

/**
 * These two files contain the patterns themselves, so they match by construction. Exempting
 * them is stated out loud (and printed on every run) rather than hidden, because the exemption
 * is the one place a real secret could hide from this check.
 */
const SECRET_SCAN_EXEMPT = new Set(['scripts/check.mjs', '.github/workflows/ci.yml'])

/** Binary-ish files: a false positive on a PNG's bytes helps nobody. */
const SECRET_SCAN_SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2', '.gz', '.zip', '.pdf'])

/**
 * Prefer the git index: what is COMMITTED is what leaks, and a stray local file that is
 * correctly gitignored is not an incident. Falls back to a filesystem walk when git has no
 * index yet (a repo before its first commit still deserves the check, loudly).
 */
function trackedFiles() {
  const git = spawnSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
  if (git.status === 0) {
    const listed = git.stdout.split('\0').filter(Boolean)
    if (listed.length > 0) return { source: 'git index', files: listed.map((f) => join(ROOT, f)) }
    note('git tracks no files yet — the secret scan fell back to the working tree.')
  } else {
    note('git is unavailable or this is not a repo — the secret scan fell back to the working tree.')
  }
  return { source: 'working tree', files: walk(ROOT) }
}

function checkSecrets() {
  const { source, files } = trackedFiles()
  let scanned = 0

  for (const file of files) {
    const name = rel(file)
    if (SECRET_SCAN_EXEMPT.has(name)) continue
    if (SECRET_SCAN_SKIP_EXT.has(extname(file).toLowerCase())) continue

    let text
    try {
      const info = statSync(file)
      if (!info.isFile() || info.size > 2 * 1024 * 1024) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // A NUL byte means binary; skip rather than regex over it.
    if (text.includes('\0')) continue
    scanned += 1

    const lines = text.split('\n')
    for (const { name: label, re } of SECRET_PATTERNS) {
      for (let i = 0; i < lines.length; i += 1) {
        if (re.test(lines[i])) {
          fail('secrets', `${name}:${i + 1} matches the "${label}" pattern.`,
            'If it is real: remove it, rotate it, and rewrite the history that contains it. This repo is public and has no secret store.')
        }
      }
    }
    if (extname(file) === '.json') {
      for (let i = 0; i < lines.length; i += 1) {
        if (JSON_BASE64_BLOB.test(lines[i])) {
          fail('secrets', `${name}:${i + 1} contains a long base64 blob in JSON.`,
            'Exported keys look exactly like this. If it is legitimately data, move it out of a .json string or split it.')
        }
      }
    }
  }

  // The ignore file is the second half of the tripwire: it is what stops the accident from
  // reaching `git add` in the first place.
  let ignore = ''
  try {
    ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
  } catch {
    fail('secrets', 'There is no .gitignore.', 'It must at minimum ignore .env, *.pem and *-key.json.')
  }
  const ignored = new Set(ignore.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')))
  for (const pattern of ['.env', '*.pem', '*-key.json']) {
    if (!ignored.has(pattern)) {
      fail('secrets', `.gitignore does not list \`${pattern}\`.`,
        `Add a line \`${pattern}\` — the point is that the accident never becomes a commit.`)
    }
  }

  console.log(dim(`  secrets: scanned ${scanned} file${scanned === 1 ? '' : 's'} from the ${source}` +
    ` (exempt: ${[...SECRET_SCAN_EXEMPT].join(', ')})`))
}

/* --------------------------------------------------------- group 3: the source registry ---- */

/**
 * `/api` is generated from this registry, so a missing field does not throw — it publishes a
 * blank. And `ttlMs` is not cosmetic: it is both the cache TTL and the `cache-control` the
 * browser and Caddy are handed, so a source without one would be re-fetched on every request
 * against somebody else's free public endpoint.
 */
async function checkRegistry() {
  const entry = join(ROOT, 'server', 'sources', 'index.mjs')
  let registry
  try {
    registry = await import(pathToFileURL(entry).href)
  } catch (problem) {
    fail('registry', 'server/sources/index.mjs could not be imported.', String(problem?.stack ?? problem).split('\n').slice(0, 6).join('\n'))
    return
  }

  const sources = registry.SOURCES
  if (!sources || typeof sources !== 'object') {
    fail('registry', 'server/sources/index.mjs does not export SOURCES.', 'The HTTP layer resolves every request against it.')
    return
  }

  let operationCount = 0
  let jobCount = 0
  for (const [key, source] of Object.entries(sources)) {
    const where = `source \`${key}\``
    if (typeof source?.id !== 'string' || !source.id) fail('registry', `${where} has no \`id\`.`, 'It is the first path segment of /api/<source>/<operation>.')
    else if (source.id !== key) fail('registry', `${where} is registered under a key that is not its \`id\` (\`${source.id}\`).`, 'Requests resolve by key, /api describes by id — they must agree.')
    if (typeof source?.label !== 'string' || !source.label) fail('registry', `${where} has no \`label\`.`, 'It is what the public API listing shows a human.')
    if (!source?.operations || typeof source.operations !== 'object' || Object.keys(source.operations).length === 0) {
      fail('registry', `${where} has no \`operations\`.`, 'A source with nothing to call is dead weight in the registry.')
      continue
    }
    // Not fatal, but /api renders these fields and an empty one is a worse answer than none.
    for (const soft of ['homepage', 'doc']) {
      if (!source[soft]) note(`${where} has no \`${soft}\` — /api will publish null for it.`)
    }

    for (const [opId, op] of Object.entries(source.operations)) {
      operationCount += 1
      const opWhere = `operation \`${key}/${opId}\``
      if (typeof op?.summary !== 'string' || !op.summary.trim()) {
        fail('registry', `${opWhere} has no \`summary\`.`, 'It is the only description a caller of /api ever sees.')
      }
      if (typeof op?.ttlMs !== 'number' || !Number.isFinite(op.ttlMs) || op.ttlMs <= 0) {
        fail('registry', `${opWhere} has no positive \`ttlMs\`.`, 'It sets both the server cache TTL and the cache-control we hand the browser; without it every request hits somebody else\'s free endpoint.')
      }
      if (typeof op?.run !== 'function') {
        fail('registry', `${opWhere} has no \`run\` function.`, 'The HTTP layer calls op.run(params) and nothing else.')
      }
    }

    // Mode A: a `jobs` entry is a store-backed operation on the same URL shape, and it RESOLVES
    // FIRST (server/index.mjs). So a job named after an existing operation does not sit beside
    // it — it takes the URL away from it, and the page drawn from that URL keeps answering 200
    // with an envelope it cannot read. Nothing throws, nothing logs; the chart is just empty.
    // One operation, one mode, checked here rather than discovered on a dashboard.
    for (const [jobId, handler] of Object.entries(source.jobs ?? {})) {
      jobCount += 1
      const jobWhere = `job \`${key}/${jobId}\``
      if (Object.prototype.hasOwnProperty.call(source.operations, jobId)) {
        fail('registry', `${jobWhere} has the same name as an operation of the same source.`,
          'A jobs entry wins over an operations entry at /api/<source>/<name>, so the operation becomes unreachable and its page renders empty with no error anywhere. Rename one of them.')
      }
      if (typeof handler?.summary !== 'string' || !handler.summary.trim()) {
        fail('registry', `${jobWhere} has no \`summary\`.`, 'It is the only description a caller ever sees.')
      }
      for (const required of ['immutable', 'nextBatch']) {
        if (typeof handler?.[required] !== 'function') {
          fail('registry', `${jobWhere} has no \`${required}\` function.`,
            'The job engine refuses a handler that does not implement the contract at the top of server/lib/job-worker.mjs.')
        }
      }
    }
  }

  console.log(dim(`  registry: ${Object.keys(sources).length} sources, ${operationCount} operations, ${jobCount} store-backed job${jobCount === 1 ? '' : 's'}`))
}

/* ------------------------------------------------------ group 4: no third-party origins ---- */

/**
 * Upstream hostnames live in `server/sources/` and nowhere else.
 *
 * That is not a naming convention, it is the security boundary: `connect-src 'self'` says the
 * browser may talk to this origin only, and every upstream call is made server-side through
 * one audited function. An absolute URL that creeps into `src/` is a page fetching a third
 * party directly — which the CSP would block in production and which would therefore only show
 * up as a broken chart, long after the commit that caused it.
 *
 * The invariant being defended is narrower than "no absolute URL appears", and being precise
 * about it is what keeps this check honest instead of merely loud. What must never happen is
 * the browser FETCHING a third party. So these are allowed — and every one of them is PRINTED,
 * because an allow-list you cannot see is an allow-list nobody re-examines:
 *
 *   - `link`   — an `href` on an anchor. Navigation is not a fetch; `connect-src` does not
 *                govern it, and the footer's "source" link to the repo is the whole point of
 *                publishing a public analytics site.
 *   - `data`   — a provenance field inside a `.json` dataset (`repo`, `source`, `license`…).
 *                It is a string that gets rendered as an attribution, never dereferenced.
 *   - `homepage` — the registry's attribution field, same reasoning.
 *
 * And these are structurally incapable of being a third-party fetch, so they are counted only:
 *   - loopback (this origin talking to itself), XML namespaces (SVG `xmlns` is an identifier,
 *     never retrieved), comments and markdown prose, and URLs whose HOST is an interpolated
 *     variable rather than a literal — a hardcoded upstream is what we are hunting, and
 *     `http://${HOST}:${PORT}` in a startup log is not one.
 */
const URL_RE = /https?:\/\/[^\s'"`)>\]},]+/g
const URL_SCAN_EXT = new Set(['.js', '.mjs', '.html', '.css', '.json', '.md', '.svg'])

/** JSON keys whose value is documentation about the data, not an endpoint the app calls. */
const PROVENANCE_KEYS = /"(?:repo|repository|url|homepage|source|sourceUrl|reference|docs?|license|link|about)"\s*:/i

function classifyUrl(file, line, matchIndex, url) {
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/.test(url)) return 'loopback'
  if (/^https?:\/\/(?:www\.)?w3\.org\//.test(url)) return 'xml-namespace'
  if (extname(file) === '.md') return 'prose'

  // Host is everything between `://` and the first `/`, `?` or `#`. If it is built from a
  // variable there is no hardcoded upstream here to find.
  const host = url.replace(/^https?:\/\//, '').split(/[/?#]/)[0]
  if (host.includes('${') || host.includes('%s') || host.includes("' +") || host.includes('" +')) return 'interpolated-host'

  const trimmed = line.trimStart()
  if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*') ||
      trimmed.startsWith('#') || trimmed.startsWith('<!--')) return 'comment'

  // A `//` that is not part of a scheme, occurring before the match, means the match is inside
  // a trailing line comment.
  const commentAt = line.search(/(^|[^:])\/\//)
  if (commentAt !== -1 && commentAt < matchIndex) return 'comment'

  // `href` is navigation. `src` is NOT — a script/img/iframe src is a real third-party fetch
  // the CSP would block, so it deliberately falls through to `violation`.
  if (/\bhref\b/.test(line)) return 'link'
  if (/\bhomepage\s*[:=]/.test(line)) return 'homepage'
  if (extname(file) === '.json' && PROVENANCE_KEYS.test(line)) return 'data'

  return 'violation'
}

/** Categories that are legitimate but must still be visible in the output, one line each. */
const URL_REPORTED = new Set(['link', 'homepage', 'data'])

function checkUrls() {
  const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'server'))]
    .filter((f) => URL_SCAN_EXT.has(extname(f)))
    // The registry is where upstream hostnames are SUPPOSED to be.
    .filter((f) => !rel(f).startsWith('server/sources/'))

  const allowed = new Map()
  const reported = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      for (const match of lines[i].matchAll(URL_RE)) {
        const kind = classifyUrl(file, lines[i], match.index ?? 0, match[0])
        if (kind === 'violation') {
          fail('urls', `${rel(file)}:${i + 1} contains an absolute URL: ${match[0]}`,
            'Upstream hostnames belong in server/sources/ only. If a page needs this data, add an operation to the registry and call /api/<source>/<op> instead — the CSP will block a direct fetch in production anyway.')
          continue
        }
        allowed.set(kind, (allowed.get(kind) ?? 0) + 1)
        if (URL_REPORTED.has(kind)) reported.push(`${kind.padEnd(8)} ${rel(file)}:${i + 1}  ${match[0]}`)
      }
    }
  }

  const breakdown = [...allowed.entries()].sort().map(([k, n]) => `${n} ${k}`).join(', ') || 'none'
  console.log(dim(`  urls: scanned ${files.length} files outside server/sources/; allowed occurrences: ${breakdown}`))
  // Printed, not silently swallowed: these are the ones a reviewer should glance at.
  for (const line of reported) console.log(dim(`         ${line}`))
}

/* -------------------------------------------------------- group 5: the knowledge base ---- */

/**
 * Every document in `docs/` renders, and every link between them resolves.
 *
 * These files are published: `docs/platform/xcm.md` is `/knowledge/platform/xcm/`. So the
 * failure modes are the same shape as everything else this script guards — silent, and visible
 * only to a reader.
 *
 *   · An UNSUPPORTED construct renders as literal markdown. The renderer is deliberately a
 *     subset (no dependency, no HTML passthrough), and the honest way to have a subset is to
 *     refuse what is outside it rather than mangle it.
 *   · `undefined` in the output is the renderer having looked something up that was not there.
 *     It has happened once already, from a placeholder pattern that matched bare numbers in
 *     prose, and it renders as the word "undefined" in the middle of a sentence.
 *   · A BROKEN INTERNAL LINK renders as plain text — the target is dropped rather than pointed
 *     at a 404. Which is right, and is exactly why it needs a check: nothing looks wrong.
 *
 * A missing heading ANCHOR is a note rather than a failure: the link still lands on the right
 * document, at the top instead of at the section.
 *
 * EVERY document is checked, including the ones `PUBLISHED_SECTIONS` withholds from the site.
 * They are still repo documents that people and agents read and follow links in, so a broken
 * link in one is still worth catching — the allowlist governs publication, not correctness.
 * What differs is the local-path rule below, which is a *disclosure* problem and so only
 * fails the build for a document that is actually published.
 */
function checkDocs() {
  const { docs, brokenLinks, brokenAnchors, withheldLinks } = collectDocuments(ROOT)

  if (docs.length === 0) {
    note(`${DOCS_DIR}/ holds no markdown — nothing was rendered for /knowledge/.`)
    return
  }

  // A section with a label but no publication is a document set that quietly never appears.
  for (const { dir } of SECTIONS) {
    if (!PUBLISHED_SECTIONS.has(dir)) {
      fail('docs', `\`${dir}/\` is described in SECTIONS but missing from PUBLISHED_SECTIONS.`,
        'The index would render a heading for it with nothing under it. Add it to the allowlist, or remove its SECTIONS entry.')
    }
  }

  const byFile = new Map(docs.map((doc) => [doc.file, doc]))

  /**
   * SEVERITY FOLLOWS PUBLICATION. A finding in a published document fails the build; the same
   * finding in an unpublished one is printed on every run but does not.
   *
   * This is not a softening of the rule — the rule is about consequences, and they genuinely
   * differ. A mangled construct or a dead link in a published document is wrong ON A PUBLIC
   * PAGE. In `docs/concept/` it is wrong in a working note that a running workflow is still
   * writing, and failing the shared build on its intermediate states would make every deploy
   * hostage to a process that has never heard of this script. Nothing is dropped: every
   * finding is reported, and a directory cannot be added to PUBLISHED_SECTIONS without these
   * turning into build failures on the spot.
   */
  const report = (file, message, hint) => {
    if (byFile.get(file)?.published === false) note(`${message} (unpublished, so it does not fail the build — fix it before publishing.)`)
    else fail('docs', message, hint)
  }

  for (const doc of docs) {
    for (const { name, test } of UNSUPPORTED) {
      if (test.test(doc.source)) {
        report(doc.file, `${doc.file} uses an unsupported construct: ${name}.`,
          'scripts/markdown.mjs renders a deliberate subset and this is outside it. Rewrite it in the subset, or add the rule to the renderer AND to UNSUPPORTED.')
      }
    }

    // Only meaningful when the document does not literally say the word.
    if (doc.html.includes('undefined') && !doc.source.includes('undefined')) {
      report(doc.file, `${doc.file} renders the word "undefined".`,
        'That is the renderer failing a lookup, not the document. See the code-span placeholder in scripts/markdown.mjs.')
    }

    if (!doc.title) {
      report(doc.file, `${doc.file} has no level-1 heading.`, 'It is the page title, the nav label and the <title> tag.')
    }

    // Markdown that survived into the prose. Code spans and blocks are stripped first — the
    // characters are legitimate content in there.
    const prose = doc.html.replace(/<pre><code>[\s\S]*?<\/code><\/pre>/g, '').replace(/<code>[\s\S]*?<\/code>/g, '')
    if (prose.includes('**')) {
      report(doc.file, `${doc.file} renders literal \`**\` in its prose.`, 'Bold markers only pair on one line and cannot contain a `*`.')
    }
    for (const match of prose.matchAll(/\[[^\]]+\]\([^)]*\)/g)) {
      report(doc.file, `${doc.file} renders an unhandled link: ${match[0]}`, 'The renderer supports `[text](target)` and `[text](target "title")` only.')
    }

    // Local filesystem paths used to be checked here, which meant they were checked in `docs/`
    // and NOWHERE ELSE — and the one that mattered was in a script. See `checkPaths` below.
  }

  for (const { from, href, target } of brokenLinks) {
    report(from, `${from} links to \`${href}\`, which does not exist (${DOCS_DIR}/${target}).`,
      'It renders as plain text — no dead anchor, and no sign to a reader that anything is missing. Fix the path or remove the link.')
  }

  for (const { from, href, anchor } of brokenAnchors) {
    note(`${from} links to \`${href}\` — the document exists but has no \`#${anchor}\` heading, so the link lands at the top.`)
  }

  for (const { from, href, target } of withheldLinks) {
    note(`${from} links to \`${href}\`, which is not published (\`${DOCS_DIR}/${target}\`) — it renders as plain text.`)
  }

  const links = docs.reduce((total, doc) => total + (doc.links?.length ?? 0), 0)
  const withheld = docs.filter((doc) => !doc.published)
  console.log(dim(`  docs: rendered ${docs.length} document${docs.length === 1 ? '' : 's'}, ${links} internal link${links === 1 ? '' : 's'} resolved`))
  console.log(dim(`         published sections: ${[...PUBLISHED_SECTIONS].sort().join(', ')} (allowlist — scripts/knowledge.mjs)`))
  // Printed every run, one line per withheld document. The cost of an allowlist is a document
  // that silently does not appear, and this is the thing that stops it being silent.
  if (withheld.length > 0) {
    console.log(dim(`         WITHHELD from /knowledge/ — ${withheld.length} document${withheld.length === 1 ? '' : 's'} in unpublished directories:`))
    for (const doc of withheld) console.log(dim(`           ${doc.file}`))
  }
}

/* ------------------------------------------- group 6: nobody's laptop in the repository ---- */

/**
 * Paths that belong to somebody's machine rather than to this project.
 *
 * This used to be a rule about `docs/` only — `localPaths` was called from exactly one place,
 * inside `checkDocs`, so it read the markdown and nothing else. Meanwhile
 * `scripts/build-netflows-dataset.mjs` opened with a hardcoded Windows drive-letter default and
 * passed every run of this script, and a handover note in `docs/` stated as fact that the
 * repository contained no local paths. Both were true of the half that was checked.
 *
 * So the scan is now the whole repository, and the claim it defends is the one that was always
 * being made: A PATH FROM SOMEBODY'S MACHINE DOES NOT EXIST HERE. Two different harms, and the
 * second is the expensive one:
 *
 *   · In a DOCUMENT it is a disclosure — whose machine, how it is laid out, what else is on it —
 *     and it is meaningless to every reader. `docs/` is published at a world-readable URL.
 *   · In a SCRIPT it is a default that works for one person. `npm run data:netflows` ran on one
 *     laptop and failed everywhere else with a path nobody recognised. That is not a leak, it is
 *     a command that only appears to exist.
 *
 * It fails wherever it is found, published or not, tracked or not. Unlike a mangled construct or
 * a dead link, a drive letter is never an intermediate state of something being written: it is
 * never right, and it does not become right by being edited around.
 *
 * TWO LOOKAROUNDS AND A QUANTIFIER keep this from firing on things that are not paths:
 *
 *   · A drive letter is preceded by a non-letter and followed by exactly one slash — otherwise
 *     `https://` matches a naive `[A-Za-z]:/` at its own `s:/`.
 *   · That slash must be followed by SOMETHING. A bare `X:/` with nothing after it is a fragment
 *     of prose about the pattern (this comment used to contain one) and discloses nothing; a
 *     real one always carries the directory that makes it a leak.
 *   · `/home/` and `/Users/` are also URL paths on this site: the page directories are served at
 *     `/home/`, `/hydration/` and so on, and `index.html` loads `/home/main.js`. A home
 *     directory is not a file, so a segment ending in a web file extension is not one.
 */
const LOCAL_PATH_RE =
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?![\\/])[^\s`'")\]]+|\/(?:home|Users)\/(?![A-Za-z0-9._-]*\.(?:js|mjs|css|html|json|svg|png|ico|webp|txt)(?![A-Za-z0-9]))[A-Za-z0-9._-]+/g

/** Extensions worth reading as text. A local path inside a PNG is not a thing that happens. */
const PATH_SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.html', '.css', '.json', '.md', '.svg', '.yml', '.yaml', '.sh', '.toml', ''])

function localPaths(source) {
  const found = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    for (const match of lines[i].matchAll(LOCAL_PATH_RE)) found.push({ line: i + 1, text: match[0] })
  }
  return found
}

function checkPaths() {
  // Which documents are published only changes the HINT, never whether it fails — but a reader
  // fixing a `docs/` finding deserves to be told whether it is already on the internet.
  let published = new Map()
  try {
    published = new Map(collectDocuments(ROOT).docs.map((doc) => [doc.file, doc.published]))
  } catch {
    note('the knowledge base could not be collected, so local-path findings in docs/ carry no publication hint.')
  }

  const files = walk(ROOT).filter((f) => PATH_SCAN_EXT.has(extname(f).toLowerCase()))
  let scanned = 0

  for (const file of files) {
    const name = rel(file)
    let text
    try {
      const info = statSync(file)
      if (!info.isFile() || info.size > 2 * 1024 * 1024) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\0')) continue // binary despite the extension
    scanned += 1

    for (const { line, text: match } of localPaths(text)) {
      const where = published.has(name)
        ? published.get(name)
          ? ' This document is published at a world-readable URL.'
          : ' This document is not published today, but publishing it is a one-line change to PUBLISHED_SECTIONS and this would go out with it.'
        : ''
      fail('paths', `${name}:${line} contains a local filesystem path: ${match}`,
        `A path from somebody's machine says who they are and how they work, it is meaningless to every reader, and as a default value it is a command that runs on one computer.${where}` +
        ' Replace it with a path relative to the repository root, or — for a script that needs a location outside the repo — a required argument or environment variable with no default.')
    }
  }

  console.log(dim(`  paths: scanned ${scanned} text file${scanned === 1 ? '' : 's'} across the repository`))
}

/* ----------------------------------------------------------------------------- runner ---- */

const GROUPS = {
  syntax: checkSyntax,
  secrets: checkSecrets,
  registry: checkRegistry,
  urls: checkUrls,
  docs: checkDocs,
  paths: checkPaths,
}

const args = process.argv.slice(2)
if (args.includes('--list')) {
  console.log(Object.keys(GROUPS).join('\n'))
  process.exit(0)
}

const onlyArg = args.find((a) => a.startsWith('--only='))
const selected = onlyArg
  ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean)
  : Object.keys(GROUPS)

for (const name of selected) {
  if (!GROUPS[name]) {
    console.error(red(`Unknown check group \`${name}\`. Known groups: ${Object.keys(GROUPS).join(', ')}`))
    process.exit(2)
  }
}

console.log(`polkadot-analytics check — ${selected.join(', ')}`)
for (const name of selected) {
  await GROUPS[name]()
}

if (notes.length > 0) {
  console.log('')
  for (const message of notes) console.log(`${yellow('note')} ${message}`)
}

if (failures.length > 0) {
  console.log('')
  for (const { group, message, hint } of failures) {
    console.error(`${red('FAIL')} [${group}] ${message}`)
    if (hint) console.error(dim(hint.split('\n').map((l) => `       ${l}`).join('\n')))
  }
  console.error('')
  console.error(red(`${failures.length} problem${failures.length === 1 ? '' : 's'}. Nothing was changed — fix the above and re-run \`npm run check\`.`))
  process.exit(1)
}

console.log('')
console.log(green(`✔ all checks passed (${selected.join(', ')})`))
