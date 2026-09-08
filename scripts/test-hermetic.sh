#!/usr/bin/env bash
# Hermetic-suite eval: run the unit suite with a `tmux` on PATH that only
# logs its argv and fails. The suite must still pass (server tests use the
# in-memory fake from src/server/__tests__/helpers.ts) and the log must stay
# empty: in particular no attach-session, which would mean a test attached
# a real pty to someone's live session.
#
# Usage: scripts/test-hermetic.sh
set -euo pipefail
cd "$(dirname "$0")/.."

bin=$(mktemp -d)
trap 'rm -rf "$bin"' EXIT
log="$bin/tmux.log"
cat > "$bin/tmux" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$log"
exit 1
EOF
chmod +x "$bin/tmux"
: > "$log"

PATH="$bin:$PATH" npm run test

if grep -q attach-session "$log"; then
  echo "test-hermetic: FAIL, a test attached a real pty:" >&2
  grep attach-session "$log" >&2
  exit 1
fi
if [ -s "$log" ]; then
  echo "test-hermetic: FAIL, tmux was invoked $(wc -l < "$log") time(s):" >&2
  cat "$log" >&2
  exit 1
fi
echo "test-hermetic: ok, tmux was never invoked"
