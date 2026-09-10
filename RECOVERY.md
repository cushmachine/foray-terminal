# Recovery

You are here because you cannot get into Foray. Nothing is lost: your
sessions live in tmux on the server and keep running whether or not you
can reach them. This page is meant to be readable when Foray itself is
not; open it on GitHub, or open a Claude Code session in this repo on
your laptop and say "walk me through RECOVERY.md".

## I can still open Foray on one device

Open any session there and run:

```bash
cd ~/foray && npm run token
```

(Use whatever directory you installed into, if not the default.) Paste
the token into the login screen on the other device. Save it in your
password manager this time.

## No device is logged in

You need a terminal on the server that does not go through Foray.

**Over Tailscale SSH, from your laptop** (the usual way):

```bash
ssh <user>@<server>
```

Use the server's tailnet name and the user Foray runs as. If SSH is
refused, use the hosting provider's web console instead; every provider
has one (Hetzner "Console", DigitalOcean "Recovery Console", and so on).

Once you have a shell:

```bash
cat ~/.foray/token
```

If that file is missing, Foray makes a new one the next time it starts:

```bash
cd ~/foray && npm run deploy && npm run token
```

## I want a new token

Anywhere you have a shell on the server:

```bash
openssl rand -base64 32 > ~/.foray/token
cd ~/foray && npm run deploy
npm run token
```

Every device is logged out and needs the new token once.

## Login says "too many attempts"

Wait the number of seconds it shows (at most 15 minutes) and try again.
Devices already logged in are not affected.

## The login screen does not appear, or the page says it cannot reach Foray

That is not the token. Check the server is up:

```bash
pm2 status
pm2 logs nest --lines 50
```

And that Tailscale is serving it (`tailscale serve status`). See
DEPLOY.md.

## Sessions are missing after a restart

They are in tmux, which runs separately from Foray. From a server shell,
`tmux ls` lists them. On Linux they live in `nest-tmux.service`; see
CLAUDE.md for what never to do to it.
