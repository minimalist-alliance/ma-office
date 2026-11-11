# Self-hosted desk, end to end

`selfhost.spec.ts` proves a self-hosted desk works with the platform the way a cloud desk does, on staging, with no mocks: the desk pairs through the real Platform page with a staging test account, opens from that account's office (`office.staging.`), streams the Browser (frames advance, a page's colors decode where they should, its title reaches the tab strip), opens Notebook, and does it all again after its machine reboots. It also reads the WebRTC path from `getStats`: a host candidate, straight to the desk's home-network address, not relayed. Addresses are compared, never printed.

Run it from a machine on the desk's home network (the desk's one candidate is its home-network address):

```sh
export PATH=$HOME/.local/node-v24/bin:$PATH
cd selfhost/e2e && npm ci
SELFHOST_SSH=<a script that runs its argument on the desk, as a sudoer> \
SELFHOST_REBOOT=<a script that reboots the desk's machine from outside> \
SELFHOST_USER=<staging test user> \
  npx playwright test
```

- The test user is a staging `@test.minimalistalliance.com` account made with `ma-platform` `web/platform/e2e/test-users.mjs create <name>`; the script reads its credentials from SSM and never prints them. Never the owner's.
- **No browser flags or permissions:** Chromium as a member has it. The first runs here switched Local Network Access off, then granted it, and ICE still never started; the cause was the port (`../README.md`, "The port"). `SELFHOST_LNA=1` grants it, to compare.
- **`SELFHOST_REBOOT` must restart the machine** and may return once it's back. The test compares boot IDs, so a desk that's online again before its first look still counts. The one used here shuts the VM down and starts it through the hypervisor's guard rail, which refuses any command with the word reboot in it.
- If the desk isn't paired yet, it pairs it; if it is, it skips to opening it. **After the code is typed it answers the desk's own question** (EXP-8: whose office it joined, partly hidden) with `sudo ma-selfhost pair --yes` over `SELFHOST_SSH`, as the member would answer `y` at the installer, and the report says `1 confirmed at the desk`.
- **The Browser's session through the restart** (ADR 0035): before the restart the test's tab sets a persistent cookie and a `localStorage` item on the desk's loopback page (`session.html`), and after it reads both back on the same page; step 5 fails unless both are there (`3 browser session (set)`, `5 browser session (check)` in the report).
- **No home network to hand?** `../lab/standin.sh` makes a temporary amd64 EC2 machine stand in for the member's (S-85): its public address is the desk's `--address`, its security group lets in only this workstation, and `standin.sh scripts` writes `SELFHOST_SSH` and `SELFHOST_REBOOT` for it. Its test-only differences are in its header.
- **After an update** (`../README.md`, "Updating"), `SELFHOST_EXPECT=desk-rtc=<version>,desk-stream=0.2.4,port=4443` fails the run unless the desk runs those (`desk-notebook=<version>` too, or `desk-notebook=none` for a bundle from before it). Either way `report.json` has `2 versions`: each component's version, the port desk-rtc reads, and whether an older bundle's `/etc/ma/desk-rtc-port` is still there. `SELFHOST_DESK_NAME` names the desk when it pairs (default `Proxmox desk`).
- **Notebook's service** (`../README.md`, "Notebook"): step 2 checks `/data/notebook` is `1105:1105 700` and `/run/desk-notebook` `1105:1100 2750`, and with a `desk-notebook` release, that its container has no network and runs as 1105, and that `notebook.sock` is `1105:1100 660` (`report.json`, `2 notebook`). The smoke test it waits for includes `desk-notebook`'s `health`, before and after the restart. Step 4 opens the Notebook window; it doesn't yet write a note and read it back after the restart.
- `SELFHOST_REMOVE=1` takes the desk out of the test account's office at the end, on its `/self-hosted` page, as a member does; `SELFHOST_REMOVE_ONLY=1` does only that.
- It serves one test page on the desk's loopback (a transient unit, `ma-sh-e2e-pages`) and removes it after.
- `screenshots/report.json` has what it measured; the screenshots go beside it (ignored by git).

Last run: see the branch's `STATUS.md`.
