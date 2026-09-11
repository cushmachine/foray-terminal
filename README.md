# Foray

Foray is a browser terminal, backed by tmux sessions on a server you run, built for checking on and driving coding agents like Claude Code from your phone.

<img src="docs/img/desktop.png" alt="Foray's desktop view: a sidebar listing tmux sessions next to a terminal with a live shell" width="100%">

<img src="docs/img/phone.png" alt="Foray on a phone: the terminal with the composer input bar and key toolbar for Ctrl, Esc and arrow keys" width="280">

## Install

Foray runs on a server you control — a small Linux VPS or a Mac you leave on — and you reach it over [Tailscale](https://tailscale.com), so it is never exposed to the open internet.

1. Get a Linux VPS (Ubuntu 22.04+) or set aside a Mac to act as the server,
   and make sure Node.js 24+ is on it — a fresh Ubuntu box ships with none,
   and step 3 needs `npx` to even start:
   `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs`
   (Mac: `brew install node`).
2. Install Tailscale on it and sign in.
3. `npx foray-terminal setup` — installs tmux and pm2, deploys Foray, and
   prints your access token plus a `https://<name>.<tailnet>.ts.net` URL.
4. Open that URL and paste in the token, once per device.

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

`setup` also installs the `foray` command itself, globally, so it's on
your PATH afterwards (running it again there is harmless if you'd rather
stick with `npx foray-terminal ...`).

Print the access token again any time — a new device, or if you lost it:

```bash
foray token
```

Update to the latest release:

```bash
foray update
```

`foray update` behaves differently depending on how you installed. From a
git checkout (the "From source" path), it refuses rather than discarding
anything: it stops and prints what it found if the checkout is dirty,
otherwise runs a fast-forward-only `git pull`. From the npm path, there is
no checkout to check for local edits, so nothing is refused: it copies the
new release's files over `~/foray` unconditionally, except an existing
`ecosystem.config.cjs` is left alone. From a source checkout, the
equivalents are `npm run token` and:

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
