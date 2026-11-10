# A desk on your own computer

You can run a desk on a computer of your own, instead of in the cloud, and use it from your office like any other desk. It runs the same desk software, with the same Browser and apps. What you do on it goes straight between your browser and that computer, end to end, and never through us.

This is an early version for technical members, and it's open on our test platform only for now.

## What changes when the desk is yours

- **Your data stays on your computer.** We keep no copy, take no snapshots and make no backups of it. Back up the computer yourself.
- **You keep it running.** It's online in your office while the computer is on, and offline when it's off. We can't start it for you, and it never goes to sleep on its own.
- **You keep it safe.** It installs security updates for its system by itself. Keep the computer it runs on updated, and encrypt its disks if you can.
- **What we see:** that it's online, the internet address it connects from, its software version, and the address your browser uses to reach it while a connection starts. Never what's on it.
- **We can only disconnect it.** It runs software we provide, so the honest limit in our Privacy Policy applies to it too.

## What it needs

- **A computer with an x86-64 processor** (most desktops, mini PCs and home servers) that can run virtual machines, such as Proxmox, libvirt or VirtualBox.
- **A virtual machine for the desk alone,** with:
  - 2 processor cores and 4 GB of memory, or more for a smoother picture;
  - a system disk of at least 12 GB;
  - **a second, empty disk** of at least 16 GB for the desk's data (your Browser's profile, downloads and notes). Use a SCSI or SATA virtual disk, not VirtIO Block. The desk formats it the first time, and never again;
  - its network **bridged** onto your home network, so other devices can reach it. A "shared" or NAT network hides it.
- **Debian 13** on the virtual machine, freshly installed. The minimal "cloud" image works, as does the regular installer with no desktop.
- An internet connection with about 10 Mbps of upload if you'll use it away from home.

Give the desk its own virtual machine, not your own computer's system: it keeps the desk apart from everything else you have.

## Install

1. **Make the virtual machine** with the two disks above, and install Debian 13 on the system disk. Leave the second disk empty.
2. **Copy the installer onto it.** It's a folder with `selfhost/`, `image/recipe/` and a release bundle (`bundle/`), from Minimalist Alliance.
3. **Run it,** as root:
   ```sh
   sudo ./selfhost/install.sh --bundle ./bundle
   ```
   It takes 10 to 20 minutes, mostly downloading. It installs the desk's software, sets up the second disk and the firewall, and then shows a code:
   ```
     Your code:  ABCD-EFGH

     On a computer where you're signed in, open
     https://platform.staging.minimalistalliance.com/self-hosted?code=ABCDEFGH
     and add this desk to your office. The code works for 15 minutes.
   ```
4. **Open that link** on your laptop, signed in to your account. Check the code, name the desk, and choose **Add to my office**. Only use a code from a computer you set up yourself.
5. Back at the computer, the installer shows whose office the desk just joined, with the name and address partly hidden, and asks **Is that your account? Keep this desk there? [y/N]**. Answer `y`. On `n` (or Enter) the desk is taken out of that office and forgets the pairing, so a code someone else gave you can't leave a desk of theirs in your office. `--yes` answers it for you, for a script.
6. The installer says **Paired**, starts the desk, and it appears in your office. Open it there like any other desk.

Options for `install.sh`:

| Option | What it does |
|---|---|
| `--address <ip>` | The address your browser reaches the desk on. Leave it out to use the desk's address on your home network. Set a public address only if you've forwarded the desk's port (below) to it |
| `--port <n>` | The port your browser reaches the desk on, UDP and TCP. 4443 unless you choose another, from 1024 up: Chrome won't connect to a desk on your home network on a lower one. `sudo ma-selfhost port <n>` changes it later |
| `--keep-ssh` | Let SSH in from your home network. Without it, the desk's firewall lets in only its own port. `--no-keep-ssh` closes it again |
| `--allow-home-network` | Let the desk's Browser reach the other devices on your home network. Without it, a web page open on the desk can't reach your router, printer or other devices. `--no-allow-home-network` undoes it |
| `--yes` | Don't ask at the end of pairing whether the office shown is yours. For scripts |
| `--no-pair` | Don't wait here for the code. The desk still asks for one; `sudo ma-selfhost pair --wait` shows it |

