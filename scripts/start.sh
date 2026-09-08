#!/usr/bin/env bash
# What pm2 runs for the "nest" app (see ecosystem.config.cjs).
#
# Builds the client, then starts the server, so a bare `pm2 restart nest`
# is always a full deploy. The server stamps itself from git at startup and
# the page is stamped at build time; doing both here, back to back, keeps
# the two in step so VersionBanner never reports a false drift.
#
# The build goes to a staging dir and is swapped in only on success: a
# broken build keeps the previous dist serving rather than taking the
# server down with it.

set -u
cd "$(dirname "$0")/.."

STAGE=dist.next
if npx vite build --outDir "$STAGE" --emptyOutDir; then
  rm -rf dist && mv "$STAGE" dist
else
  echo "[start] client build failed; serving the previous dist" >&2
  rm -rf "$STAGE"
fi

exec ./node_modules/.bin/tsx src/server/index.ts
