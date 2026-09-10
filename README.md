# Foray

Foray is a browser terminal, backed by tmux sessions on a server you run, built for checking on and driving coding agents like Claude Code from your phone.

<img src="docs/img/desktop.png" alt="Foray's desktop view: a sidebar listing tmux sessions next to a terminal with a live shell" width="100%">

<img src="docs/img/phone.png" alt="Foray on a phone: the terminal with the composer input bar and key toolbar for Ctrl, Esc and arrow keys" width="280">

## Install

Foray runs on a server you control — a small Linux VPS or a Mac you leave on — and you reach it over [Tailscale](https://tailscale.com), so it is never exposed to the open internet.

1. Get a Linux VPS (Ubuntu 22.04+) or set aside a Mac to act as the server.
2. Install Tailscale on it and sign in.
3. `npx foray-terminal setup`
4. Paste the token it prints into the login screen, once per device.

## From source

For contributors, or if you'd rather not go through npm:

```bash
git clone https://github.com/cushmachine/foray-terminal.git ~/foray
cd ~/foray && bash install.sh
```

`install.sh` is the same script `npx foray-terminal setup` runs for you: it
installs tmux and Node 24, runs `npm install`, and deploys Foray under pm2.
It works on the same Linux VPS or Mac described above. Foray runs its own
tmux server on its own socket, with its own config
(`scripts/foray.tmux.conf`) — it never writes or edits your `~/.tmux.conf`,
so it's safe to install alongside tmux sessions you already run.

## Security

Foray is a shell on the machine it runs on: anyone holding the access token
has a shell as the user Foray runs as, so treat the token like an SSH key.
Every socket and file upload requires it. The app binds to `127.0.0.1` by
default and is meant to be reached through `tailscale serve` on your
tailnet, never exposed to the open internet directly. Read
[SECURITY.md](SECURITY.md) for the full picture — what protects you, what
does not, and how to harden a deployment — before you put this on a box
anyone else can reach.

## Token & updates

Print the access token again any time — a new device, or if you lost it:

```bash
foray token
```

Update to the latest release:

```bash
foray update
```

`foray update` never discards local changes: it pulls (or reinstalls) and
redeploys, but stops and tells you if it finds any, rather than resetting
anything. From a source checkout, the equivalents are `npm run token` and:

```bash
cd ~/foray
git pull
npm install
npm run deploy
```

## Getting help

Open an issue on [GitHub](https://github.com/cushmachine/foray-terminal/issues).

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
