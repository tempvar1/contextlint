#!/usr/bin/env node
// v0.4 — measure the always-on instruction block, report which rules were added
// since the last run, and gather what already enforces things into a dossier for
// the contextlint skill to classify. Runs from a SessionStart hook with
// --if-due, where it stays completely silent unless there is something to say.
// Reports only. Never edits the target repo's instruction files, and never
// touches hooks.

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve, relative } from 'node:path'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'

const DEFAULTS = {
  floorTokens: 1500,
  growthRules: 10,
  growthTokens: 300,
  aggressiveness: 'aggressive',
  minHoursBetweenRuns: 24,
}
const IMPORT_LINE = /^\s*@([^\s@][^\s]*)\s*$/gm

// chars/4 — the same rough estimate the proposal measures with. Under-counts
// markdown tables and code, so treat it as a floor, not a precise number.
export const estimateTokens = (text) => Math.ceil(text.length / 4)

// Follows @-imports depth-first from an entry file, returning every file that
// ends up loaded. Imports resolve relative to the file that declares them.
export function collectImports(entry, seen = new Set()) {
  const abs = resolve(entry)
  if (seen.has(abs) || !existsSync(abs)) return []
  seen.add(abs)
  const text = readFileSync(abs, 'utf8')
  const out = [{ path: abs, text }]
  for (const [, ref] of text.matchAll(IMPORT_LINE)) {
    out.push(...collectImports(resolve(dirname(abs), ref), seen))
  }
  return out
}

// The always-on block: CLAUDE.md plus everything it imports, plus the
// gitignored local override if one exists.
export function alwaysOnFiles(targetDir) {
  const seen = new Set()
  return [
    ...collectImports(join(targetDir, 'CLAUDE.md'), seen),
    ...collectImports(join(targetDir, 'CLAUDE.local.md'), seen),
  ]
}

const readJson = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
}

const tryGit = (dir, ...args) => {
  try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return null }
}

const headCommit = (dir) => tryGit(dir, 'rev-parse', 'HEAD')?.trim() ?? null

const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

const isTracked = (dir, path) => tryGit(dir, 'ls-files', '--error-unmatch', '--', path) !== null

// Lines that carry no rule of their own: blank, headings (the section name is
// captured separately), table separators, and fence markers.
const NOISE = /^\s*(#{1,6}\s|```|\|[\s|:-]*\|\s*$)?\s*$|^\s*#{1,6}\s|^\s*```|^\s*\|[\s|:-]*\|\s*$/

// Heading path for every line in a file, e.g. "Rules > 5. Simplicity".
export function sectionsByLine(text) {
  const stack = []
  return text.split('\n').map((line) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) {
      stack.length = m[1].length - 1
      stack[m[1].length - 1] = m[2].trim()
    }
    return stack.filter(Boolean).join(' > ')
  })
}

// Added lines with their new-file line numbers, straight from git. `since` is
// diffed against the working tree, so committed and uncommitted changes both
// show up in one pass.
export function addedLines(dir, since, path) {
  const diff = tryGit(dir, 'diff', '--unified=0', '--no-color', since, '--', path)
  if (diff === null) return null
  const out = []
  let n = 0
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)
    if (hunk) { n = Number(hunk[1]); continue }
    if (line.startsWith('+++')) continue
    if (line.startsWith('+')) out.push({ line: n++, text: line.slice(1) })
  }
  return out
}

// A list item or numbered item starts a rule of its own. Anything else is a
// continuation of the one above it.
const STARTS_RULE = /^\s*(?:[-*+]|\d+\.)\s/

// Consecutive added lines inside one section become one candidate rule, except
// where a new list item starts — three bullets in a row are three rules, and
// merging them produces one candidate that belongs in three different buckets.
function groupIntoRules(file, added, sections) {
  const rules = []
  for (const { line, text } of added) {
    if (NOISE.test(text)) continue
    const section = sections[line - 1] ?? ''
    const last = rules.at(-1)
    if (last && last.section === section && line === last.endLine + 1 && !STARTS_RULE.test(text)) {
      last.text += '\n' + text
      last.endLine = line
    } else {
      rules.push({ file, line, endLine: line, section, text })
    }
  }
  return rules
}

// Candidate rules since the previous run. Falls back to a full audit when there
// is no usable history: first run, a rewritten commit, or a non-git target.
export function findCandidates(targetDir, files, previous) {
  const since = previous?.commit
  const haveHistory = since && tryGit(targetDir, 'cat-file', '-e', `${since}^{commit}`) !== null
  const wasHashed = (path) => previous?.files?.find((f) => f.path === path)?.hash

  const rules = []
  const changedWithoutHistory = []

  for (const f of files) {
    const sections = sectionsByLine(f.text)
    const added = haveHistory && isTracked(targetDir, f.path)
      ? addedLines(targetDir, since, f.path)
      : null

    if (added) {
      rules.push(...groupIntoRules(f.path, added, sections))
      continue
    }

    // No diffable history for this file (untracked, gitignored, or first run).
    // ponytail: hash-only comparison, so a changed local file is reported whole
    // rather than line by line. Store old content if that ever gets noisy.
    const before = wasHashed(f.path)
    if (!before) {
      const all = f.text.split('\n').map((text, i) => ({ line: i + 1, text }))
      rules.push(...groupIntoRules(f.path, all, sections))
    } else if (before !== f.hash) {
      changedWithoutHistory.push(f.path)
    }
  }

  return { mode: haveHistory ? 'diff' : 'full', rules, changedWithoutHistory }
}

