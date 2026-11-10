# Minimalist Alliance office

The office is where Minimalist Alliance members work: a private set of cloud desktops, called desks, opened in a browser. Each desk is a private desktop in the cloud, walled off from every other. The office shows all of a member's desks on one calm canvas, and each desk runs a few focused apps: a real Browser, Notebook, Files, an Agent, and Commons for guilds.

This repository holds the office web app, the desk's own software and its machine image, and the tools around them. The platform that runs accounts, billing and the hosted service lives elsewhere.

## What's here

| Folder | What it is |
|---|---|
| `web/` | The office: the web app members open (React, TypeScript, Vite, Konva), with the Agent and Notebook apps |
| `services/` | The desk's services: `deskd` and `desk-agent` in Java 21 and Spring Boot, and Notebook's sync service in TypeScript |
| `desk-rtc/` | The desk's WebRTC endpoint, in Go on Pion: the Browser's picture and sound, input, and the apps' data channels |
| `image/` | The desk machine image (Debian 13, arm64) and its checks |
| `apps/commons/` | Commons, the guilds' shared space |
| `selfhost/` | Running a desk on a computer of your own |
| `tools/` | Moving desks, exporting and decrypting desk data, batch jobs, and `check-public.sh` |
| `e2e/` | End-to-end tests against a real test desk |
| `docs/` | The design (`desk-design.md`), decisions (`decisions/`), interfaces, runbooks and benchmarks |

## Build and run the office

You need Node 24 and npm.

```bash
cd web
npm ci
npm run dev          # http://localhost:5173, with a mock desk and no network
npm run typecheck
npm test             # Vitest
npm run build:release
```

`npm run dev` needs nothing else: it signs in a fake member and plays three made-up desks. `web/CLAUDE.md` lists every command.

The other parts build on their own: `services/` with `./mvnw verify` (Java 21; `services/notebook/` with npm), `desk-rtc/` with `./build.sh` (Go), and the image as `image/README.md` describes. To run a desk on your own computer, see `selfhost/README.md`.

## Contributing

Contributions are welcome: see [`CONTRIBUTING.md`](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately, as [`SECURITY.md`](SECURITY.md) says.

## License

Copyright 2026 Minimalist Alliance LLC. Licensed under the [Apache License, Version 2.0](LICENSE); see also [`NOTICE`](NOTICE).

The Minimalist Alliance name and logo, and Maia (her name, character and art, including `docs/assets/maia/`, `web/maia-avatar/` and its packaged copy in `web/vendor/`), are not licensed: see [`TRADEMARKS.md`](TRADEMARKS.md).
