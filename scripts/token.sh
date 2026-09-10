#!/usr/bin/env bash
# Print the access token a browser needs to log in to Foray. This is what
# `npm run token` runs.
#
# The server reads FORAY_TOKEN from its environment, or else the file
# ~/.foray/token, which it creates on first start. To rotate the token
# (which logs every device out): delete the file and run `npm run deploy`,
# or write a new one with `openssl rand -base64 32 > ~/.foray/token`.
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
