# courier-parse

desk-parse's Courier mode: untrusted mail made into safe, structured parts, **only inside the parse sandbox** (ADR 0097:
uid 1113, no network, no `/data`, no capabilities, a read-only root, 160 MiB, `-Xmx72m`). The Courier launch plan's
Wave 1.2; the draft ADR "Courier's store" §4 is the decision. Package `com.minimalistalliance.desk.courier.parse`. No
Spring, nothing that opens a file or a socket.

deskd never parses MIME or HTML. It writes a message to the sandbox's socket and reads the answer
(`deskd/.../courier/parse/CourierSandbox`). desk-agent depends on this module only so its jars ship in desk-agent's
image, which is the image the sandbox runs; desk-agent never calls it.

## How it runs
The Courier sandbox runs `java @/app/courier-parse.options` once per request, with deskd's connection as its stdin and
stdout (`desk-agent/docker/courier-parse.options`).
- **Flags:** `parse.options`' own, line for line (`OptionsTest`).
- **Security manager:** desk-agent's `worker/Sandbox`, copied as a second layer while the workers run on JDK 21
  (`OptionsTest` compares them).
- **Before it reads anything:** `CourierWorker.main` loads the tracker list and runs every reader once on a fixed message
  of its own (`warmUp`), because the libraries' static set-up reads files the manager then refuses.

| Request line | Then | Answer |
|---|---|---|
| `courier1 message` | the raw message | `OK`, then `parse-courier 1` JSON, exactly `ParsedMessage.fromWire`'s shape |
| `courier1 part <id>` | the raw message | `OK <n>`, then the part's `n` decoded bytes (at most 25 MiB), for Download and Save to Files |
| `courier1 image <id>` | the raw message | `OK <png\|jpeg> <w> <h>`, then the part drawn again from its pixels |
| `courier1 image -` | an image's bytes | the same, for a remote image the desk fetched when the member pressed "Show images" |
| `courier1 archive <id>` | the raw message | `OK`, then `{v, format, entries: [{name, bytes, packed, encrypted, dir, danger}], total, truncated, danger}` |
| `docs1 read <kind> <maxChars> <maxPages>` | a document (`pdf docx xlsx pptx text`) | `OK`, then `docs-read 1` JSON: pages with each line's box (0 to 1, y from the top, 300 a page and 20,000 in all), sections for a reading view, the form's empty fields. Documents' mode, desk-agent's `attach/worker/DocsMode` (deskd `API.md` §25) |
| `docs1 render <page> <width>` | a PDF | `OK jpeg <w> <h>`, then the page drawn as a JPEG (200 to 1,600 px across, at most 4 megapixels, 4 MiB) |

**Other request families (`WorkerMode`).** The sandbox's command is fixed, so another mode rides this worker: a `WorkerMode`
found with `ServiceLoader` (desk-agent's jar registers Documents' `DocsMode` in `META-INF/services`) and warmed before the
security manager is installed. A first line whose word is a mode's (`docs1`) goes to it, read as strictly as `courier1`'s
(printable ASCII, at most 128 bytes, nothing past the newline), under the same deadline and one-answer rule; any other word
is `ERR bad_request`, which deskd reads as an older image. `courier1` is unchanged byte for byte. Documents' mode draws with
PDFBox's bundled fonts only: the font mapper is given no system fonts at warm-up, so no file outside the jars is opened.

Anything it won't read gets `ERR <reason>`: `too_large`, `too_deep`, `too_many_parts`, `timeout`, `malformed`,
`too_complex`, `unsupported`, `not_found` or `bad_request`.
- Part ids are IMAP's section numbers (`1`, `2.1`), so the same bytes always give the same ids, and the IMAP transport
  can fetch a part by its id.
- The worker reads everything deskd sends before it answers.
- At 10 s from its start it answers `ERR timeout` (unless an answer has begun) and halts.

## What it does
**MIME** (`Mime`): Apache James mime4j's streaming parser, lenient as mail clients are.
- Malformed header lines are skipped. mime4j's "header ends the body" path failed on 2% of fuzzed input.
- Our own counts decide the limits: 2,000 entities, nesting 20, 40 MiB, 10 s. Over any of them is a refusal, never half
  a message.
- More than one From (two fields, or two mailboxes in one) is `malformed`: RFC 5322 allows one, and a DMARC verdict
  for one address must never be shown beside another (Security CP-L2).
- **Headers:** decoded from their raw bytes (UTF-8, else windows-1252), then RFC 2047, with RFC 2231's language form
  too. Addresses go through mime4j's lenient parser, groups flattened. The first header of a name wins.
- **Text:** charsets by label and WHATWG aliases, plus UTF-7. `format=flowed` is unwrapped. A forwarded message is an
  attachment.

