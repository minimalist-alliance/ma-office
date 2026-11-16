package com.minimalistalliance.desk.courier.testkit;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.stream.IntStream;
import java.util.stream.Stream;

/**
 * Courier's MIME corpus: raw messages, each with what a correct parser makes of it. Three sources: the hand-written
 * samples (resources {@code courier-testkit/mime/}, one {@code .eml} per row of {@code expect.tsv}), a seeded generator of
 * thousands more, and messages built on demand at and over the parser's limits. Nothing here reads the clock, the host or
 * the default locale, so a seed gives the same bytes on every run.
 *
 * <p>What {@link Expect} means, field by field, is on the record; the README has the families.
 */
public final class MimeCorpus {

    /** The parser's limits (the Courier launch plan §3.1). Over any of them a message is refused, never half read. */
    public static final int MAX_PARTS = 2000;
    /** Multiparts nested inside one another, the message's own counted as the first. */
    public static final int MAX_DEPTH = 20;
    /** 40 MiB, the whole raw message. */
    public static final int MAX_BYTES = 41_943_040;
    public static final long MAX_PARSE_MILLIS = 10_000;

    /** The reasons a parser refuses with. */
    public static final String TOO_LARGE = "too_large";
    public static final String TOO_DEEP = "too_deep";
    public static final String TOO_MANY_PARTS = "too_many_parts";
    public static final String TIMEOUT = "timeout";
    public static final String MALFORMED = "malformed";
    public static final String TOO_COMPLEX = "too_complex";

    public static final long DEFAULT_SEED = 20261113L;
    public static final int STANDARD_COUNT = 5000;

    private static final String MIME_DIR = "/courier-testkit/mime/";

    private MimeCorpus() {
    }

    /** What a parser should do with a sample. */
    public enum Outcome {
        /** Read it: a message, with the fields {@link Expect} names. */
        READ,
        /** Refuse it, with {@link Expect#reason()}. */
        REFUSED,
        /** Malformed input a parser may read or cleanly refuse (any reason); nothing else is checked. */
        EITHER
    }

    /**
     * What a correct parser yields. {@code reason} is set only for {@link Outcome#REFUSED}. For the rest, null means not
     * checked:
     * <ul>
     *   <li>{@code subject}: the decoded subject, unfolded (CRLF removed, the folding whitespace kept) with RFC 2047 words
     *       decoded and the space between adjacent encoded words dropped. The empty string means the message has no
     *       subject (a parser yields null or empty). deskd's own rows show it as the store keeps it, controls and bidi
     *       overrides stripped.
     *   <li>{@code from}: the first From mailbox's address, lowercase (compare ignoring case); {@code nobody@invalid} when
     *       the message names no sender, as deskd's store shows one.
     *   <li>{@code attachments}: the leaf parts a reader sees as attachments: every leaf except the body (the first
     *       text/plain and the first text/html with no file name and not marked attachment) and except parts marked
     *       {@code Content-Disposition: inline}; a message/rfc822 part counts once and isn't descended.
     *   <li>{@code word}: lowercase, at least four letters, found in the decoded body text (the text/plain body, or the
     *       HTML's visible text when there's no plain part), ignoring case.
     * </ul>
     */
    public record Expect(Outcome outcome, String reason, String subject, String from, Integer attachments, String word) {

        public Expect {
            Objects.requireNonNull(outcome, "outcome");
            if (outcome == Outcome.REFUSED && (reason == null || reason.isBlank())) {
                throw new IllegalArgumentException("a refusal needs a reason");
            }
            if (outcome != Outcome.REFUSED && reason != null) {
                throw new IllegalArgumentException("only a refusal has a reason");
            }
            if (attachments != null && attachments < 0) {
                throw new IllegalArgumentException("attachments " + attachments);
            }
        }

        public static Expect read(String subject, String from, Integer attachments, String word) {
            return new Expect(Outcome.READ, null, subject, from, attachments, word);
        }

        public static Expect refused(String reason) {
            return new Expect(Outcome.REFUSED, reason, null, null, null, null);
        }

        public static Expect either() {
            return new Expect(Outcome.EITHER, null, null, null, null, null);
        }
    }

    /**
     * One raw message: {@code name} is unique in {@link #standard()}, {@code family} groups samples by what they test
     * (README). {@code raw} is the sample's own array, not a copy: don't change it.
     */
    public record Sample(String name, String family, byte[] raw, Expect expect) {

