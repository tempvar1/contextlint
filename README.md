# contextlint

Keeps a project's **always-on** Claude instructions from growing without bound.

Everything in `CLAUDE.md` and the files it `@`-imports is re-sent on every single
message. It is the one block that never gets skipped, so it is the one block
where size actually costs something — not in money (prompt caching handles that)
but in attention. A rule buried on line 380 of a block nobody re-reads is a rule
that quietly stops being followed.

This tool measures that block, tracks it over time, and — from v0.3 — proposes
where each rule should have gone instead: a hook, a skill, a knowledge file, or
genuinely always-on.

It **proposes**. It never edits your instruction files, and it never touches hooks.

## Install

```bash
claude plugin marketplace add tempvar1/contextlint
claude plugin install contextlint@contextlint
```

`claude plugin install` defaults to user scope, so it applies to every project
you open. The SessionStart hook then runs it once a day per repo.

## Use

Installed as a plugin, it runs on its own: a SessionStart hook runs it once every
24 hours, and **it prints nothing unless there is something to act on**. When
there is, one line appears:

```
contextlint: 10 new rules in the always-on block (5384 tokens). Run /contextlint to classify.
```

`/contextlint` then runs the script and classifies what it finds.

Directly, without the plugin:

```
node bin/contextlint.js /path/to/repo     # measure and report
node bin/contextlint.js --if-due          # what the hook runs: silent unless due and actionable
```

Defaults to the current directory. Writes `.contextlint/` in the target repo,
which ignores itself — the directory is created with a `.gitignore` containing
`*`, so nothing here ever needs adding to yours. Under the token floor it writes
nothing at all, not even a log.

## Status — v0.4.1

Complete. Runs itself once a day from a SessionStart hook, or on demand with
`/contextlint`.

| Version | What it adds |
|---------|--------------|
| v0.1 | Resolve the always-on block, measure it, log it, check the floor |
| v0.2 | Report which rules were added since the last run (`git diff`) |
| v0.3 | Classify each new rule: hook / skill / knowledge / keep |
| **v0.4** | SessionStart trigger and `/contextlint` |

Each version is useful on its own.

## Config

`.contextlint/config.json` in the target repo, all keys optional:

```json
{ "floorTokens": 1500 }
```

Below the floor, the bot does nothing — a small instruction block is not a
problem worth a tool.

## Classifying

Past the growth threshold, the script writes `.contextlint/dossier.json`: the
candidate rules, every hook matcher and deny rule in the target's
`settings.json`, and every enabled plugin with its installed version and skill
descriptions. Facts only — no opinions.

The `contextlint` skill reads that dossier and sorts each rule into one of five
buckets, then writes `.contextlint/report.md`:

| Bucket | Meaning |
|--------|---------|
| DELETE | one of your own hooks already enforces it |
| MOVE — plugin | an installed plugin already says it |
| MOVE — skill | it belongs to one activity |
| MOVE — knowledge | it belongs to one repo or topic |
| KEEP | general judgement, no reliable trigger |

Two asymmetries the skill is built around. A hook that *looks* like it covers a
rule may not fire — so a `DELETE` has to prove the hook matches the realistic
ways of doing the thing, or it is not a `DELETE`. And a plugin can change under
you, so anything a plugin covers is **moved, never deleted**: moving saves the
same tokens and keeps a copy you can put back.

A proposal you decline goes in `.contextlint/ignore.json` as
`[{ "rule": "<key from dossier candidates[].key>", "reason": "..." }]` and is not
raised again.

## Notes on the hook

Hooks run in a non-interactive shell with no profile sourced, so an nvm-managed
node is not on `PATH`. `hooks/contextlint-hook.sh` resolves a node itself —
`PATH` first, then the usual install locations, then nvm's and volta's — using
only shell builtins so it works even when `PATH` is bare, and skipping any node
older than 18.3 (which lacks `util.parseArgs`). If it finds none it exits 0
silently.

Settings are read as the merge of `~/.claude/settings.json`,
`<repo>/.claude/settings.json` and `settings.local.json`. `claude plugin install`
writes to user scope by default, so reading only the project file reports zero
plugins in almost every repo — and a user-level hook enforces things just as
much as a project one. When an inventory does come back empty the dossier says
so in `inventoryGaps`, because "no plugins listed" must never be read as "no
plugin covers this rule".

## Why the hook is silent

Hook *definitions* never enter the context. Hook *output* does, on every session
that fires it. A hook that prints on success is a small permanent tax — the same
kind of waste contextlint exists to find, in a different file. So `--if-due`
returns without printing when the interval has not elapsed, when the block is
under the floor, when nothing was added, and in any repo with no `CLAUDE.md` at
all. Four tests hold it to that.

## Design

`bin/contextlint.js` does the mechanical half: resolve, measure, diff, gather. It is
deterministic, dependency-free, and never calls a model. From v0.3 a skill reads
its output and makes the judgement calls. That split is deliberate — the cheap
half runs every day, the expensive half only when there is something to judge.

Token counts are `characters / 4`. That under-counts markdown tables and code,
so treat every number here as a floor.