**HTML** (`Html`): two passes, with jsoup's HTML5 parser.
- **Pass 1** builds a new tree from an allow-list:
  - Kept: text, tables, basic blocks, and `style` cut to basic properties (`Css`).
  - Gone with their content: scripts, styles, frames, objects, form controls, SVG, MathML, templates, `meta`, `link` and
    `base`.
  - Anything else is unwrapped. Depth is capped at 100 and elements at 100,000.
- **Pass 2** reads the output again as a browser would. It must serialize to the same string, and every element,
  attribute and value must be one pass 1 writes, each checked again. Otherwise the HTML is left out and the text kept.
- **Nothing in the output loads anything:**
  - **Links** have no `href`. They carry `data-ma-href`, the destination made plain by `Links`: ASCII host, user-info
    gone, tracking parameters gone. `data-ma-host` is the host, `data-ma-warn` the warnings (`mismatch ip punycode
    userinfo tracker`), and `title` the full destination, which a pointer shows without a script.
  - **Remote images** have no `src`; they carry `data-ma-src`.
  - **Trackers** are removed: on ADR 0076's lists, 2 px or smaller, hidden, or an open-tracking path.
  - `cid:` images become `data-ma-cid`. A `data:` image is drawn again, or dropped.

The office shows this HTML in a frame with no scripts and its own CSP (the plan §3.1), which is the third wall.

**Tracker lists** (`Trackers`): ADR 0076's pinned EasyPrivacy, as a host list. The image's bake writes it from
`image/recipe/adblock/blocker.pin`'s release, and the sandbox mounts it read-only over the image's empty
`/app/courier/trackers.txt`; that change is the System Engineer's (`docs/sub-status/mm-courier-parse.md`). Without it, the
size, hidden and path rules still remove pixels.

**Images** (`Images`): PNG, JPEG, GIF and BMP through ImageIO.
- The size is checked before a pixel is decoded: 30,000 px a side, 50 megapixels, 12 for a progressive JPEG.
- It's decoded subsampled to at most 2,048 px, then drawn again: PNG with transparency, JPEG at 0.85 without. Metadata
  goes.

**Danger** (`Danger`) is decided by the real extension (hidden characters and trailing dots removed) and the bytes, never
the claimed type alone. It's read as the bytes stream past.

| Word | What it is |
|---|---|
| `program` | executables, installers, Java and Android packages |
| `script` | anything an interpreter runs |
| `macros` | an Office file with macros: `docm`, `vbaProject.bin` in a ZIP, `_VBA_PROJECT` in OLE2 |
| `shortcut` | a shortcut or link file |
| `disk_image` | a disk image (ISO, DMG, VHD and the like) |
| `archive_programs` | a ZIP or tar holding any of the above |
| `html` | a web page or SVG |
| `archive_unread` | RAR, 7z, cab, a compressed tar, or a ZIP too large to list |

**Archives** (`Archives`): a ZIP's central directory, ZIP64 included, read from the last MiB of the part. A tar's headers
are read as they stream past, GNU long names and pax paths included. Nothing is inflated or unpacked.

## Tests
`../mvnw -q -pl courier-parse -am test` runs these:

| Test | What it proves |
|---|---|
| `CorpusTest` | Every sample of `courier-testkit`'s standard corpus (5,155) is read or cleanly refused through the worker's wire, and matches its expectation. The limits are refused exactly at their bounds. |
| `HostileHtmlTest` | The kit's 351 hostile vectors keep nothing that runs or loads, by an oracle that reads the output independently (`escapes`). |
| `PartsTest` | Each piece, plus the part, image and archive requests. |
| `WorkerProcessTest` | The worker as its own JVM, with `courier-parse.options`' flags and the security manager: a 39 MiB message, 2 MiB of HTML and every limit fit `-Xmx72m`. |
| `OptionsTest` | The flags and security manager stay desk-agent's. |
| `CourierFuzzTest` | A few thousand inputs in a build (`-Dcourier.fuzz.mime=N -Dcourier.fuzz.html=N -Dcourier.fuzz.threads=T -Dcourier.fuzz.out=DIR` for the long run). |

Two checks run outside the build:
- **The real sandbox, on Docker:** `scripts/test-courier-sandbox.sh <inputs>`. Its inputs come from
  `-Dtest=SandboxInputs -Dcourier.sandbox.out=<inputs>`. It builds desk-agent's image, runs a worker per request under
  ADR 0097's wall, and checks the answer, the kernel's memory.peak against 160 MiB, and the time.
- **A real browser:** `node scripts/browser-check.mjs <chrome> <dir> <port>`. Its documents come from
  `-Dtest=BrowserExport -Dcourier.browser.out=<dir> -Dcourier.browser.hit=http://127.0.0.1:<port>/hit`. Chromium runs
  with scripts on and no CSP, every element gets events and clicks, and the check counts dialogs, requests and
  navigations. A control directory of unsanitized vectors must fail it.