export function measure(targetDir) {
  const files = alwaysOnFiles(targetDir).map((f) => ({
    path: relative(targetDir, f.path),
    text: f.text,
    chars: f.text.length,
    lines: f.text.split('\n').length,
    tokens: estimateTokens(f.text),
    hash: hash(f.text),
  }))
  return { files, totalTokens: files.reduce((n, f) => n + f.tokens, 0) }
}

// ---------------------------------------------------------------- step 5
// What already enforces things. Facts only — no judgement about whether any of
// it actually covers a given rule. That call belongs to the skill.

// Hooks are code that can block work, so contextlint reads them and never
// writes them. Matchers are reported verbatim: a matcher that looks like it
// covers a rule may not fire in practice, and the skill must say so.
export function readHooks(targetDir) {
  const settings = readJson(join(targetDir, '.claude', 'settings.json'), {})
  const hooks = []
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    for (const entry of entries) {
      hooks.push({
        event,
        matcher: entry.matcher ?? '*',
        commands: (entry.hooks ?? []).map((h) => h.command).filter(Boolean),
      })
    }
  }
  return { hooks, deny: settings.permissions?.deny ?? [] }
}

const frontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!m) return {}
  const out = {}
  // Enough YAML for `name:` and a folded `description: >`. Skills that need
  // more than that are read in full by the skill, not parsed here.
  for (const [, key, inline, block] of m[1].matchAll(/^(\w+):[ \t]*(?:>-?\s*\n((?:[ \t]+.*\n?)*)|(.*))$/gm)) {
    out[key] = (inline ?? block ?? '').replace(/\s+/g, ' ').trim()
  }
  return out
}

