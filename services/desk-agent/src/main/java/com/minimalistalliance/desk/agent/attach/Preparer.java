package com.minimalistalliance.desk.agent.attach;

import com.minimalistalliance.desk.agent.provider.Attachment;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Turns the files of a message into what a model call carries (ADR 0049): text for documents and code, image input for
 * pictures. Applies the caps, refuses what the chosen model can't take, and zeroes every staged buffer it was given
 * whatever happens. Keeps no copy of anything.
 */
public final class Preparer {

    /** Most pixels on a side that every provider takes. */
    static final int MAX_SIDE = 8000;

    private final Parsers parsers;

    /** The readers, which the Agent's {@code files_read} shares for a document from Files. */
    public Parsers parsers() {
        return parsers;
    }

    public Preparer(Parsers parsers) {
        this.parsers = parsers;
    }

    /** The files as attachments. The caller must {@link Attachment#wipe} them when the run is over. */
    public List<Attachment> prepare(List<Staging.Staged> files, Caps caps, ProviderId provider, String model)
            throws AttachException {
        List<Attachment> made = new ArrayList<>();
        try {
            long total = 0;
            for (Staging.Staged file : files) {
                total += file.bytes().length;
            }
            if (total > caps.maxTotalBytes()) {
                throw new AttachException("total_too_large", null, caps.maxTotalBytes());
            }
            long pictures = 0;
            for (Staging.Staged file : files) {
                if (Sniff.of(file.name(), file.bytes()).format() == Sniff.Format.IMAGE) {
                    pictures += file.bytes().length;
                }
            }
            if (pictures > ImageBudget.LIMIT) {
                throw new AttachException("total_too_large", null, ImageBudget.LIMIT);
            }
            int charsLeft = caps.maxTotalChars();
            for (Staging.Staged file : files) {
                Attachment attachment = one(file, caps, provider, model, charsLeft);
                made.add(attachment);
                if (attachment.kind() == Attachment.Kind.TEXT) {
                    charsLeft -= attachment.text().length();
                }
            }
            return made;
        } catch (AttachException | RuntimeException e) {
            made.forEach(Attachment::wipe);
            throw e;
        } finally {
            // Images keep their buffer as the attachment's bytes; the rest are done with.
            for (Staging.Staged file : files) {
                boolean kept = made.stream().anyMatch(a -> a.image() == file.bytes());
                if (!kept) {
                    Arrays.fill(file.bytes(), (byte) 0);
                }
            }
        }
    }

    private Attachment one(Staging.Staged file, Caps caps, ProviderId provider, String model, int charsLeft)
            throws AttachException {
        String name = file.name();
        byte[] bytes = file.bytes();
        Sniff.Kind kind = Sniff.of(name, bytes);
        long size = bytes.length;
        switch (kind.format()) {
            case IMAGE -> {
                if (size > caps.maxImageBytes()) {
                    throw new AttachException("too_large", name, caps.maxImageBytes());
                }
                if (!Vision.supports(provider, model)) {
                    throw new AttachException("no_vision", name);
                }
                if (kind.width() < 1 || kind.height() < 1) {
                    throw new AttachException("unreadable", name);
                }
                if (kind.width() > MAX_SIDE || kind.height() > MAX_SIDE) {
                    throw new AttachException("image_too_big", name, (long) MAX_SIDE);
                }
                return Attachment.image(name, kind.label(), kind.mime(), size, bytes,
                        Vision.reserveTokens(provider, kind.width(), kind.height()));
            }
            case LEGACY_OFFICE -> throw new AttachException("legacy_office", name);
            case OTHER -> throw new AttachException("unsupported_type", name);
            default -> {
                // Documents and text: read in the child.
            }
        }
        if (size > caps.maxFileBytes()) {
            throw new AttachException("too_large", name, caps.maxFileBytes());
        }
        if (charsLeft < 1000) {
            throw new AttachException("too_long", name, (long) caps.maxTotalChars());
        }
        String worker = switch (kind.format()) {
            case PDF -> "pdf";
            case DOCX -> "docx";
            case XLSX -> "xlsx";
            case PPTX -> "pptx";
            default -> "text";
        };
        Parsers.Text text = parsers.read(worker, bytes, Math.min(caps.maxFileChars(), charsLeft), caps.maxPdfPages(),
                name);
        String note = text.cut() ? "cut" : null;
        return Attachment.text(name, kind.label(), size, text.text(), note);
    }
}
