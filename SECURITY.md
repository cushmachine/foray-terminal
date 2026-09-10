# Security

Foray is a shell on the machine it runs on. Everything a session can do,
whoever reaches Foray can do. This page says what stands between the
network and that shell, what does not, and how to run it so the gap is as
small as it can be.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Email the
maintainer at the address on the GitHub profile, or use GitHub's private
vulnerability reporting on this repository. You will get a reply within a
few days.

## What protects you

**An access token, required for everything that does anything.** The
server generates one on first start (`~/.foray/token`, owner-only; or set
`FORAY_TOKEN`). A browser presents it once on the login screen and holds a
cookie from then on. Every WebSocket upgrade and every upload is refused
without that cookie or the token itself. Print the token with
`npm run token`; rotate it by replacing the file and redeploying, which
logs every device out.

**The cookie cannot leave the page or be sent by another site.** It is
`HttpOnly` (script cannot read it), `SameSite=Strict` (a page on another
origin cannot make the browser send it), and `Secure` when served over
HTTPS. It is signed with a key derived from the token and expires after 30
days of no use. A stolen cookie is a stolen token until you rotate the
token; there is no per-device revocation.

**Cross-site requests are refused outright.** A browser page from any
other origin that opens the WebSocket or posts to the API is turned away
by its `Origin` header before credentials are looked at. This is what
stops a web page you happen to visit from driving your terminal through
your own browser's position on the network.

**Brute force is slowed.** After five wrong tokens from one address, each
further attempt from it waits, doubling up to fifteen minutes. Behind
`tailscale serve` the address is the one Tailscale forwards, so one peer's
guessing does not lock out another. The token has 256 bits of entropy.

