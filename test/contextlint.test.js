import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { measure, estimateTokens, sectionsByLine, findCandidates } from '../bin/contextlint.js'

test('measure follows nested @-imports and skips cycles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextlint-'))
  mkdirSync(join(dir, 'rules'))
  writeFileSync(join(dir, 'CLAUDE.md'), 'root\n@rules/a.md\n')
  writeFileSync(join(dir, 'rules/a.md'), 'a\n@b.md\n')
  writeFileSync(join(dir, 'rules/b.md'), 'b\n@../CLAUDE.md\n') // cycle back

  const { files, totalTokens } = measure(dir)

  assert.deepEqual(files.map((f) => f.path), ['CLAUDE.md', 'rules/a.md', 'rules/b.md'])
  assert.equal(totalTokens, files.reduce((n, f) => n + estimateTokens('x'.repeat(f.chars)), 0))
})

test('sectionsByLine tracks nested heading paths', () => {
  const sections = sectionsByLine('# Rules\ntext\n## 5. Simplicity\nbullet\n# Other\nx\n')
  assert.deepEqual(sections, ['Rules', 'Rules', 'Rules > 5. Simplicity', 'Rules > 5. Simplicity', 'Other', 'Other', 'Other'])
})

test('findCandidates reports only rules added since the logged commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextlint-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't')

  writeFileSync(join(dir, 'CLAUDE.md'), '# Rules\n\n## Git\n- old rule\n')
  git('add', '-A'); git('commit', '-qm', 'first')
  const previous = { commit: git('rev-parse', 'HEAD').trim(), files: measure(dir).files.map(({ text, ...f }) => f) }

  writeFileSync(join(dir, 'CLAUDE.md'), '# Rules\n\n## Git\n- old rule\n- new rule\n')
  const { mode, rules } = findCandidates(dir, measure(dir).files, previous)

  assert.equal(mode, 'diff')
  assert.deepEqual(rules, [{ file: 'CLAUDE.md', line: 5, endLine: 5, section: 'Rules > Git', text: '- new rule' }])
})

test('findCandidates treats the first run as a full audit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextlint-'))
  writeFileSync(join(dir, 'CLAUDE.md'), '# Rules\n\n- a\n- b\n')
  const { mode, rules } = findCandidates(dir, measure(dir).files, undefined)

  assert.equal(mode, 'full')
  assert.deepEqual(rules.map((r) => r.text), ['- a\n- b'])
})
