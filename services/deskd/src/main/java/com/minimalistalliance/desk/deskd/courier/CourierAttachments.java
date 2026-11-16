package com.minimalistalliance.desk.deskd.courier;

import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.parse.CourierSandbox;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.store.Norm;
import com.minimalistalliance.desk.deskd.courier.store.Queries;
import com.minimalistalliance.desk.deskd.data.Transfer;
import com.minimalistalliance.desk.deskd.data.Transfers;
import com.minimalistalliance.desk.deskd.files.AgentFiles;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.text.Normalizer;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Attachments (the launch plan §2.7, §2.8 and §3.3; Wave 3.1; draft ADR "Courier's store" §10): Save to Files, Download,
 * an image's preview, an archive's file list and a message's raw download. The bytes come only from {@code desk-parse}'s
 * Courier mode, which cuts a part out of the kept raw message, draws an image again from its pixels, or reads an
 * archive's list without unpacking it. <b>deskd never opens, runs or renders an attachment</b>: it copies bytes the sandbox
 * gave it, looks at their first few bytes for a program's mark, and that's all.
 *
 * <p><b>Dangerous types</b> (the sandbox's {@code danger}: programs, scripts, Office files with macros, shortcuts, disk
 * images, archives holding programs or that can't be read, web pages and SVG) are named in every listing, never previewed,
 * and saved or downloaded only with {@code allowDanger: true}, the office's second press after it has said what the file
 * is. A file whose bytes start like a program is treated as {@code program} whatever the sandbox said.
 *
 * <p><b>Save to Files</b> writes through Files' own door ({@link AgentFiles}: the same tree, path rules, quota and floor,
 * and change feed as the Files app, never replacing anything) into {@code Courier/<date> <subject>/<name>}, the date in
 * the member's zone. Every file in Files is untrusted to an agent ({@code files_read} always adds {@code U}), so a saved
 * attachment carries that mark wherever it's moved. Images saved this way aren't sent to the image check, as with a Browser
 * download (ADR 0048 §8: not uploaded through MA).
 *
 * <p><b>Download, a preview and the raw message</b> go to the member's device over the desk's own {@code bulk} channel, as
 * {@code files.read} sends a file (API.md §12), so nothing of MA's sees the bytes. They're written to an unlinked file under
 * {@code /data/courier/parts} for the transfer's life, so a slow download holds no attachment in deskd's heap and nothing
 * stays on the volume after it.
 *
 * <p>One extraction runs at a time (the raw message and the part are both in memory for a moment: at most 48 MiB and
 * 25 MiB), so this can't add more than that to deskd's heap.
 */
final class CourierAttachments {

    private static final Logger log = LoggerFactory.getLogger(CourierAttachments.class);

    /** What the sandbox does with a kept message's parts: {@link CourierSandbox}'s three requests. */
    interface Parts {
        CourierSandbox.Answer part(byte[] raw, String part) throws CourierParser.Unavailable, InterruptedException;

        CourierSandbox.Answer image(byte[] raw, String part) throws CourierParser.Unavailable, InterruptedException;

        Map<String, Object> archive(byte[] raw, String part) throws CourierParser.Unavailable, InterruptedException;

        static Parts of(CourierSandbox sandbox) {
            return new Parts() {
                @Override
                public CourierSandbox.Answer part(byte[] raw, String part) throws CourierParser.Unavailable, InterruptedException {
                    return sandbox.part(raw, part);
                }

                @Override
                public CourierSandbox.Answer image(byte[] raw, String part) throws CourierParser.Unavailable, InterruptedException {
                    return sandbox.image(raw, part);
                }

                @Override
                public Map<String, Object> archive(byte[] raw, String part) throws CourierParser.Unavailable, InterruptedException {
                    return sandbox.archive(raw, part);
                }
            };
        }
    }

    /** The danger words the sandbox writes ({@code Danger}), most dangerous first. */
    static final Set<String> DANGER = Set.of("program", "script", "macros", "shortcut", "disk_image", "archive_programs", "html",
            "archive_unread");
    /** What a preview can be drawn from: the image kinds the sandbox draws again. */
    private static final Set<String> IMAGE_EXTENSIONS = Set.of("png", "jpg", "jpeg", "jpe", "gif", "bmp");
    static final String ROOT_FOLDER = "Courier";
    private static final int MAX_NAME_BYTES = 200;
    private static final int MAX_SUBJECT_CHARS = 80;
    private static final int ARCHIVE_ENTRIES = 500;

