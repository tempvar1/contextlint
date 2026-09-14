import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { measure, estimateTokens, sectionsByLine, findCandidates, readHooks, readPlugins, ruleKey, isDue, readSettings } from '../bin/contextlint.js'

const BIN = fileURLToPath(new URL('../bin/contextlint.js', import.meta.url))

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
  const cfg = mkdtempSync(join(tmpdir(), 'contextlint-cfg-'))
  mkdirSync(join(dir, '.claude'))
  writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash(git commit*)', hooks: [{ type: 'command', command: 'guard.sh' }] }] },
    permissions: { deny: ['Read(.env)'] },
  }))

  const { hooks, deny } = readHooks(dir, cfg)

  assert.deepEqual(hooks, [{ event: 'PreToolUse', matcher: 'Bash(git commit*)', commands: ['guard.sh'] }])
  assert.deepEqual(deny, ['Read(.env)'])
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

test('isDue is false until the configured interval has passed', () => {
  const config = { minHoursBetweenRuns: 24 }
  const now = Date.parse('2026-09-04T12:00:00Z')

  assert.equal(isDue([], config, now), true, 'no previous run')
  assert.equal(isDue([{ date: '2026-09-04T02:00:00Z' }], config, now), false, '10h ago')
  assert.equal(isDue([{ date: '2026-09-03T11:00:00Z' }], config, now), true, '25h ago')
})

test('--if-due prints nothing at all when there is nothing to act on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextlint-'))
  writeFileSync(join(dir, 'CLAUDE.md'), '# Tiny\n\n- one rule\n')

  const out = execFileSync('node', [BIN, dir, '--if-due'], { encoding: 'utf8' })

  assert.equal(out, '', 'a hook that greets you every session is the waste this tool exists to find')
})

test('--if-due prints nothing in a repo that has no CLAUDE.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextlint-'))

  const out = execFileSync('node', [BIN, dir, '--if-due'], { encoding: 'utf8' })

  assert.equal(out, '')
})

test('--if-due stays silent on a second run inside the interval', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextlint-'))
  writeFileSync(join(dir, 'CLAUDE.md'), '# Rules\n\n' + Array.from({ length: 120 }, (_, i) => `- rule ${i}: padded out with enough words to carry this fixture clear of the 1,500-token floor`).join('\n'))

  const first = execFileSync('node', [BIN, dir, '--if-due'], { encoding: 'utf8' })
  const second = execFileSync('node', [BIN, dir, '--if-due'], { encoding: 'utf8' })

  assert.match(first, /^contextlint: \d+ new rules? in the always-on block/, 'first run is over the floor and has no history, so it reports')
  assert.equal(second, '', 'second run is inside the 24h interval')
})

test('readSettings merges user, project and local, project winning on enabledPlugins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextlint-'))
  const cfg = mkdtempSync(join(tmpdir(), 'contextlint-cfg-'))
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({
    enabledPlugins: { 'a@m': true, 'b@m': true },
    hooks: { PreToolUse: [{ matcher: 'user', hooks: [{ command: 'u' }] }] },
    permissions: { deny: ['Read(.env)'] },
  }))
  mkdirSync(join(dir, '.claude'))
  writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({
    enabledPlugins: { 'b@m': false },
    hooks: { PreToolUse: [{ matcher: 'project', hooks: [{ command: 'p' }] }] },
    permissions: { deny: ['Read(.env)', 'Write(/etc/**)'] },
  }))

  const merged = readSettings(dir, cfg)

  assert.deepEqual(merged.enabledPlugins, { 'a@m': true, 'b@m': false }, 'project scope wins')
  assert.deepEqual(merged.hooks.PreToolUse.map((h) => h.matcher), ['user', 'project'], 'hooks accumulate, both fire')
  assert.deepEqual(merged.deny, ['Read(.env)', 'Write(/etc/**)'], 'deny rules accumulate and dedupe')
})

test('readPlugins finds a user-scope plugin with nothing in the project settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextlint-'))
  const cfg = mkdtempSync(join(tmpdir(), 'contextlint-cfg-'))
  const installPath = join(cfg, 'plug', '1.0.0')
  mkdirSync(installPath, { recursive: true })
  mkdirSync(join(cfg, 'plugins'), { recursive: true })
  writeFileSync(join(cfg, 'plugins/installed_plugins.json'), JSON.stringify({
    plugins: { 'plug@market': [{ installPath, version: '1.0.0' }] },
  }))
  // User scope only — this is what `claude plugin install` produces by default.
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ enabledPlugins: { 'plug@market': true } }))
  mkdirSync(join(dir, '.claude'))
  writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({ hooks: {}, permissions: {} }))

  assert.deepEqual(readPlugins(dir, cfg).map((p) => p.version), ['1.0.0'])
})

test('under the floor it writes no state directory at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextlint-'))
  writeFileSync(join(dir, 'CLAUDE.md'), '# Tiny\n\n- one rule\n')

  execFileSync('node', [BIN, dir], { encoding: 'utf8' })

  assert.equal(existsSync(join(dir, '.contextlint')), false, 'a tool that stays out of the way leaves nothing behind')
})

test('the state directory ignores itself when it is created', () => {
  const dir = mkdtempSync(join(tmpdir(), 'contextlint-'))
  writeFileSync(join(dir, 'CLAUDE.md'), '# Rules\n\n' + Array.from({ length: 120 }, (_, i) => `- rule ${i}: padded out with enough words to carry this fixture clear of the 1,500-token floor`).join('\n'))

  execFileSync('node', [BIN, dir], { encoding: 'utf8' })

  assert.equal(readFileSync(join(dir, '.contextlint/.gitignore'), 'utf8'), '*\n')
})
