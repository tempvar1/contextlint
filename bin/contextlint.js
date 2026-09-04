#!/usr/bin/env node
// v0.1 — measure the always-on instruction block and log its size over time.
// Reports only. Never edits the target repo's instruction files.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

const DEFAULTS = { floorTokens: 1500 }
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

const headCommit = (dir) => {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch { return null }
}

export function measure(targetDir) {
  const files = alwaysOnFiles(targetDir).map((f) => ({
    path: relative(targetDir, f.path),
    chars: f.text.length,
    lines: f.text.split('\n').length,
    tokens: estimateTokens(f.text),
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

  const { files, totalTokens } = measure(targetDir)
  const previous = log.at(-1)

  mkdirSync(stateDir, { recursive: true })
  log.push({
    date: new Date().toISOString(),
    commit: headCommit(targetDir),
    totalTokens,
    files,
  })
  writeFileSync(logPath, JSON.stringify(log, null, 2) + '\n')

  const width = Math.max(...files.map((f) => f.path.length))
  for (const f of files) {
    console.log(`  ${f.path.padEnd(width)}  ${String(f.lines).padStart(5)} lines  ${String(f.tokens).padStart(6)} tokens`)
  }
  console.log(`  ${''.padEnd(width, '-')}  ${''.padStart(5, '-')}        ${''.padStart(6, '-')}`)
  console.log(`  ${'total'.padEnd(width)}  ${String(files.reduce((n, f) => n + f.lines, 0)).padStart(5)} lines  ${String(totalTokens).padStart(6)} tokens`)

  if (previous) {
    const delta = totalTokens - previous.totalTokens
    console.log(`\n  since ${previous.date.slice(0, 10)}: ${delta >= 0 ? '+' : ''}${delta} tokens`)
  }

  console.log(
    totalTokens < config.floorTokens
      ? `\nUnder the ${config.floorTokens}-token floor. Nothing to do.`
      : `\nOver the ${config.floorTokens}-token floor. Change detection is v0.2.`
  )
}

if (import.meta.url === `file://${process.argv[1]}`) main(resolve(process.argv[2] ?? process.cwd()))
