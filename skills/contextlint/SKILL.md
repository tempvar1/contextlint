---
name: contextlint
description: >
  Classify the rules contextlint found in a project's always-on instruction
  block — the rules added since the last run — into delete, move, or keep, and
  write a report. Use when the user runs contextlint and it names a dossier, or
  says "classify these rules", "where should this rule live", "audit my
  CLAUDE.md", "my rules file is too big", or asks why an instruction keeps being
  missed. Proposes only; never edits instruction files and never edits hooks.
---

# contextlint — classifying rules

`bin/contextlint.js` has already done the mechanical half and written a dossier.
Your job is the half a script cannot do: decide where each rule it found should
actually live.

## The principle

**A rule should be loaded when it's needed and absent when it isn't.**

Everything in `CLAUDE.md` and its `@`-imports is re-sent on every message. That
block does not cost much money — prompt caching handles that — it costs
*attention*. Every rule in it competes with every other rule on every turn,
relevant or not. A rule about test naming is arguing for attention during a
documentation task.

So there are four places a rule can live, cheapest first:

| Tier | Cost per message | Can it be missed? |
|------|-----------------|-------------------|
| Hook | none | no — it runs as code |
| Skill | none until invoked | only if the skill doesn't trigger |
| Knowledge file | none until read | yes, depends on judgement |
| Always-on | every message, forever | yes, and more so as the block grows |

Always-on is the last resort, not the default.

## Steps

1. **Read the dossier.** Default path `.contextlint/dossier.json` in the target
   repo; the script prints the exact path. It holds the candidate rules, the
   hook inventory, the deny list, and every enabled plugin with its version and
   skill descriptions.
2. **Read the always-on files themselves** — the dossier lists their paths, not
   their text. You need the surrounding context to judge a rule fairly.
3. **Classify each candidate** into exactly one bucket (below).
4. **Write the report** to `.contextlint/report.md`. Nothing else.

## The buckets

| Bucket | Test that must pass | Action proposed |
|--------|--------------------|-----------------|
| **DELETE** | A hook **in this repo** already enforces it, and you have checked the matcher actually fires | Remove the prose, leave a pointer to `settings.json` |
| **MOVE — plugin** | An installed plugin already says it | Move to a knowledge file, recording plugin **and version** |
| **MOVE — skill** | It belongs to one activity that has a skill | Move into that skill; say whether its description is specific enough to trigger |
| **MOVE — knowledge** | It belongs to one repo or one topic | Move to a knowledge file, leave a one-line pointer |
| **KEEP** | General judgement with no reliable trigger | Leave it alone |

When you cannot tell, the answer is **KEEP**. A rule left in the wrong place
costs attention; a rule moved wrongly can vanish silently. Those are not
symmetrical.

## The rules you must not break

**1. Never apply anything.** You propose. A person approves. Do not edit
`CLAUDE.md`, the rules files, or anything the dossier describes.

**2. Never edit hooks.** Hooks are executable code that can block work. Report a
problem with one; never rewrite it.

**3. Prove a hook fires before proposing DELETE.** This is the one that matters.
A matcher that *looks* like it covers a rule may not fire — `Bash(git -C *
commit*)` does not match `cd path && git commit`. If you cannot show the hook
fires for the realistic ways of doing the thing, the bucket is not DELETE. Say
what the gap is:

```markdown
### Rule: "Never commit directly to a base branch"
Found in: .claude/rules/git-conventions.md:12
Bucket:   DELETE
Because:  settings.json PreToolUse Bash(git -C * commit*) already blocks this
Caution:  that hook does not match `cd <path> && git commit`. Fix the hook
          before deleting the prose, or the protection disappears entirely.
```

That caution line is the difference between a useful tool and one that quietly
removes a safety net.

**4. Move what a plugin covers — never delete it.** You do not control plugins
and they update themselves (ponytail has `autoUpdate: true`). Delete your copy
and the plugin later drops that advice, and nothing tells you. Moving saves
exactly as much and keeps a copy you can put back. Record the reason where it
can be re-checked:

```markdown
<!-- moved because: plugin ponytail 4.8.4 already covers this -->
```

**5. Never drop a rule silently.** If a plugin says something close but not
identical, say so and let the user choose — do not skip it. Similar-sounding
rules often do different jobs: ponytail's "deletion over addition" is about how
little to write; "don't delete dead code you didn't touch" is about what not to
touch. They pull in opposite directions.

**6. Never add to the always-on block.** Your report, and everything else
contextlint produces, lives in `.contextlint/`, which nothing loads. A linter
that adds weight to the thing it is measuring has failed.

## Your blind spot, and say so in the report

Claude's own built-in instructions are not files on disk. You cannot read them,
so you cannot detect that a rule duplicates them — safety guidance and prompt
injection rules are the usual cases. Flag anything that smells like it, and mark
it as a human judgement rather than a finding.

## Report format

Write `.contextlint/report.md`: a one-paragraph summary, then one section per
candidate in the format shown above (rule, location, bucket, because, caution
where relevant). End with what the user does next, including that a proposal
they reject can be added to `.contextlint/ignore.json` as
`[{ "rule": "<key>", "reason": "..." }]` so it is not raised again.
