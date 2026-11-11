# Bible (`apps/bible/`)

The Bible app (backlog S-150): four public-domain translations (BSB, the default, WEB, KJV, ASV) bundled in the app, with reading, search, bookmarks, highlights and notes kept on the member's desk. Free on every membership. It's a desk app contract package (`docs/decisions/draft-desk-app-contract.md`, deskd `API.md` §19): it asks for no permissions and never needs the internet.

| Path | What |
|---|---|
| [`API.md`](API.md) | The wire between the view and the service: every method, the topic, the widget, search and reference rules, the on-disk format. The view is built against it |
| `server/` | `bible-app`, the service, in Go with only the standard library: the contract's app socket, the methods, the topic and the widget. `server/testdata/` holds small fixture texts |
| `internal/` | `text` (the translations memory-mapped, chapters, references, search), `store` (marks and prefs in a synced journal), `canon` (the 66 books), `wire` (the app socket's frames, copied from the contract sample) |
| `texts/` | The four translations and their statements and sources (the texts builder's; `texts/README.md` has the format) |
| `ma-app.json` | The manifest; `tools/pack` fills in `arch` and `files` |
| `view/` | The product view, the UI/UX Engineer's (not here yet) |
| `view-dev/` | A plain developer view for testing the contract's path: lists a chapter, searches, toggles a bookmark. **Not the product view** |
| `build.sh` | Builds both packages into `dist/` |
| `tools/pack` | Packs files/ into a `.maapp` (the sample's `ma-app pack` takes only the executable and `view/`, so it can't carry the texts) |
| `tools/measure` | Runs `bible-app` as deskd would and reports memory and latency; `storecap` fills the store to its caps |

## Build and test

```sh
cd apps/bible
nice -n 10 go test ./...            # fixtures, plus the real texts when they're format 2
./build.sh --dev                    # until view/ exists; without --dev the build refuses
go run ./tools/measure -bin <unpacked package>/files/bin/bible-app -texts <unpacked package>/files/texts
```

`build.sh` makes static `linux/arm64` (desks) and `linux/amd64` (tests) builds (`CGO_ENABLED=0 -trimpath -ldflags "-s -w"`), assembles `files/` (`bin/bible-app`, `texts/<code>/` with `STATEMENT.txt` and `SOURCE.md`, the view's three files), packs each, and checks it with the contract sample's `ma-app verify`.

**Signing:** each run makes fresh Ed25519 developer and review keys in a scratch folder, signs with both and throws them away. No desk trusts these packages. A real package needs MA's review key, which doesn't exist yet (the contract's "For the Platform Engineer"), and deskd's key ids (review C3) differ from the sample's that `tools/pack` uses.

## Running it by hand

`bible-app` takes the contract's environment (`MA_APP_SOCKET`, `MA_APP_DATA`, `MA_DESKD_UID` required) and finds the texts at `../texts` from its own executable (`-texts DIR` overrides). It answers HELLO before it reads any data, sets its own `oom_score_adj` to 1000 so the kernel kills it before deskd, and works when deskd runs as its own uid.
