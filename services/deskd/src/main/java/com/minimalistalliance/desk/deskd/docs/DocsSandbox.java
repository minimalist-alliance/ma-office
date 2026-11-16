package com.minimalistalliance.desk.deskd.docs;

import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.parse.CourierSandbox;
import java.util.Map;

/**
 * Documents' side of the parse sandbox (the draft ADR's decision 5): text per page and pages drawn as images, through
 * the sandbox deskd already reaches for mail ({@link CourierSandbox}, one request at a time, shared with Courier). The
 * original bytes go in; only text and freshly drawn pixels come out.
 */
public interface DocsSandbox {

    /** The sandbox can't be reached, or its worker is older than the documents mode: try again later. */
    final class Unavailable extends Exception {
        private static final long serialVersionUID = 1L;

        Unavailable(String why) {
            super(why, null, false, false);
        }
    }

    /** The worker read it and won't: {@code encrypted}, {@code unreadable}, {@code too_complex}, {@code too_large}, ... */
    final class Refused extends Exception {
        private static final long serialVersionUID = 1L;
        private final String reason;

        Refused(String reason) {
            super(reason, null, false, false);
            this.reason = reason;
        }

        String reason() {
            return reason;
        }
    }

    record Image(String format, int width, int height, byte[] bytes) {}

    /** {@code docs1 read}: at most 100,000 characters and 500 pages, the index's own caps. */
    DocText read(String kind, byte[] file) throws Unavailable, Refused, InterruptedException;

    /** {@code docs1 render}: one PDF page as a JPEG. */
    Image render(byte[] pdf, int page, int width) throws Unavailable, Refused, InterruptedException;

    /** An image drawn again from its pixels ({@code courier1 image -}): PNG or JPEG, at most 2,048 px a side. */
    Image image(byte[] bytes) throws Unavailable, Refused, InterruptedException;

    int READ_CHARS = 100_000;
    int READ_PAGES = 500;
    int MAX_READ_ANSWER = 8 << 20;
    /**
     * The most JSON tokens a reading may have, Courier's own cap (Security CP-L4, DOC-L1): the worker sends at most 20,000
     * lines in all, so a real answer stays far under it, and a taken-over worker can't fill deskd's heap with tokens.
     */
    long MAX_TOKENS = 400_000;
    int MAX_RENDER_ANSWER = (4 << 20) + 64;

    /** The real one, over Courier's sandbox client. */
    static DocsSandbox over(CourierSandbox sandbox) {
        return new DocsSandbox() {
            @Override
            public DocText read(String kind, byte[] file) throws Unavailable, Refused, InterruptedException {
                CourierSandbox.Answer a = call(sandbox, "docs1 read " + kind + " " + READ_CHARS + " " + READ_PAGES, file, MAX_READ_ANSWER);
                CourierSandbox.Ok ok = (CourierSandbox.Ok) a;
                if (!ok.note().isEmpty()) {
                    throw new Refused("answer");
                }
                try {
                    return DocText.from(Answers.object(ok.body()));
                } catch (IllegalArgumentException | ClassCastException e) {
                    throw new Refused("answer");
                }
            }

            @Override
            public Image render(byte[] pdf, int page, int width) throws Unavailable, Refused, InterruptedException {
                CourierSandbox.Ok ok = (CourierSandbox.Ok) call(sandbox, "docs1 render " + page + " " + width, pdf, MAX_RENDER_ANSWER);
                return decoded(ok, "jpeg");
            }

            @Override
            public Image image(byte[] bytes) throws Unavailable, Refused, InterruptedException {
                CourierSandbox.Answer a;
                try {
                    a = sandbox.image(bytes, null);
                } catch (CourierParser.Unavailable e) {
                    throw new Unavailable(e.getMessage());
                }
                if (a instanceof CourierSandbox.Declined d) {
                    throw new Refused(d.reason());
                }
                return decoded((CourierSandbox.Ok) a, "png|jpeg");
            }
        };
    }

    private static CourierSandbox.Answer call(CourierSandbox sandbox, String line, byte[] file, int cap)
            throws Unavailable, Refused, InterruptedException {
        CourierSandbox.Answer a;
        try {
            a = sandbox.docs(line, file, cap);
        } catch (CourierParser.Unavailable e) {
            throw new Unavailable(e.getMessage());
        }
        if (a instanceof CourierSandbox.Declined d) {
            throw new Refused(d.reason());
        }
        return a;
    }

    private static Image decoded(CourierSandbox.Ok ok, String formats) throws Refused {
        String[] f = ok.note().split(" ");
        if (f.length != 3 || !f[0].matches(formats) || !f[1].matches("[1-9][0-9]{0,4}") || !f[2].matches("[1-9][0-9]{0,4}")
                || ok.body().length == 0) {
            throw new Refused("answer");
        }
        return new Image(f[0], Integer.parseInt(f[1]), Integer.parseInt(f[2]), ok.body());
    }

    /** The worker's JSON, read with bounds: nesting, tokens and bytes, no repeated keys, nothing after the object. */
    final class Answers {
        private Answers() {}

        private static final tools.jackson.jr.ob.JSON JSON = tools.jackson.jr.ob.JSON.builder(tools.jackson.core.json.JsonFactory.builder()
                        .recyclerPool(tools.jackson.core.util.JsonRecyclerPools.nonRecyclingPool())
                        .streamReadConstraints(tools.jackson.core.StreamReadConstraints.builder()
                                .maxNestingDepth(12)
                                .maxTokenCount(MAX_TOKENS)
                                .maxDocumentLength(MAX_READ_ANSWER)
                                .maxStringLength(1 << 20)
                                .build())
                        .build())
                .disable(tools.jackson.jr.ob.JSON.Feature.HANDLE_JAVA_BEANS)
                .disable(tools.jackson.jr.ob.JSON.Feature.USE_DEFERRED_MAPS)
                .build();

        static Map<String, Object> object(byte[] body) {
            try (tools.jackson.core.JsonParser parser = JSON.createParser(body)) {
                Map<String, Object> object = JSON.mapFrom(parser);
                if (object == null || parser.nextToken() != null) {
                    throw new IllegalArgumentException("json");
                }
                return object;
            } catch (tools.jackson.core.JacksonException e) {
                throw new IllegalArgumentException("json");
            }
        }

        static Map<String, Object> object(String text) {
            return object(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }

        static String write(Object value) {
            try {
                return JSON.asString(value);
            } catch (tools.jackson.core.JacksonException e) {
                throw new IllegalArgumentException("json");
            }
        }
    }
}