When you update the desk, the installer keeps the desk's options, so you only give the ones you want to change.

## Using it at home and away

- **At home,** your browser connects straight to the desk over your home network. That's the fastest way to use it.
- **If Chrome asks** whether the office may "find devices on your local network", allow it. On a Mac, Chrome and Firefox also need **Local Network** turned on for them in System Settings, under Privacy & Security.
- **Away from home,** your browser has to reach the desk some other way. Either join your home network with a VPN you already use (WireGuard, Tailscale and the like), and install with that VPN's address of the desk in `--address`; or forward the desk's port (4443 unless you chose another, UDP and TCP, to the same port) on your router to the desk and give your public address. We don't relay desks on your own computer yet.
- Guest Wi-Fi and some work networks keep devices apart. There, use the VPN.

## Day to day

```sh
sudo ma-selfhost status        # which desk this is, whether it's online, and its port
sudo ma-selfhost port 5000     # stream on another port (1024 up); the firewall follows
journalctl -u deskd -u desk-rtc -u desk-notebook -u ma-selfhost    # the desk's own logs
```

- **Updating:** copy the newer installer and bundle onto the desk, as when you installed it, and run `sudo ./selfhost/install.sh --bundle ./bundle` again. It says which versions it's updating from and which settings it keeps: the platform, address, port, SSH and home network. It gives each part a quick health check as it goes in, and puts the old one back if it fails. Your data, your Browser's sign-ins and the pairing stay, and the desk stays in your office. A desk window you have open drops for a moment while its parts restart.
- **One copy at a time:** a desk can run on one computer at a time. If you start a copy (a cloned virtual machine, say) while the first is online, Minimalist Alliance refuses the second. `sudo ma-selfhost status` and the installer then say, in plain words, that the desk is already running somewhere else, and the copy starts by itself about 3 minutes after the first stops. Your office says "<desk name> started at <time>" for each new start, and "Another copy of <desk name> is trying to start" while a second one is being turned away, so a start you didn't make is one you notice. If that happens, remove the desk from your office and pair it again.
- **Restarting:** restart the virtual machine at any time. The desk comes back online by itself.
- **Moving it:** the pairing and everything in the desk live on the second disk, so a fresh system disk with the same data disk carries on as the same desk.

## A teen's desk

If your account is a teen's, the desk's Browser runs under the same extra rules as a cloud desk: a family filter on web addresses, SafeSearch, YouTube's restricted mode, no proxies and no extensions. **Whoever owns the computer has root on it and can remove those rules,** by deleting a file. We can't stop that, and we don't try: a self-hosted desk browses from your own network, where your family's own filters still apply.

## Removing it

Remove it from your office on the same page you added it on (`/self-hosted`). It stops connecting at once, and everything on it stays on your computer. To use the computer as a desk again later:

```sh
sudo ma-selfhost forget && sudo systemctl restart ma-selfhost && sudo ma-selfhost pair --wait
```

If you think someone copied your desk's disk, remove it from your office straight away, then pair it again. To replace its key without removing it: `sudo ma-selfhost rotate`.

---

## For the team: how it works

Decision and security write-up: `ma-platform` `docs/decisions/draft-self-hosted-desks.md` (platform) and `../docs/decisions/draft-self-hosted-desk.md` (this side). Contract: `ma-platform` `docs/contracts/selfhost.md`. Status: `../docs/sub-status/selfhost-notebook.md` and the other `selfhost-*` files there.

