#!/usr/bin/env bash
# Print the access token a browser needs to log in to Foray. This is what
# `npm run token` runs.
#
# The server reads FORAY_TOKEN from its environment, or else the file
# ~/.foray/token, which it creates on first start. FORAY_TOKEN_FILE moves
# that file; the server reads the same variable, so this prints the token
# it actually accepts. To rotate the token (which logs every device out):
# delete the file and run `npm run deploy`, or write a new one with
# `(umask 077; openssl rand -base64 32 > ~/.foray/token)` -- the umask is
# why that runs in a subshell: a plain `>` creates the file readable by
# every account on the machine.
# Run this as the user Foray runs as.

set -eu

FILE="${FORAY_TOKEN_FILE:-$HOME/.foray/token}"

if [ -n "${FORAY_TOKEN:-}" ]; then
  echo "$FORAY_TOKEN"
  echo "(from FORAY_TOKEN in this shell; the server's own environment may differ)" >&2
  exit 0
fi

if [ ! -f "$FILE" ]; then
  echo "No token yet at $FILE: the server writes one on its first start (npm run deploy)." >&2
  exit 1
fi

cat "$FILE"