    private final Supplier<CourierStore> store;
    private final Clock clock;
    private final Semaphore one = new Semaphore(1);
    private volatile Parts parts;
    private volatile AgentFiles files;
    private volatile Transfers transfers;
    private volatile Supplier<Instant> pausedUntil = () -> null;

    CourierAttachments(Supplier<CourierStore> store, Parts parts, Clock clock) {
        this.store = store;
        this.parts = parts;
        this.clock = clock;
    }

    /** Files' door, the bulk transfers and the bandwidth pause, from deskd's other modules. */
    void through(AgentFiles files, Transfers transfers, Supplier<Instant> pausedUntil) {
        this.files = files;
        this.transfers = transfers;
        this.pausedUntil = pausedUntil == null ? () -> null : pausedUntil;
    }

    void parts(Parts p) {
        this.parts = p;
    }

    // ---- the methods

    /** {@code courier.attachment.save}: the part into Files. */
    Map<String, Object> save(RpcContext context, String messageId, String part, boolean allowDanger, ZoneId zone) throws Exception {
        AgentFiles door = files;
        if (door == null || !door.available()) {
            throw new RpcException(RpcException.UNAVAILABLE, "Files can't be used", Map.of("reason", "files"));
        }
        Queries.Attachment a = attachment(messageId, part);
        refuseDanger(a.danger(), allowDanger);
        String folder = ROOT_FOLDER + "/" + folderName(a.at(), a.subject(), zone);
        String name = fileName(a.name(), a.type(), a.part());
        // The permit covers the bytes' whole life here: the raw message, the part, and the write into Files (Security CR3-M1).
        acquire();
        try {
            Extracted x = extract(a, allowDanger);
            context.beginEffect();
            Saved saved = place(door, folder, name, x.bytes());
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("path", saved.path());
            out.put("folder", folder);
            out.put("name", saved.path().substring(saved.path().lastIndexOf('/') + 1));
            out.put("bytes", (long) x.bytes().length);
            out.put("sha256", x.sha256());
            out.put("already", saved.already());
            out.put("danger", x.danger());
            return out;
        } finally {
            one.release();
        }
    }

    /**
     * {@code courier.attachment.stop}: the member cancelled a Download or closed a preview, so this session's transfer ends
     * now (its staged bytes go with it) rather than waiting out its credit. Any other session's transfer is left alone.
     */
    void stop(RpcContext context, long transferId) {
        Transfers t = transfers;
        if (t != null) {
            t.stop(context.principal().sessionId(), transferId);
        }
    }

    /** {@code courier.attachment.read}: the part's bytes on {@code bulk}, for Download. */
    Map<String, Object> read(RpcContext context, String messageId, String part, boolean allowDanger) throws Exception {
        Transfers table = requireTransfers();
        refusePaused();
        Queries.Attachment a = attachment(messageId, part);
        refuseDanger(a.danger(), allowDanger);
        Transfer transfer = table.reserve(context.principal().sessionId());
        try {
            UnlinkedBody body;
            String danger;
            acquire();
            try {
                Extracted x = extract(a, allowDanger);
                danger = x.danger();
                body = stage(x.bytes(), x.sha256());
            } finally {
                one.release();
            }
            Map<String, Object> out = start(context, transfer, body);
            out.put("name", fileName(a.name(), a.type(), a.part()));
            // A dangerous type's own claim (text/html, image/svg+xml) is never handed on: save it as bytes (Security CR3-I3).
            out.put("type", danger != null ? "application/octet-stream" : safeType(a.type()));
            out.put("danger", danger);
            return out;
        } catch (Exception e) {
            transfer.stop();
            throw e;
        }
    }

