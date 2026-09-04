#!/usr/bin/env node
// v0.2 — measure the always-on instruction block, log its size over time, and
// report which rules were added since the last run.
// Reports only. Never edits the target repo's instruction files.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

const DEFAULTS = { floorTokens: 1500, growthRules: 10, growthTokens: 300 }
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

// Consecutive added lines inside one section become one candidate rule.
function groupIntoRules(file, added, sections) {
  const rules = []
  for (const { line, text } of added) {
    if (NOISE.test(text)) continue
    const section = sections[line - 1] ?? ''
    const last = rules.at(-1)
    if (last && last.section === section && line === last.endLine + 1) {
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

function main(targetDir) {
  if (!existsSync(join(targetDir, 'CLAUDE.md'))) {
    console.error(`no CLAUDE.md in ${targetDir} — nothing to measure`)
    process.exit(1)
  }

  const stateDir = join(targetDir, '.contextlint')
  const config = { ...DEFAULTS, ...readJson(join(stateDir, 'config.json'), {}) }
  const logPath = join(stateDir, 'log.json')
  const log = readJson(logPath, [])
  const previous = log.at(-1)

  const { files, totalTokens } = measure(targetDir)

  const width = Math.max(...files.map((f) => f.path.length))
  for (const f of files) {
    console.log(`  ${f.path.padEnd(width)}  ${String(f.lines).padStart(5)} lines  ${String(f.tokens).padStart(6)} tokens`)
  }
  console.log(`  ${''.padEnd(width, '-')}  ${''.padStart(5, '-')}        ${''.padStart(6, '-')}`)
  console.log(`  ${'total'.padEnd(width)}  ${String(files.reduce((n, f) => n + f.lines, 0)).padStart(5)} lines  ${String(totalTokens).padStart(6)} tokens`)

  const tokenDelta = previous ? totalTokens - previous.totalTokens : totalTokens
  if (previous) {
    console.log(`\n  since ${previous.date.slice(0, 10)}: ${tokenDelta >= 0 ? '+' : ''}${tokenDelta} tokens`)
  }

  // Under the floor, a small instruction block is not a problem worth a tool.
  const underFloor = totalTokens < config.floorTokens
  const { mode, rules, changedWithoutHistory } = underFloor
    ? { mode: 'skipped', rules: [], changedWithoutHistory: [] }
    : findCandidates(targetDir, files, previous)

  record(stateDir, logPath, log, { totalTokens, files, rules })

  if (underFloor) {
    console.log(`\nUnder the ${config.floorTokens}-token floor. Nothing to do.`)
    return
  }

  if (mode === 'full') {
    console.log(`\nNo previous run to diff against — full audit: ${rules.length} rules in the always-on block.`)
  } else if (rules.length === 0) {
    console.log('\nNo rules added since the last run.')
  } else {
    console.log(`\n${rules.length} rule${rules.length === 1 ? '' : 's'} added since the last run:\n`)
    for (const r of rules) printRule(r)
  }

  for (const path of changedWithoutHistory) {
    console.log(`  ${path} changed, but git has no history for it — contents not shown.`)
  }

  const grew = rules.length >= config.growthRules || tokenDelta >= config.growthTokens
  console.log(
    mode === 'full' || grew
      ? '\nWorth a look. Classification is v0.3.'
      : '\nBelow the growth threshold. Nothing to do.'
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

if (import.meta.url === `file://${process.argv[1]}`) main(resolve(process.argv[2] ?? process.cwd()))
