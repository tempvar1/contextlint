import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { measure, estimateTokens, sectionsByLine, findCandidates, readHooks, readPlugins, ruleKey } from '../bin/contextlint.js'

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
  assert.deepEqual(rules.map((r) => r.text), ['- a', '- b'])
})

test('readHooks lists every matcher and the deny list, without judging them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextlint-'))
  mkdirSync(join(dir, '.claude'))
  writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash(git commit*)', hooks: [{ type: 'command', command: 'guard.sh' }] }] },
    permissions: { deny: ['Read(.env)'] },
  }))

  assert.deepEqual(readHooks(dir), {
    hooks: [{ event: 'PreToolUse', matcher: 'Bash(git commit*)', commands: ['guard.sh'] }],
    deny: ['Read(.env)'],
  })
})

test('readPlugins resolves enabled plugins to their installed version and skills', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextlint-'))
  const cfg = mkdtempSync(join(tmpdir(), 'contextlint-cfg-'))
  const installPath = join(cfg, 'plug', '2.1.0')
  mkdirSync(join(installPath, 'skills', 'be-lazy'), { recursive: true })
  writeFileSync(join(installPath, 'skills/be-lazy/SKILL.md'), '---\nname: be-lazy\ndescription: >\n  Write the least\n  code that works.\n---\nbody\n')
  writeFileSync(join(installPath, 'AGENTS.md'), 'always on\n')
  mkdirSync(join(cfg, 'plugins'), { recursive: true })
  writeFileSync(join(cfg, 'plugins/installed_plugins.json'), JSON.stringify({
    plugins: { 'plug@market': [{ installPath, version: '2.1.0' }] },
  }))
  mkdirSync(join(dir, '.claude'))
  writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'plug@market': true, 'off@market': false } }))

  const plugins = readPlugins(dir, cfg)

  assert.equal(plugins.length, 1)
  assert.equal(plugins[0].version, '2.1.0')
  assert.deepEqual(plugins[0].instructionFiles, ['AGENTS.md'])
  assert.deepEqual(plugins[0].skills.map((s) => s.description), ['Write the least code that works.'])
})

test('readPlugins flags an enabled plugin that is not installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextlint-'))
  const cfg = mkdtempSync(join(tmpdir(), 'contextlint-cfg-'))
  mkdirSync(join(dir, '.claude'))
  writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'gone@market': true } }))

  assert.deepEqual(readPlugins(dir, cfg), [{ id: 'gone@market', version: null, path: null, missing: true }])
})

test('ruleKey is stable for the same rule and differs when the text changes', () => {
  const rule = { file: 'CLAUDE.md', section: 'Rules', text: '- a' }
  assert.equal(ruleKey(rule), ruleKey({ ...rule }))
  assert.notEqual(ruleKey(rule), ruleKey({ ...rule, text: '- b' }))
})

test('each list item is its own rule, but wrapped continuation lines are not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextlint-'))
  writeFileSync(join(dir, 'CLAUDE.md'), '# Rules\n\n- first rule\n  wrapped onto a second line\n- second rule\n')

  const { rules } = findCandidates(dir, measure(dir).files, undefined)

  assert.deepEqual(rules.map((r) => r.text), ['- first rule\n  wrapped onto a second line', '- second rule'])
})

test('readPlugins picks the live install, not the stale one an auto-update left behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextlint-'))
  const cfg = mkdtempSync(join(tmpdir(), 'contextlint-cfg-'))
  const live = join(cfg, 'plug', '4.9.0')
  mkdirSync(live, { recursive: true })
  mkdirSync(join(cfg, 'plugins'), { recursive: true })
  writeFileSync(join(cfg, 'plugins/installed_plugins.json'), JSON.stringify({
    plugins: {
      'plug@market': [
        { installPath: join(cfg, 'plug', '4.8.4'), version: '4.8.4', lastUpdated: '2026-01-01T00:00:00Z' },
        { installPath: live, version: '4.9.0', lastUpdated: '2026-09-04T00:00:00Z' },
      ],
    },
  }))
  mkdirSync(join(dir, '.claude'))
  writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'plug@market': true } }))

  assert.equal(readPlugins(dir, cfg)[0].version, '4.9.0')
})