    /**
     * {@code courier.attachment.image}: an image attachment drawn again from its pixels in the sandbox (PNG or JPEG, no
     * metadata), on {@code bulk}, for the preview the member asked for. Never for a dangerous type, nor anything the
     * sandbox can't draw.
     */
    Map<String, Object> image(RpcContext context, String messageId, String part) throws Exception {
        Transfers table = requireTransfers();
        refusePaused();
        Queries.Attachment a = attachment(messageId, part);
        if (a.danger() != null) {
            throw new RpcException(RpcException.FORBIDDEN, "This kind of file is never previewed", Map.of("reason", "danger", "danger", a.danger()));
        }
        if (!previewable(a.name(), a.type())) {
            throw new RpcException(RpcException.BAD_REQUEST, "Not an image Courier can show", Map.of("reason", "unsupported"));
        }
        Transfer transfer = table.reserve(context.principal().sessionId());
        try {
            UnlinkedBody body;
            String[] note;
            acquire();
            try {
                byte[] raw = raw(a.messageId());
                CourierSandbox.Ok ok;
                try {
                    ok = ok(parts().image(raw, a.part()));
                } catch (CourierParser.Unavailable e) {
                    throw parseUnavailable();
                }
                raw = null;
                note = ok.note().split(" ");
                body = stage(ok.body(), sha256(ok.body()));
            } finally {
                one.release();
            }
            Map<String, Object> out = start(context, transfer, body);
            out.put("format", note[0]);
            out.put("width", Integer.parseInt(note[1]));
            out.put("height", Integer.parseInt(note[2]));
            return out;
        } catch (Exception e) {
            transfer.stop();
            throw e;
        }
    }

    /** {@code courier.attachment.archive}: an archive's file list, read in the sandbox without unpacking, capped and cleaned. */
    Map<String, Object> archive(String messageId, String part) throws Exception {
        Queries.Attachment a = attachment(messageId, part);
        Map<String, Object> listing;
        acquire();
        try {
            byte[] raw = raw(a.messageId());
            listing = parts().archive(raw, a.part());
        } catch (CourierParser.Unavailable e) {
            throw parseUnavailable();
        } finally {
            one.release();
        }
        if (listing == null) {
            throw new RpcException(RpcException.BAD_REQUEST, "Not an archive Courier can list", Map.of("reason", "unsupported"));
        }
        return cleanListing(listing);
    }

    /**
     * {@code courier.message.raw}: the message exactly as it came, as a {@code .eml} file on {@code bulk}. One that carries a
     * dangerous attachment, or a virus verdict, needs {@code allowDanger} too: the {@code .eml} holds the same bytes
     * (Security CR3-I3). So does one the sandbox refused to read ({@code danger: unread}): nothing is known of what it holds.
     */
    Map<String, Object> raw(RpcContext context, String messageId, ZoneId zone, boolean allowDanger) throws Exception {
        Transfers table = requireTransfers();
        refusePaused();
        Map<String, Object> m = store.get().queries().message(messageId, 0);
        if (m == null) {
            throw CourierMethods.notFound();
        }
        refuseDanger(rawDanger(m, store.get().queries().anyDanger(messageId)), allowDanger);
        Transfer transfer = table.reserve(context.principal().sessionId());
        try {
            UnlinkedBody body;
            acquire();
            try {
                byte[] raw = raw(messageId);
                body = stage(raw, sha256(raw));
            } finally {
                one.release();
            }
            Map<String, Object> out = start(context, transfer, body);
            long at = m.get("at") instanceof Number n ? n.longValue() : clock.millis();
            out.put("name", folderName(at, (String) m.get("subject"), zone) + ".eml");
            return out;
        } catch (Exception e) {
            transfer.stop();
            throw e;
        }
    }

    /**
     * A danger word for the raw message: {@code program} for a virus verdict, else one of its attachments' (all of them,
     * not only the 500 a message shows: the confirming read's Info); null for none.
     */
    private static String rawDanger(Map<String, Object> m, String attachmentDanger) {
        if (m.get("auth") instanceof Map<?, ?> auth && Boolean.TRUE.equals(auth.get("virus"))) {
            return "program";
        }
        // A message the sandbox couldn't read has no attachment rows to look at: what it holds is unknown, so its raw
        // download asks first too (Security's CF-L1).
        if (attachmentDanger == null && m.get("parse") instanceof Map<?, ?> parse && "refused".equals(parse.get("state"))) {
            return UNREAD;
        }
        return attachmentDanger;
    }

    // ---- the steps

    private record Extracted(byte[] bytes, String sha256, String danger) {}

    private Queries.Attachment attachment(String messageId, String part) throws Exception {
        Queries.Attachment a = store.get().queries().attachment(messageId, part);
        if (a == null) {
            throw CourierMethods.notFound();
        }
        return a;
    }

