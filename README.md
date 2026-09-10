# Foray

Foray is a browser terminal, backed by tmux sessions on a server you run, built for checking on and driving coding agents like Claude Code from your phone.

<!-- docs/img/desktop.png — batch 4 -->

## Install

Foray runs on a server you control — a small Linux VPS or a Mac you leave on — and you reach it over [Tailscale](https://tailscale.com), so it is never exposed to the open internet.

1. Get a Linux VPS (Ubuntu 22.04+) or set aside a Mac to act as the server.
2. Install Tailscale on it and sign in.
3. `npx foray-terminal setup`
4. Paste the token it prints into the login screen, once per device.

> `npx foray-terminal setup` lands in 0.1.0. Until then, install from source below.

## From source

For contributors, and for everyone else until the npm package ships:

```bash
git clone https://github.com/cushmachine/foray-terminal.git ~/foray
cd ~/foray && bash install.sh
```

`install.sh` installs tmux and Node 24, runs `npm install`, writes the tmux
config Foray needs, and deploys Foray under pm2. It works on the same Linux
VPS or Mac described above.

## Security

Foray is a shell on the machine it runs on: anyone holding the access token
has a shell as the user Foray runs as, so treat the token like an SSH key.
Every socket and file upload requires it. The app binds to `127.0.0.1` by
default and is meant to be reached through `tailscale serve` on your
tailnet, never exposed to the open internet directly. Read
[SECURITY.md](SECURITY.md) for the full picture — what protects you, what
does not, and how to harden a deployment — before you put this on a box
anyone else can reach.

## Updating

From npm, `foray update` will pull the latest release and redeploy — that
also lands in 0.1.0. From a source checkout, update with:

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
