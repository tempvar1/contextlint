import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measure, estimateTokens } from '../bin/contextlint.js'

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