    /** A raw message the sandbox couldn't read: not a type, but nothing is known of what it holds (Security's CF-L1). */
    private static final String UNREAD = "unread";

    private static void refuseDanger(String danger, boolean allowDanger) throws RpcException {
        if (danger != null && !allowDanger) {
            throw new RpcException(RpcException.FORBIDDEN, "This kind of file needs the member's second press",
                    Map.of("reason", "danger", "danger", DANGER.contains(danger) || UNREAD.equals(danger) ? danger : "program"));
        }
    }

    /**
     * The part's decoded bytes from the sandbox, checked: its own program mark makes it dangerous whatever the sandbox said.
     * Called holding the permit, which the caller keeps until the bytes are on disk.
     */
    private Extracted extract(Queries.Attachment a, boolean allowDanger) throws Exception {
        byte[] raw = raw(a.messageId());
        CourierSandbox.Answer answer;
        try {
            answer = parts().part(raw, a.part());
        } catch (CourierParser.Unavailable e) {
            throw parseUnavailable();
        }
        raw = null;
        byte[] bytes = ok(answer).body();
        String danger = a.danger();
        if (danger == null && looksLikeProgram(bytes)) {
            danger = "program";
            refuseDanger(danger, allowDanger);
        }
        return new Extracted(bytes, sha256(bytes), danger);
    }

    private byte[] raw(String messageId) throws Exception {
        byte[] raw = store.get().raw(messageId);
        if (raw == null) {
            throw new RpcException(RpcException.NOT_FOUND, "The message's bytes aren't on this desk", Map.of("reason", "raw"));
        }
        return raw;
    }

    private Parts parts() throws RpcException {
        Parts p = parts;
        if (p == null) {
            throw parseUnavailable();
        }
        return p;
    }

    private void acquire() throws RpcException, InterruptedException {
        if (!one.tryAcquire(60, TimeUnit.SECONDS)) {
            throw new RpcException(RpcException.UNAVAILABLE, "Busy with another attachment", Map.of("reason", "busy"));
        }
    }

    private static RpcException parseUnavailable() {
        return new RpcException(RpcException.UNAVAILABLE, "The desk can't read attachments right now", Map.of("reason", "parse"));
    }

    private static CourierSandbox.Ok ok(CourierSandbox.Answer answer) throws RpcException {
        if (answer instanceof CourierSandbox.Ok ok) {
            return ok;
        }
        String reason = ((CourierSandbox.Declined) answer).reason();
        switch (reason) {
            case "not_found" -> throw CourierMethods.notFound();
            case "too_large" -> throw new RpcException(RpcException.TOO_LARGE, "Too large to read safely", Map.of("reason", "too_large"));
            case "unsupported" -> throw new RpcException(RpcException.BAD_REQUEST, "Not something Courier can show", Map.of("reason", "unsupported"));
            default -> throw new RpcException(RpcException.UNAVAILABLE, "The attachment couldn't be read safely",
                    Map.of("reason", "refused", "cause", reason.matches("[a-z_]{1,32}") ? reason : "answer"));
        }
    }

    private Transfers requireTransfers() throws RpcException {
        Transfers t = transfers;
        if (t == null) {
            throw new RpcException(RpcException.UNAVAILABLE, "Downloads aren't ready", Map.of("reason", "transfers"));
        }
        return t;
    }

    /** The Platform's bandwidth pause refuses a new download, as it does {@code files.read}. */
    private void refusePaused() throws RpcException {
        Instant until = pausedUntil.get();
        if (until == null) {
            return;
        }
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("reason", "bandwidth_limit");
        details.put("resumesAt", until.equals(Instant.MAX) ? null : until.toString());
        throw new RpcException(RpcException.UNAVAILABLE, "Paused at the bandwidth limit", details);
    }

    /** The free space a download's staging must leave on the volume: the Browser's floor, as Files keeps it (ADR 0035). */
    static final long FLOOR_BYTES = 2L * 1024 * 1024 * 1024;
    private volatile java.util.function.LongSupplier usableBytes;

    /** For tests: the volume's usable bytes; by default the file store of the staging directory's. */
    void usableBytes(java.util.function.LongSupplier s) {
        this.usableBytes = s;
    }