**Browser-side hardening.** Every response carries a Content Security
Policy (same-origin scripts only, no framing, no plugins), `X-Frame-Options:
DENY`, `Referrer-Policy: no-referrer` (a link you open from a terminal does
not learn Foray's address), `X-Content-Type-Options: nosniff`, and HSTS
over HTTPS. Links opened from terminal output get `noopener noreferrer`.

**Terminal output is text, never markup.** Scrollback is rendered through
an ANSI converter that escapes everything and drops OSC sequences; the
file panel renders markdown as text without HTML or links.

**Programs cannot read your clipboard, and can set it only as you type.**
The OSC 52 clipboard sequence is a real feature (yank in vim lands on your
phone's clipboard) and a real attack (a file an agent reads plants a
command for you to paste later). Foray answers reads with nothing and
honours writes only within five seconds of your own keystroke, up to 64 KB.

**The server cannot be flooded by one client.** WebSocket frames are
capped at 2 MiB, terminal input at 256 KB, file writes at 1 MiB,
terminals per connection at 16, and connections at 64. The file panel
refuses to open the filesystem root or the kernel's `/proc`, `/sys`,
`/dev` and `/run`.

**Client input never reaches a shell as syntax.** tmux is run with an
argument list, never a shell string; session names are prefixed and
scrubbed of tmux target characters; a past session is revived only by an
id matching its agent's format, with every argument quoted.

**Errors say nothing about the server.** A client sees the message of an
error written for it, or a generic one; paths, tmux output and stack
traces stay in the log.

## What does not protect you

**Whoever holds the token has a shell as the user Foray runs as.** There
are no roles, no per-session permissions, and no audit trail beyond the
login log. Treat the token like an SSH key.

**Plain HTTP is plain.** Over a Tailscale network the WireGuard tunnel
encrypts everything, so `http://host:3000` is private on the wire. On a
LAN or the open internet it is not: terminal I/O, prompts and file
contents cross in the clear, and the cookie is exposed to anyone on the
path. Use `tailscale serve` (HTTPS with a real certificate) or another TLS
proxy for anything but a tailnet.

**Running as root multiplies every mistake.** The default Linux install
runs pm2, the server and every session as the user who ran `install.sh`.
If that is root, every session is a root shell and the token guards the
whole machine. `install.sh` refuses to continue as root without an
explicit "yes" (or `FORAY_ALLOW_ROOT=1` off a terminal) — treat that
prompt as your cue to stop and create a dedicated user instead (below).

**The file panel follows the session.** It opens whatever directory the
session is in, which the session can change with `cd`. This is by design:
the terminal in the same session already has that access.

**A hostile program in a session is a hostile program.** Foray keeps it
from escaping into your browser and clipboard; it does not keep it from
doing what the shell allows. That is the agent's sandbox to provide, not
Foray's.

**Existing tmux sessions.** Foray runs its own tmux server, on its own
socket (`FORAY_TMUX_SOCKET`, default `foray`; look with `tmux -L foray
ls`), so it never adopts or shows sessions from a tmux server you already
run. Its own sessions are named `foray_*`. On Linux that server lives in
its own systemd unit, `foray-tmux.service`, so it survives deploys; see
DEPLOY.md. On a box installed before the rename, Foray still shares the
machine's default tmux socket (`nest_*` sessions, plain `tmux ls`) in
`nest-tmux.service` — that box keeps `FORAY_TMUX_SOCKET` empty on purpose
until every session on it has been closed or resumed.

## Recommended deployment

1. **A dedicated user.** Create `foray`, install as that user, and let the
   sessions run as it. On Linux, the tmux-unit setup
   (`scripts/ensure-tmux-unit.sh`, run automatically by `npm run deploy`)
   generates the systemd unit's `User=`, `Group=` and working directory for
   whichever account runs it, so sessions run as that user, not root, with
   nothing to edit by hand. Give the user `sudo` only if you need it inside
   sessions.
2. **Bind to loopback and serve over Tailscale HTTPS.** `ecosystem.config.cjs`
   already sets `HOST: '127.0.0.1'`; `install.sh` runs
   `tailscale serve --bg 3000` for you when it can, or prints the command.
   Foray is then reachable only through the Tailscale proxy, over TLS, by
   devices on your tailnet.
3. **Pin the host name.** Set `FORAY_ALLOWED_HOSTS` to the names you use
   (`<server>.<tailnet>.ts.net,<server>`). Requests for any other name are refused
   with 421, which closes DNS rebinding independently of the cookie.
4. **Keep the token out of the environment where you can.** The file is
   simplest; if you set `FORAY_TOKEN`, know that anything that can read
   the server process's environment can read it, and that pm2 records
   the environment it was started with in `~/.pm2/dump.pm2`. Foray strips
   `FORAY_*` from the environment it hands to tmux and to sessions.
5. **One host name per Foray.** Browsers send a cookie to every port on
   a host name, so a cookie set by `http://host:3000` also reaches any
   other web service you run on `host`. The `*.ts.net` name is Foray's
   alone; prefer it.
6. **Any other reverse proxy must pass the host through.** The Origin
   check compares against `Host` or `X-Forwarded-Host`; a proxy that
   rewrites `Host` to `127.0.0.1:3000` and forwards neither gets every
   socket refused with 403 (the log line names both values).
7. **Firewall the port.** Even with the token, a port reachable from the
   internet invites brute-force noise. Tailscale, `ufw`, or a cloud
   security group.

## Turning authentication off

`FORAY_AUTH=off` disables the token and the login screen. The server
refuses to start that way unless `HOST` is a loopback address, so the
only way to run without a token is to make the port unreachable from any
other machine. Do this for local development only.

## Configuration reference

| Variable | Meaning |
| --- | --- |
| `FORAY_TOKEN` | The access token. Overrides the token file. At least 16 characters. |
| `~/.foray/token` | Where the token lives otherwise; created on first start, mode 0600. |
| `FORAY_AUTH=off` | No authentication. Only with `HOST=127.0.0.1` or `::1`. |
| `FORAY_ALLOWED_HOSTS` | Comma-separated host names requests may use. Empty means any. |
| `HOST` | Interface to listen on. Empty means every interface. |
| `PORT` | Port, default 3000. |

## Audit history

- 2026-09-10: full review before the first public release (network
  exposure, WebSocket protocol, filesystem access, client rendering,
  installation and privileges). Authentication, origin checks, security
  headers, payload caps, clipboard guarding and the symlink-safe file
  write date from it.
