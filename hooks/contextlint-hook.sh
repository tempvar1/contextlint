#!/bin/sh
# SessionStart entry point.
#
# Hooks run in a non-interactive shell that never sources the user's profile,
# so an nvm-managed node is not on PATH — calling bare `node` fails every
# session for anyone whose only node comes from nvm. Try PATH first, then the
# usual install locations, then nvm's and volta's.
#
# Uses only shell builtins and globs, no ls/tail, so it still works when PATH
# itself is bare. Each candidate is checked for a node new enough to have
# util.parseArgs (18.3+) rather than trusting glob order: nvm directories sort
# lexically, so v10 would otherwise win over v20.
#
# If nothing suitable is found, exit 0 without printing. A hook that errors on
# every session is worse than one that quietly does nothing — this tool exists
# to keep noise out of the context and does not get an exception for itself.

for node in \
  "$(command -v node 2>/dev/null)" \
  /usr/local/bin/node \
  /opt/homebrew/bin/node \
  /usr/bin/node \
  "$HOME"/.nvm/versions/node/*/bin/node \
  "$HOME"/.volta/tools/image/node/*/bin/node
do
  [ -x "$node" ] || continue
  "$node" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>18||(a===18&&b>=3)?0:1)' 2>/dev/null || continue
  exec "$node" "$CLAUDE_PLUGIN_ROOT/bin/contextlint.js" --if-due "$@"
done

exit 0