    /**
     * The bytes staged for a download in an unlinked file, refused {@code no_space} {@code {reason: floor}} when that would
     * leave less than the floor free (Security CR3-L2). Called holding the permit.
     */
    private UnlinkedBody stage(byte[] bytes, String sha256) throws RpcException {
        try {
            Path dir = partsDir();
            java.util.function.LongSupplier free = usableBytes;
            long usable = free != null ? free.getAsLong() : Files.getFileStore(dir).getUsableSpace();
            if (usable - bytes.length < FLOOR_BYTES) {
                Map<String, Object> d = new LinkedHashMap<>();
                d.put("reason", "floor");
                d.put("needed", (long) bytes.length);
                throw new RpcException("no_space", "Not enough room on the drive", d);
            }
            return UnlinkedBody.write(dir, bytes, HexFormat.of().parseHex(sha256), clock.millis());
        } catch (IOException e) {
            throw new RpcException(RpcException.UNAVAILABLE, "The desk couldn't stage the download", Map.of("reason", "storage"));
        }
    }

    /** A reserved transfer given its staged bytes, sent once this call's reply has gone, as {@code files.read}'s is. */
    private static Map<String, Object> start(RpcContext context, Transfer transfer, UnlinkedBody body) throws RpcException {
        if (!transfer.attach(body)) {
            throw new RpcException(RpcException.UNAVAILABLE, "The session has ended", Map.of());
        }
        context.afterReply(transfer::start, transfer::stop);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("transferId", transfer.id());
        out.put("size", body.size());
        out.put("mtimeMs", body.mtimeMs());
        out.put("sha256", HexFormat.of().formatHex(body.trailer(), 0, 32));
        return out;
    }

    private Path partsDir() throws IOException {
        Path dir = store.get().partsDir();
        if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) {
            try {
                Files.createDirectory(dir, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            } catch (FileAlreadyExistsException e) {
                // Made meanwhile.
            }
        }
        if (Files.isSymbolicLink(dir)) {
            throw new IOException("parts is a link");
        }
        return dir;
    }

