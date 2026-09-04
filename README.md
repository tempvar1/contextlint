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

## Use

```
node bin/contextlint.js /path/to/repo
```

Defaults to the current directory. Writes `.contextlint/log.json` in the target
repo — add `.contextlint/` to that repo's `.gitignore`.

## Status — v0.3

Measure, log, report which rules were added since the last run, and gather the
context needed to classify them.

| Version | What it adds |
|---------|--------------|
| v0.1 | Resolve the always-on block, measure it, log it, check the floor |
| v0.2 | Report which rules were added since the last run (`git diff`) |
| **v0.3** | Classify each new rule: hook / skill / knowledge / keep |
| v0.4 | SessionStart trigger and slash command |

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

## Design

`bin/contextlint.js` does the mechanical half: resolve, measure, diff, gather. It is
deterministic, dependency-free, and never calls a model. From v0.3 a skill reads
its output and makes the judgement calls. That split is deliberate — the cheap
half runs every day, the expensive half only when there is something to judge.

Token counts are `characters / 4`. That under-counts markdown tables and code,
so treat every number here as a floor.