**Pairing and identity.** `ma-selfhost` (`files/usr/local/lib/ma/selfhost/ma-selfhost`, Python 3 with `python3-cryptography`) makes an Ed25519 key on `/data/selfhost/key.pem` (0600, user `selfhost`, uid 1110), asks the platform for a code, and once a member types it, trades signed requests for 15-minute credentials of the env's self-hosted desk role. It serves them to deskd exactly where a cloud desk's metadata service would: IMDSv2 on `169.254.169.254:80`, an address it puts on `lo`. The existing firewall rule already lets only root and deskd (1100) reach that address. So **deskd, `desk-rtc` and `desk-stream` run unchanged,** from the same commits as the cloud releases, built for amd64. What it serves: the tags `DeskId`, `UserId`, `DeskKind`, `Env`; `instance-id` (the desk ID, which the platform expects for these desks); `public-ipv4` (the desk's address, see below); `instance-type` `self-hosted`; and the credentials under `iam/security-credentials/`. It never logs the key or a credential, and `log_message` is silenced so tokens and paths don't reach the journal.

**The DTLS identity is signed by the key.** The platform takes this desk's hello only with DTLS fingerprints its key signed (`ma-platform` contract `selfhost.md` §3 and §4), so someone holding a copied 15-minute credential can't point the member's sessions at another machine. desk-rtc keeps its identity in one file with its private key (`/data/rtc`, `0600`, user rtc), which `ma-selfhost` can't read, so `ma-selfhost-dtls`, as root, reads only the certificate's block and writes its sha-256 to `/run/ma-selfhost/dtls.json`: at `ma-selfhost`'s start (its prep) and after each desk-rtc start (the drop-in `desk-rtc.service.d/selfhost.conf`, once desk-rtc listens). `ma-selfhost` watches that file and signs it into its next `session` call at once. `ma-selfhost status` shows `identity: signed`, `waiting` (desk-rtc has none yet), or `unsupported` (a platform from before signed statements). `install.sh` waits for it before starting deskd, which otherwise tries hello again a minute later.

**The address.** `desk-rtc` binds the default route's source address (`--bind auto`), and uses `configure`'s `publicIpv4` as its one host candidate. `ma-selfhost` serves that same source address as `public-ipv4`, or the `address=` in `/etc/ma/selfhost.conf`. So the candidate is the desk's home-network address: the contract's exception for these desks (`selfhost.md` §4). One candidate means one path; offering home, VPN and forwarded addresses together needs a `desk-rtc` change (STATUS.md).

**The port.** Chrome (156) drops a remote ICE host candidate with a private address on a port below 1024 (its log says "Invalid candidate"), so a desk on a home network can't use 443: ICE never starts, and the office shows a session that never connects. Measured on the first run here, with the same address on port 5000 and a public address on 443 both accepted, and nothing about Local Network Access changing it. So a self-hosted desk listens on 4443. **`desk-rtc` takes its port from the desk's config** (task 35): `port=4443` in `/etc/ma/desk-rtc.conf`, which its release's `run` passes as `--config`, and its `health` asks `desk-rtc --print-port` which port to check, so the two can't differ. A cloud desk has no such file and listens on 443 as before. A value it can't use stops `desk-rtc` and fails `health`; a key it doesn't know is skipped. **One helper sets it,** `ma-selfhost-port` (`files/usr/local/lib/ma/selfhost/`), for both `install.sh --port` and `sudo ma-selfhost port <n>`: the config and the firewall's `rtc_port`, checked with `nft -c` first, then the firewall reloaded and `desk-rtc` restarted (its DTLS identity stays on `/data/rtc`). The bundle's `desk-rtc` is the cloud desks' release built for amd64, with nothing patched.

**Desks from the first bundle** (`desk-rtc` `0.3.0-sh1`, task 31) had `run` and `health` patched to read `/etc/ma/desk-rtc-port`. Updating one with `install.sh` reads its settings from what it has (the port from that file, SSH and the home network from which tagged lines its firewall kept), writes `/etc/ma/desk-rtc.conf`, keeps the old file in step while `0.3.0-sh1` is still installed (so if `ma-update` puts it back after a failed health check, it still listens on 4443), and removes the old file once the new `desk-rtc` is in. Rolling a desk back by hand to `0.3.0-sh1` later: `sudo /opt/ma/bin/ma-update desk-rtc --rollback && sudo ma-selfhost port 4443`, which rewrites the old file for it.

**How it differs from a cloud desk** (`install.sh` follows `image/recipe/build.sh` step for step, reading its files):

| | Cloud desk | Self-hosted desk | Why |
|---|---|---|---|
| Machine | arm64 AMI on EC2 | amd64 Debian 13, any hypervisor | Most home machines are x86-64 |
| Releases | baked from `releases.pin` (arm64) | `bundle.pin` (amd64, `build-bundle.sh`), same commits. The last bundle proven on a VM (2026-11-07, from `4a88f61`): `desk-rtc` 0.3.5, `desk-stream` 0.2.4, `deskd` and `desk-notebook` `2026.11.07-0e1fb6c`; `desk-agent-filter` 0.1.1 joined the bundle after it | Same code, other processor |
| Identity, credentials | instance role from IMDS | `ma-selfhost` on the IMDS address | No cloud metadata at home |
| SSM agent, cloud-init cleanup | yes | no | No remote commands into a member's computer (study §1) |
| `nftables.conf` | the recipe's | the recipe's, plus: the desk's Browser (1102) can't reach private, link-local or CGNAT ranges (the agent, 1103, reaches only `desk-agent-filter`, which reaches only the providers' names on public addresses, so it can't reach the home network either); SSH from the home network only with `--keep-ssh` | A page on the desk mustn't probe the home network (study §1) |
| Time | Amazon Time Sync | Debian's NTP pool | |
| DNS | systemd-resolved | systemd-resolved, installed and made the resolver | Chromium's lookups stay on loopback, past the rule above |
| `desk-egress` (outbound budgets) | on | not installed | It guards our cloud bill; this traffic isn't ours |
| `desk-agent-filter` (the Agent reaches only the providers' names, ADR 0070) | baked, arm64 | from the bundle, amd64, the same source and rules. It doesn't need the shaper | The same limits wherever the desk is |
| `desk-preread` | on | off | It warms a cloud root's blocks; a local disk has none to warm |
| `desk-agent` | baked from `releases.pin` | its user (1103), directories and unit, from the recipe; no release, as `bundle.pin` has none, so it's skipped by its condition | A bundle doesn't carry `desk-agent` yet |
| `desk-notebook` | baked from `releases.pin` once it's pinned | its user (1105), directories and unit from the recipe, and its release from `bundle.pin`, built for amd64 from the same commit (pinned to `2026.11.07-0e1fb6c` with `deskd` `2026.11.07-0e1fb6c`). The same `--network none`, so this firewall has no rule for 1105 either | Notebook's pages are kept on the desk, by the same service as a cloud desk's |
| Data disk | the one non-root EBS volume | the one non-root SCSI/SATA/NVMe disk | `desk-firstboot` unchanged: formats only a blank disk |
| desk-rtc's port | 443 (no `/etc/ma/desk-rtc.conf`) | 4443: `port=` in `/etc/ma/desk-rtc.conf` (`--port`, `ma-selfhost port`), the same `desk-rtc` release | Chrome refuses a private-address candidate below 1024 |
| DTLS identity | recorded from hello | signed by the desk's key in `session` (`ma-selfhost-dtls`, desk-rtc's drop-in) | A copied 15-minute session mustn't change it |
| `/etc/ma-release` | the image version | `selfhost-<commit>`, `hosting=self` | hello's `imageVersion` says which |
| Ad and tracker blocking (ADR 0076, `image/README.md` "Ad blocking") | the image's own blocker, built at bake time from uBlock Origin Lite's pinned lists, with `desk-adblock` and its unit | the same, built by `install.sh` from the same pin (it fetches the release from GitHub and checks its sha256; a new id each install, which reinstalls it and loses nothing); Debian's amd64 Chromium reads the same policy directory. Not yet run on a self-hosted desk | The same Browser wherever the desk is. The member has root and can remove it |
| Teen Browser lock (`image/README.md`) | the same helper, policy and unit, from the recipe's files | the same, and **the member has root, so can delete it** | Nothing on the machine can stop its owner. The draft's bar is that it equals their own browser |

**The teen lock here.** `install.sh`'s "install files" step copies `etc/ma/chromium-teen.json`, `usr/local/lib/ma/desk-browser-policy` and `desk-browser.service` with the rest of the recipe. Debian's amd64 `chromium` reads the same `/etc/chromium/policies/managed/`. Proven on a Debian 13 amd64 box, with `install.sh`'s package line and file steps as written, its firewall and a second disk: the real unit locked and unlocked, Chromium reported all 7 keys, uid 1102 reached the resolver, the filtered name didn't load and `example.net` did (`../image/evidence/teen-lock-2026-11-07/amd64.txt`). `install.sh` itself wasn't run end to end, since it needs a bundle and a pairing. **A bundle's `deskd` has to write the band.** A missing band is locked, so a bundle with a `deskd` that doesn't filters an adult's Browser too: move `build-bundle.sh`'s `deskd` pin with the Desk Engineer's release before a member updates. A self-hosted desk's `/etc/ma-release` has no image tag, so the Platform can't gate it on `DeskTeenLock`; an older installer simply has no lock.

**Files here:** `install.sh`; `build-bundle.sh` (the amd64 releases, built on a Docker host, never on the desk or the hypervisor); `files/` (installed over the recipe's: `ma-selfhost.service`, its prep, `ma-selfhost-dtls`, `ma-selfhost-port` and CLI wrapper, deskd's and desk-rtc's drop-ins, `nftables.conf`, `chrony.conf`); `e2e/` (the end-to-end proof against staging, `e2e/README.md`).

**A bundle** (`build-bundle.sh`) is `bundle.pin` and five amd64 artifacts: `desk-rtc` at the commit its arm64 release came from, with that release's own `run` and `health` (the script refuses a `desk-rtc` that doesn't read the desk's config, or a `-sh` version); `desk-stream`, byte for byte the published one (it has no arch); `deskd` built for amd64; `desk-agent-filter` from its source; and `desk-notebook` built for amd64 (below). Today's pins are at the top of the script. A new cloud release becomes a self-hosted one by changing the pin, building, installing it on a test VM and running `e2e/`.

**Notebook (`desk-notebook`, S-13).** The service that keeps a desk's notes (`services/notebook/README.md`) goes on a self-hosted desk the way the image puts it on a cloud desk (`image/README.md`, "desk-notebook"):
- **The build.** `build-bundle.sh` builds it as `services/scripts/build-image.sh notebook` does, from `services/notebook/` and `web/notebook/src/model/` at its pinned commit, on the amd64 Docker host: the Dockerfile's base is `node:24-bookworm-slim` by its multi-arch digest and the service has no native code, so nothing changes for amd64. It's packed as `services/scripts/package-release.sh` packs it (`VERSION`, `run`, `health`, `desk-notebook.env`, `image.tar` of `ma/desk-notebook:<version>`), with the commit's own `run`, `health` and env file.
- **Pinned, built and proven:** `desk-notebook` and `deskd` `2026.11.07-0e1fb6c`, both passed on the test desk. On 2026-11-07 the bundle with them updated a desk from the one before and installed a new desk, and `e2e/` passed on each (`../docs/sub-status/selfhost-notebook.md`, "Proof on VMs"). The script still stops with "no desk-notebook pinned yet" if the slot is ever emptied, as it does for an unpinned `desk-rtc`: a bundle without it would leave a self-hosted desk with no Notebook.
- **The installer.** `install.sh` makes user `notebook` (uid and gid 1105, its own group only), installs the recipe's `desk-notebook.service` (enabled) and `tmpfiles.d/ma.conf` (`/run/desk-notebook`, `notebook:desk` 2750, so `deskd` reaches `notebook.sock` by group and `kiosk` and `agent` can't enter), and `desk-datadirs` makes `/data/notebook` (`notebook:notebook` 0700). It installs the release from the bundle **last**: `ma-update`'s smoke test runs every installed component's `health`, so a `desk-notebook` installed but not yet running would fail the others' updates. On a desk where it isn't running yet, it's only installed there, and starts with the desk once `/data/notebook` is there; a running one is updated through `ma-update` like the rest. `deskd`'s own `run` mounts `/run/desk-notebook`, from the `deskd` pinned with it.
- **Updating a desk from before it** adds all of that. On the data disk it only adds `/data/notebook`: it's made by `desk-datadirs`, the cloud desk's own script, and the rest of what that does in `/data` it already does at every boot.
- **Older bundles still install.** `desk-notebook` is optional in `bundle.pin`, as it is in the image's `releases.pin`, so a bundle from before it installs as it did, with Notebook's unit skipped by its condition. A bundle that has it next to a `deskd` that can't reach it is refused.
- **Nothing in it assumes the cloud.** It reads only its `DESK_NOTEBOOK_*` settings (all defaults on a desk), has no network at all, talks only over `notebook.sock`, and never asks for IMDS, AWS or a credential; its `health` is `python3` over that socket. So it needs nothing from `ma-selfhost`, and the firewall needs no rule for uid 1105.