    /** Leftovers of a crash between staging and unlinking: none should outlive deskd. Called at start. */
    static void clearParts(Path dir) {
        if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        try (var entries = Files.newDirectoryStream(dir)) {
            for (Path p : entries) {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException e) {
                    log.warn("courier: a staged download couldn't be removed: {}", e.getClass().getSimpleName());
                }
            }
        } catch (IOException e) {
            log.warn("courier: the staging folder couldn't be read: {}", e.getClass().getSimpleName());
        }
    }

    // ---- into Files

    private record Saved(String path, boolean already) {}

    /**
     * Into Files, never replacing anything: the folders made as needed, and the name taken with " (2)", " (3)"... when it's
     * in use by other bytes. The same bytes already there under the name (or a numbered one) are that file: {@code already}.
     */
    private Saved place(AgentFiles door, String folder, String name, byte[] bytes) throws RpcException {
        String sha = sha256(bytes);
        try {
            ensureFolder(door, ROOT_FOLDER);
            ensureFolder(door, folder);
            for (int i = 1; i <= 50; i++) {
                String candidate = folder + "/" + numbered(name, i);
                AgentFiles.Before there = door.fileBefore(candidate);
                if (there != null) {
                    if (there.sha256().equals(sha)) {
                        return new Saved(candidate, true);
                    }
                    continue;
                }
                try {
                    door.write(candidate, bytes, false, null);
                    return new Saved(candidate, false);
                } catch (AgentFiles.Refusal r) {
                    if (!"exists".equals(r.word())) {
                        throw r;
                    }
                }
            }
            throw new RpcException(RpcException.CONFLICT, "Too many files of that name", Map.of("reason", "exists"));
        } catch (AgentFiles.Refusal r) {
            throw filesRefusal(r);
        }
    }

    private static void ensureFolder(AgentFiles door, String path) throws AgentFiles.Refusal {
        try {
            door.mkdir(path);
        } catch (AgentFiles.Refusal r) {
            if (!"exists".equals(r.word())) {
                throw r;
            }
            // There already: a folder is fine, and a file of that name is refused when it's written into (not_folder).
        }
    }

    private static RpcException filesRefusal(AgentFiles.Refusal r) {
        return switch (r.word()) {
            case "no_space" -> {
                Map<String, Object> d = new LinkedHashMap<>(r.extra());
                d.put("reason", Boolean.TRUE.equals(r.extra().get("cap")) ? "cap" : "floor");
                yield new RpcException("no_space", "Not enough room on the drive", d);
            }
            case "not_folder", "is_folder" -> new RpcException(RpcException.CONFLICT, "Something else has that name in Files",
                    Map.of("reason", "folder"));
            case "path" -> new RpcException(RpcException.BAD_REQUEST, "Not a name Files can use", Map.of("reason", "name"));
            default -> new RpcException(RpcException.UNAVAILABLE, "Files couldn't take it", Map.of("reason", "files"));
        };
    }

    // ---- names

    /** {@code 2026-11-14 Subject words}: the message's day in the member's zone, and its subject made safe for a folder. */
    static String folderName(long at, String subject, ZoneId zone) {
        LocalDate day = Instant.ofEpochMilli(at).atZone(zone == null ? java.time.ZoneOffset.UTC : zone).toLocalDate();
        String s = safe(subject, MAX_SUBJECT_CHARS);
        return day + " " + (s == null ? "No subject" : s);
    }

    /**
     * A file's name as Files keeps it and the member reads it: hidden, reordering and look-alike characters gone, no slash
     * or character another system refuses, no leading dot or trailing dot or space, NFC, and its real extension kept when
     * it's cut. With no usable name, "Attachment" and the type's extension.
     */
    static String fileName(String name, String type, String part) {
        String s = safe(name, 2000);
        if (s == null || s.chars().allMatch(ch -> ch == '.')) {
            String ext = extensionFor(type);
            return "Attachment" + (part == null ? "" : " " + part.replace('.', '-')) + (ext == null ? "" : "." + ext);
        }
        return cut(s, MAX_NAME_BYTES);
    }

    /** One line of text made safe for a name in Files; null if nothing's left. */
    static String safe(String text, int maxChars) {
        if (text == null) {
            return null;
        }
        String n = Normalizer.normalize(text, Normalizer.Form.NFKC);
        StringBuilder out = new StringBuilder(Math.min(n.length(), maxChars));
        for (int i = 0; i < n.length() && out.length() < maxChars; ) {
            int cp = n.codePointAt(i);
            i += Character.charCount(cp);
            if (dropped(cp)) {
                continue;
            }
            if (Character.isWhitespace(cp) || Character.isSpaceChar(cp)) {
                out.append(' ');
            } else if ("/\\:*?\"<>|".indexOf(cp) >= 0 || slashLike(cp)) {
                out.append('-');
            } else {
                out.appendCodePoint(cp);
            }
        }
        String one = out.toString().replaceAll(" +", " ");
        // No leading dot (a hidden file) or space; no trailing dot or space (Windows drops them, which changes the name).
        one = one.replaceAll("^[ .]+", "").replaceAll("[ .]+$", "");
        one = Normalizer.normalize(one, Normalizer.Form.NFC);
        return one.isEmpty() ? null : one;
    }

    private static boolean dropped(int cp) {
        if (cp < 0x20 || (cp >= 0x7F && cp <= 0x9F) || cp == 0xFFFD) {
            return true;
        }
        boolean variationSelector = (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF);
        if (variationSelector) {
            return false;
        }
        switch (Character.getType(cp)) {
            case Character.FORMAT, Character.CONTROL, Character.LINE_SEPARATOR, Character.PARAGRAPH_SEPARATOR,
                    Character.PRIVATE_USE, Character.UNASSIGNED, Character.SURROGATE -> {
                return true;
            }
            default -> {
            }
        }
        return cp == 0x034F || cp == 0x115F || cp == 0x1160 || cp == 0x17B4 || cp == 0x17B5 || (cp >= 0x180B && cp <= 0x180F)
                || cp == 0x3164 || cp == 0xFFA0 || (cp >= 0xFFF0 && cp <= 0xFFF8) || (cp >= 0x1BCA0 && cp <= 0x1BCA3)
                || (cp >= 0x1D173 && cp <= 0x1D17A) || (cp >= 0xE0000 && cp <= 0xE0FFF) || (cp >= 0x2060 && cp <= 0x206F)
                || (cp >= 0xFDD0 && cp <= 0xFDEF) || (cp & 0xFFFE) == 0xFFFE;
    }

    private static boolean slashLike(int cp) {
        return cp == 0x2215 || cp == 0x2044 || cp == 0xFF0F || cp == 0x29F8 || cp == 0x29F9 || cp == 0xFF3C || cp == 0x2216
                || cp == 0xFE68 || cp == 0x2571 || cp == 0x2572;
    }

    /** At most {@code maxBytes} of UTF-8, cut before the extension so the real one is always what the name ends with. */
    static String cut(String name, int maxBytes) {
        if (name.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= maxBytes) {
            return name;
        }
        int dot = name.lastIndexOf('.');
        String ext = dot > 0 && name.length() - dot <= 16 ? name.substring(dot) : "";
        String stem = ext.isEmpty() ? name : name.substring(0, dot);
        int room = maxBytes - ext.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        StringBuilder out = new StringBuilder();
        int used = 0;
        for (int i = 0; i < stem.length(); ) {
            int cp = stem.codePointAt(i);
            int n = new String(Character.toChars(cp)).getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
            if (used + n > room) {
                break;
            }
            out.appendCodePoint(cp);
            used += n;
            i += Character.charCount(cp);
        }
        String kept = out.toString().replaceAll("[ .]+$", "");
        return (kept.isEmpty() ? "Attachment" : kept) + ext;
    }

    /** {@code name.ext}, {@code name (2).ext}, ... */
    static String numbered(String name, int i) {
        if (i == 1) {
            return name;
        }
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) + " (" + i + ")" + name.substring(dot) : name + " (" + i + ")";
    }

    private static String extensionFor(String type) {
        if (type == null) {
            return null;
        }
        return switch (type.toLowerCase(Locale.ROOT)) {
            case "image/png" -> "png";
            case "image/jpeg" -> "jpg";
            case "image/gif" -> "gif";
            case "application/pdf" -> "pdf";
            case "text/plain" -> "txt";
            case "text/calendar" -> "ics";
            case "message/rfc822" -> "eml";
            case "application/zip" -> "zip";
            default -> null;
        };
    }

    /** A MIME type as the office may show it: {@code type/subtype}, nothing else. */
    static String safeType(String type) {
        if (type == null) {
            return null;
        }
        String t = type.strip().toLowerCase(Locale.ROOT);
        return t.matches("[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}") ? t : null;
    }

    static boolean previewable(String name, String type) {
        String t = safeType(type);
        if (t != null && (t.equals("image/png") || t.equals("image/jpeg") || t.equals("image/pjpeg") || t.equals("image/gif")
                || t.equals("image/bmp") || t.equals("image/x-ms-bmp"))) {
            return true;
        }
        if (name != null) {
            int dot = name.lastIndexOf('.');
            return dot >= 0 && IMAGE_EXTENSIONS.contains(name.substring(dot + 1).toLowerCase(Locale.ROOT).strip());
        }
        return false;
    }

    /**
     * A program's mark in its first bytes: a Windows executable ({@code MZ}), ELF, Mach-O (both byte orders, 32 and 64 bit,
     * and fat), a script's {@code #!}, a Windows shortcut. A second guard after the sandbox's own check of the bytes.
     */
    static boolean looksLikeProgram(byte[] b) {
        if (b == null || b.length < 2) {
            return false;
        }
        if (b[0] == 'M' && b[1] == 'Z') {
            return true;
        }
        if (b[0] == '#' && b[1] == '!') {
            return true;
        }
        if (b.length >= 4) {
            int m = (b[0] & 0xFF) << 24 | (b[1] & 0xFF) << 16 | (b[2] & 0xFF) << 8 | (b[3] & 0xFF);
            if (m == 0x7F454C46 || m == 0xFEEDFACE || m == 0xFEEDFACF || m == 0xCEFAEDFE || m == 0xCFFAEDFE || m == 0xCAFEBABE) {
                return true;
            }
            // A Windows shortcut: header size 0x4C, then its class id.
            if (m == 0x4C000000 && b.length >= 8 && (b[4] & 0xFF) == 0x01 && (b[5] & 0xFF) == 0x14 && b[6] == 0x02 && b[7] == 0x00) {
                return true;
            }
        }
        return false;
    }

    /** The sandbox's archive list as the office may show it: 500 entries, each name cleaned and cut, only known words. */
    @SuppressWarnings("unchecked")
    static Map<String, Object> cleanListing(Map<String, Object> listing) {
        Map<String, Object> out = new LinkedHashMap<>();
        Object format = listing.get("format");
        out.put("format", "zip".equals(format) || "tar".equals(format) ? format : null);
        List<Map<String, Object>> entries = new java.util.ArrayList<>();
        if (listing.get("entries") instanceof List<?> list) {
            for (Object o : list) {
                if (entries.size() == ARCHIVE_ENTRIES || !(o instanceof Map<?, ?> e)) {
                    break;
                }
                Map<String, Object> clean = new LinkedHashMap<>();
                String name = Norm.line(e.get("name") instanceof String s ? s : null, 400);
                clean.put("name", name == null ? "?" : name);
                clean.put("bytes", e.get("bytes") instanceof Number n && n.longValue() >= 0 ? n.longValue() : null);
                clean.put("dir", Boolean.TRUE.equals(e.get("dir")));
                clean.put("encrypted", Boolean.TRUE.equals(e.get("encrypted")));
                Object d = e.get("danger");
                clean.put("danger", d instanceof String ds && DANGER.contains(ds) ? ds : null);
                entries.add(clean);
            }
        }
        out.put("entries", entries);
        Object total = listing.get("total");
        out.put("total", total instanceof Number n && n.longValue() >= 0 ? n.longValue() : (long) entries.size());
        out.put("truncated", Boolean.TRUE.equals(listing.get("truncated"))
                || (listing.get("entries") instanceof List<?> l && l.size() > entries.size()));
        Object d = listing.get("danger");
        out.put("danger", d instanceof String ds && DANGER.contains(ds) ? ds : null);
        return out;
    }

    static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---- the transfer's body

    /**
     * Bytes staged in a file that is unlinked as soon as it's written: the open channel is all that holds them, so they're
     * gone from the volume when the transfer ends or deskd stops, however it stops. The trailer is the SHA-256 and the size.
     */
    static final class UnlinkedBody implements Transfer.Body {
        private static final SecureRandom RANDOM = new SecureRandom();
        private final FileChannel channel;
        private final long size;
        private final long mtimeMs;
        private final byte[] trailer;
        private long position;

        private UnlinkedBody(FileChannel channel, long size, long mtimeMs, byte[] trailer) {
            this.channel = channel;
            this.size = size;
            this.mtimeMs = mtimeMs;
            this.trailer = trailer;
        }

        static UnlinkedBody write(Path dir, byte[] bytes, byte[] sha256, long mtimeMs) throws IOException {
            byte[] id = new byte[12];
            RANDOM.nextBytes(id);
            Path file = dir.resolve(".dl-" + HexFormat.of().formatHex(id));
            FileChannel ch = FileChannel.open(file, Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.READ, StandardOpenOption.WRITE,
                    LinkOption.NOFOLLOW_LINKS), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            try {
                Files.delete(file);
                ByteBuffer buf = ByteBuffer.wrap(bytes);
                while (buf.hasRemaining()) {
                    ch.write(buf);
                }
                ByteBuffer t = ByteBuffer.allocate(40);
                t.put(sha256);
                t.putLong(bytes.length);
                return new UnlinkedBody(ch, bytes.length, mtimeMs, t.array());
            } catch (IOException | RuntimeException e) {
                ch.close();
                Files.deleteIfExists(file);
                throw e;
            }
        }

        @Override
        public long size() {
            return size;
        }

        @Override
        public long mtimeMs() {
            return mtimeMs;
        }

        @Override
        public boolean atEnd() {
            return position >= size;
        }

        @Override
        public int read(byte[] into, int length) throws IOException {
            int want = (int) Math.min(length, size - position);
            if (want <= 0) {
                return 0;
            }
            ByteBuffer buf = ByteBuffer.wrap(into, 0, want);
            int got = 0;
            while (buf.hasRemaining()) {
                int n = channel.read(buf, position + got);
                if (n < 0) {
                    throw new IOException("short");
                }
                got += n;
            }
            position += got;
            return got;
        }

        @Override
        public byte[] trailer() {
            return trailer;
        }

        @Override
        public void close() {
            try {
                channel.close();
            } catch (IOException e) {
                // Closed either way.
            }
        }
    }
}
