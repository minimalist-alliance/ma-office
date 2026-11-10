# Contributing

Thanks for wanting to help. Minimalist Alliance's office is open source under the Apache License 2.0, and
contributions are welcome.

## Before you start
- For anything bigger than a small fix, open an issue first, so we can agree on the approach.
- Read `docs/desk-design.md` and the decisions in `docs/decisions/` for the area you're changing. A change that
  goes against a decision needs a new decision record.
- Security issues go to support@minimalistalliance.com, never to a public issue (`SECURITY.md`).

## Making a change
- Keep each pull request to one change, with tests.
- Run the checks for what you touched:
  - `web/`: `npm ci`, then `npm run typecheck`, `npm test` and `npm run build:release`.
  - `services/`: `./mvnw verify`.
  - `desk-rtc/`: `./build.sh` and `go test ./...`.
- Update the docs your change affects. A change isn't done until its docs are.
- Run `tools/check-public.sh` before you push. This repository is public: no personal information, keys, tokens,
  IP addresses, account or machine IDs, and no photos with location or camera data.
- Core desk services are Java 21 and Spring Boot, so anyone can follow how a desk works. Desk apps may use any
  language that meets the desk app contract (`docs/decisions/draft-desk-app-contract.md`).

## License
By contributing, you agree that your contribution is licensed under the Apache License 2.0, as section 5 of the
license says. The Minimalist Alliance name and logo, and Maia's name, character and art, aren't part of that
license (`TRADEMARKS.md`).

## Conduct
Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