        public Sample {
            Objects.requireNonNull(name, "name");
            Objects.requireNonNull(family, "family");
            Objects.requireNonNull(raw, "raw");
            Objects.requireNonNull(expect, "expect");
        }

        @Override
        public boolean equals(Object o) {
            return o instanceof Sample s && name.equals(s.name) && family.equals(s.family) && Arrays.equals(raw, s.raw)
                    && expect.equals(s.expect);
        }

        @Override
        public int hashCode() {
            return Objects.hash(name, family, Arrays.hashCode(raw), expect);
        }

        @Override
        public String toString() {
            return name + " (" + family + ", " + raw.length + " bytes, " + expect + ")";
        }
    }

    /** The hand-written samples, in {@code expect.tsv}'s order: deskd's 27 first, then the test kit's own. */
    public static List<Sample> handWritten() {
        List<Sample> out = new ArrayList<>();
        for (String line : lines(MIME_DIR + "expect.tsv")) {
            if (line.isBlank() || line.startsWith("#")) {
                continue;
            }
            String[] f = line.split("\t", -1);
            if (f.length != 7) {
                throw new IllegalStateException("expect.tsv: 7 columns wanted: " + line);
            }
            out.add(new Sample(f[0], f[6], bytes(MIME_DIR + f[0] + ".eml"), expectOf(f)));
        }
        return List.copyOf(out);
    }

    /** {@code count} generated samples, {@code gen-<family>-<n>} for n from 0: the same bytes for a seed on every run. */
    public static Stream<Sample> generated(long seed, int count) {
        if (count < 0) {
            throw new IllegalArgumentException("count " + count);
        }
        return IntStream.range(0, count).mapToObj(n -> Generator.sample(seed, n));
    }

    /** {@link #handWritten()}, then {@link #generated} for {@link #DEFAULT_SEED} and {@link #STANDARD_COUNT}. */
    public static Stream<Sample> standard() {
        return Stream.concat(handWritten().stream(), generated(DEFAULT_SEED, STANDARD_COUNT));
    }

    /**
     * Built on demand, never stored: a valid message of exactly {@code bytes} bytes, nearly all of it one base64
     * attachment. Read when it's at most {@link #MAX_BYTES}, refused {@code too_large} over it.
     */
    public static Sample large(int bytes) {
        return Limits.large(bytes);
    }

    /** A valid message one byte over {@link #MAX_BYTES}: refused {@code too_large}. */
    public static Sample overLimit() {
        return Limits.large(MAX_BYTES + 1);
    }

    /**
     * {@code depth} multiparts, each inside the last, the message's own the first, with a text part at the bottom: read
     * up to {@link #MAX_DEPTH}, refused {@code too_deep} past it. 1 to 1,000.
     */
    public static Sample tooDeep(int depth) {
        return Limits.deep(depth);
    }

    /**
     * A message of exactly {@code parts} MIME parts, counting every one: the message itself, its multipart and each leaf
     * (so a multipart/mixed of a text part and {@code parts - 2} attachments; one part is a plain text message). Read up
     * to {@link #MAX_PARTS}, refused {@code too_many_parts} past it. 1 to 50,000.
     */
    public static Sample tooManyParts(int parts) {
        return Limits.many(parts);
    }

    private static Expect expectOf(String[] f) {
        String outcome = f[1];
        if (outcome.startsWith("refused:")) {
            return Expect.refused(outcome.substring("refused:".length()));
        }
        return switch (outcome) {
            case "either" -> Expect.either();
            case "ok" -> Expect.read(f[2].equals("-") ? null : f[2], dash(f[3]),
                    f[4].equals("-") ? null : Integer.valueOf(f[4]), dash(f[5]));
            default -> throw new IllegalStateException("expect.tsv: outcome " + outcome + " for " + f[0]);
        };
    }

    private static String dash(String s) {
        return s.equals("-") ? null : s.toLowerCase(Locale.ROOT).equals(s) ? s : s.toLowerCase(Locale.ROOT);
    }

    static byte[] bytes(String resource) {
        try (InputStream in = MimeCorpus.class.getResourceAsStream(resource)) {
            if (in == null) {
                throw new IllegalStateException("missing resource " + resource);
            }
            return in.readAllBytes();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static List<String> lines(String resource) {
        try (InputStream in = MimeCorpus.class.getResourceAsStream(resource)) {
            if (in == null) {
                throw new IllegalStateException("missing resource " + resource);
            }
            return new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8)).lines().toList();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