const dirsIn = (path) => {
  try { return readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
}

// Plugins send instructions too, and contextlint can read them but never change
// them — which is why a rule a plugin covers gets moved, not deleted.
export function readPlugins(targetDir, configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')) {
  const enabled = readJson(join(targetDir, '.claude', 'settings.json'), {}).enabledPlugins ?? {}
  const installed = readJson(join(configDir, 'plugins', 'installed_plugins.json'), {}).plugins ?? {}

  return Object.entries(enabled)
    .filter(([id, on]) => on && id.includes('@'))
    .map(([id]) => {
      // A plugin can have several install entries — an auto-update leaves the
      // old one in place. The live one is the most recently updated entry whose
      // directory still exists; taking the first silently records a stale
      // version, which makes every "covered by X v.Y" note unverifiable.
      const entries = [...(installed[id] ?? [])].sort(
        (a, b) => String(b.lastUpdated ?? '').localeCompare(String(a.lastUpdated ?? ''))
      )
      const install = entries.find((e) => e.installPath && existsSync(e.installPath))
      const path = install?.installPath
      if (!path) return { id, version: entries[0]?.version ?? null, path: entries[0]?.installPath ?? null, missing: true }

      const skills = dirsIn(join(path, 'skills')).flatMap((name) => {
        const file = join(path, 'skills', name, 'SKILL.md')
        if (!existsSync(file)) return []
        const { description = '' } = frontmatter(readFileSync(file, 'utf8'))
        return [{ name, description, path: file }]
      })

      return {
        id,
        version: install.version ?? null,
        path,
        // Root-level instruction files are the plugin's always-on half.
        instructionFiles: ['CLAUDE.md', 'AGENTS.md'].filter((f) => existsSync(join(path, f))),
        skills,
      }
    })
}

// ---------------------------------------------------------------- step 6
// A rule the user has already rejected must not come back every week.
export const ruleKey = (r) => `${r.file}:${r.section}:${hash(r.text)}`

export function writeDossier(stateDir, targetDir, body) {
  const path = join(stateDir, 'dossier.json')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n')
  return path
}

// Hook output is the one place a hook costs tokens, and it costs them on every
// session. So in quiet mode contextlint prints nothing at all unless there is
// something worth acting on. A linter that greets you every morning is the
// waste it exists to find.
export const hoursSince = (iso, now) => (now - Date.parse(iso)) / 3_600_000

export function isDue(log, config, now = Date.now()) {
  const previous = log.at(-1)
  return !previous || hoursSince(previous.date, now) >= config.minHoursBetweenRuns
}

function main(targetDir, { quiet = false, ifDue = false } = {}) {
  const say = quiet ? () => {} : console.log

  if (!existsSync(join(targetDir, 'CLAUDE.md'))) {
    // Nothing to measure is normal for most repos, and the hook runs in all of
    // them. Only say so when a person asked directly.
    if (quiet) return
    console.error(`no CLAUDE.md in ${targetDir} — nothing to measure`)
    process.exit(1)
  }

  const stateDir = join(targetDir, '.contextlint')
  const config = { ...DEFAULTS, ...readJson(join(stateDir, 'config.json'), {}) }
  const logPath = join(stateDir, 'log.json')
  const log = readJson(logPath, [])
  const previous = log.at(-1)

  if (ifDue && !isDue(log, config)) return

  const { files, totalTokens } = measure(targetDir)

  const width = Math.max(...files.map((f) => f.path.length))
  for (const f of files) {
    say(`  ${f.path.padEnd(width)}  ${String(f.lines).padStart(5)} lines  ${String(f.tokens).padStart(6)} tokens`)
  }
  say(`  ${''.padEnd(width, '-')}  ${''.padStart(5, '-')}        ${''.padStart(6, '-')}`)
  say(`  ${'total'.padEnd(width)}  ${String(files.reduce((n, f) => n + f.lines, 0)).padStart(5)} lines  ${String(totalTokens).padStart(6)} tokens`)

  const tokenDelta = previous ? totalTokens - previous.totalTokens : totalTokens
  if (previous) {
    say(`\n  since ${previous.date.slice(0, 10)}: ${tokenDelta >= 0 ? '+' : ''}${tokenDelta} tokens`)
  }

  // Under the floor, a small instruction block is not a problem worth a tool.
  const underFloor = totalTokens < config.floorTokens
  const found = underFloor
    ? { mode: 'skipped', rules: [], changedWithoutHistory: [] }
    : findCandidates(targetDir, files, previous)

  // Rules the user has already declined to move stay declined.
  const ignored = new Set(readJson(join(stateDir, 'ignore.json'), []).map((e) => e.rule ?? e))
  const { mode, changedWithoutHistory } = found
  const rules = found.rules.filter((r) => !ignored.has(ruleKey(r)))
  const skipped = found.rules.length - rules.length

  record(stateDir, logPath, log, { totalTokens, files, rules })

  if (underFloor) {
    say(`\nUnder the ${config.floorTokens}-token floor. Nothing to do.`)
    return
  }

  if (mode === 'full') {
    say(`\nNo previous run to diff against — full audit: ${rules.length} rules in the always-on block.`)
  } else if (rules.length === 0) {
    say('\nNo rules added since the last run.')
  } else {
    say(`\n${rules.length} rule${rules.length === 1 ? '' : 's'} added since the last run:\n`)
    if (!quiet) for (const r of rules) printRule(r)
  }

  if (skipped) say(`  (${skipped} previously declined — see .contextlint/ignore.json)`)

  for (const path of changedWithoutHistory) {
    say(`  ${path} changed, but git has no history for it — contents not shown.`)
  }

  const grew = rules.length >= config.growthRules || tokenDelta >= config.growthTokens
  if (!(mode === 'full' || grew)) {
    say('\nBelow the growth threshold. Nothing to do.')
    return
  }

  const dossier = writeDossier(stateDir, targetDir, {
    generatedAt: new Date().toISOString(),
    target: targetDir,
    commit: headCommit(targetDir),
    config,
    measurement: { totalTokens, tokenDelta, files: files.map(({ text, ...f }) => f) },
    mode,
    candidates: rules.map((r) => ({ key: ruleKey(r), ...r })),
    changedWithoutHistory,
    ...readHooks(targetDir),
    plugins: readPlugins(targetDir),
  })

  console.log(
    quiet
      ? `contextlint: ${rules.length} new rule${rules.length === 1 ? '' : 's'} in the always-on block (${totalTokens} tokens). Run /contextlint to classify.`
      : `\nWorth a look. Dossier: ${relative(targetDir, dossier)}\nRun the contextlint skill to classify these rules.`
  )
}

function printRule(r) {
  const where = r.line === r.endLine ? `${r.file}:${r.line}` : `${r.file}:${r.line}-${r.endLine}`
  console.log(`  ${where}${r.section ? `  §${r.section}` : ''}`)
  for (const line of r.text.split('\n')) console.log(`    ${line}`)
  console.log('')
}

// The log holds facts, not file contents — text stays out of it.
function record(stateDir, logPath, log, { totalTokens, files, rules }) {
  mkdirSync(stateDir, { recursive: true })
  log.push({
    date: new Date().toISOString(),
    commit: headCommit(dirname(stateDir)),
    totalTokens,
    candidateRules: rules.length,
    files: files.map(({ text, ...f }) => f),
  })
  writeFileSync(logPath, JSON.stringify(log, null, 2) + '\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({
    options: { quiet: { type: 'boolean' }, 'if-due': { type: 'boolean' } },
    allowPositionals: true,
  })
  const ifDue = values['if-due'] ?? false
  main(resolve(positionals[0] ?? process.cwd()), { quiet: values.quiet || ifDue, ifDue })
}
