package com.minimalistalliance.desk.courier.testkit;

import com.minimalistalliance.desk.courier.testkit.Langs.Cs;
import com.minimalistalliance.desk.courier.testkit.Langs.Lang;
import com.minimalistalliance.desk.courier.testkit.Langs.Wire;
import com.minimalistalliance.desk.courier.testkit.MimeCorpus.Expect;
import com.minimalistalliance.desk.courier.testkit.MimeCorpus.Sample;
import com.minimalistalliance.desk.courier.testkit.Mime.Entity;
import java.io.ByteArrayOutputStream;
import java.net.IDN;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.SplittableRandom;

/**
 * The seeded generator behind {@link MimeCorpus#generated}. Sample {@code n} of a seed comes from its own
 * {@link SplittableRandom}, seeded from the seed and {@code n} alone, so any sample can be made by itself and a shorter run
 * is a prefix of a longer one. Its family comes from a fixed cycle of 25, so every family turns up in any 25 samples.
 *
 * <p>Every {@code READ} sample is built so that its {@link Expect} holds by construction: the subject is the text the
 * header encodes, the sender the address written, attachments only parts marked {@code attachment}, and the word one
 * written into the body text (checked against the body's own charset both ways before the sample is returned).
 */
final class Generator {

    private Generator() {
    }

    /** What a generated sample tests. */
    enum Family {
        CHARSET, ENCODING, HEADER, STRUCTURE, ATTACHMENT, HTML, LINKS, MUTATION;

        String id() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    /** Charset 6 in 25, structure 4, header, encoding and attachment 3, HTML, links and mutation 2. */
    private static final Family[] SCHEDULE = {
        Family.CHARSET, Family.STRUCTURE, Family.HEADER, Family.ENCODING, Family.ATTACHMENT,
        Family.CHARSET, Family.HTML, Family.LINKS, Family.CHARSET, Family.STRUCTURE,
        Family.MUTATION, Family.HEADER, Family.CHARSET, Family.ENCODING, Family.ATTACHMENT,
        Family.STRUCTURE, Family.CHARSET, Family.HTML, Family.HEADER, Family.LINKS,
        Family.CHARSET, Family.ENCODING, Family.ATTACHMENT, Family.STRUCTURE, Family.MUTATION,
    };

    private static final Cs UTF8 = Langs.cs("utf-8");

    /** A built message and what a parser should make of it. */
    record Built(byte[] raw, Expect expect) {
    }

    static Sample sample(long seed, int n) {
        Family family = SCHEDULE[n % SCHEDULE.length];
        Ctx c = new Ctx(new SplittableRandom(mix(seed, n)), n);
        Built b = build(family, c);
        return new Sample("gen-" + family.id() + "-" + n, family.id(), b.raw(), b.expect());
    }

    /** SplitMix64's finalizer over the seed and the index: independent streams for neighbouring samples. */
    static long mix(long seed, int n) {
        long z = seed + 0x9E3779B97F4A7C15L * (n + 1L);
        z = (z ^ (z >>> 30)) * 0xBF58476D1CE4E5B9L;
        z = (z ^ (z >>> 27)) * 0x94D049BB133111EBL;
        return z ^ (z >>> 31);
    }

    private static Built build(Family family, Ctx c) {
        return switch (family) {
            case CHARSET -> charset(c);
            case ENCODING -> encoding(c);
            case HEADER -> header(c);
            case STRUCTURE -> structure(c);
            case ATTACHMENT -> attachment(c);
            case HTML -> html(c);
            case LINKS -> links(c);
            case MUTATION -> mutation(c);
        };
    }

    // ---- The families ----

    /** One language in one charset: plain, HTML or both, every transfer encoding the charset allows, subject in it too. */
    private static Built charset(Ctx c) {
        Cs cs = c.pick(Langs.CHARSETS);
        Lang lang = c.pick(cs.langs());
        Text t = text(c, lang, cs.charset(), c.between(1, 3));
        Subject s = subject(c, lang, cs);
        Sender from = sender(c, lang, cs);
        Entity root = envelope(c, from, s.header());
        switch (c.between(0, 2)) {
            case 0 -> textPart(c, root, "plain", t.plain(), cs);
            case 1 -> textPart(c, root, "html", htmlDoc(cs.label(), t.html()), cs);
            default -> root.multipart("alternative", c.boundary(), null)
                    .add(textPart(c, new Entity(), "plain", t.plain(), cs))
                    .add(textPart(c, new Entity(), "html", htmlDoc(cs.label(), t.html()), cs));
        }
        return new Built(root.bytes(), Expect.read(s.text(), from.address(), 0, t.word()));
    }

    private enum Cte {
        SEVEN_BIT, NONE, EIGHT_BIT, BINARY, BASE64, BASE64_SHORT_LINES, BASE64_ONE_LINE, QP, QP_UPPER, BASE64_MIXED_CASE
    }

    /** Every transfer encoding and how it's spelled, on the body and sometimes on a text attachment, and bare-LF mail. */
    private static Built encoding(Ctx c) {
        Cte cte = c.pick(Arrays.asList(Cte.values()));
        boolean ascii = cte == Cte.SEVEN_BIT || cte == Cte.NONE;
        Lang lang = ascii ? Langs.EN : c.pick(Langs.LATIN);
        Cs cs = ascii ? Langs.cs("us-ascii") : UTF8;
        Text t = text(c, lang, cs.charset(), c.between(1, 3));
        String body = t.plain();
        if (cte == Cte.BINARY) {
            // Binary allows lines past 998: one paragraph on a single long line, a few times over.
            String line = t.plain().replace("\r\n", " ");
            body = (line + " ").repeat(Math.max(1, 1200 / Math.max(1, line.length()) + 1)).strip();
        }
        Subject s = c.chance(0.5) ? plainSubject(c, Langs.EN) : subject(c, lang, UTF8);
        Sender from = sender(c, lang, UTF8);
        Entity root = envelope(c, from, s.header());
        int attachments = 0;
        Entity bodyPart = root;
        if (c.chance(0.3)) {
            root.multipart("mixed", c.boundary(), null);
            bodyPart = new Entity();
            root.add(bodyPart);
            Entity att = new Entity();
            Cte other = c.pick(List.of(Cte.BASE64, Cte.QP, Cte.EIGHT_BIT, Cte.BASE64_ONE_LINE));
            Text notes = text(c, lang, UTF8.charset(), 1);
            att.header("Content-Type", "text/plain; charset=utf-8; name=\"notes.txt\"");
            att.header("Content-Disposition", "attachment; filename=\"notes.txt\"");
            encodeWith(att, other, notes.plain().getBytes(StandardCharsets.UTF_8));
            root.add(att);
            attachments = 1;
        }
        bodyPart.header("Content-Type", "text/plain; charset=" + c.labelCase(cs.label()) + (c.chance(0.2) ? "; format=flowed" : ""));
        encodeWith(bodyPart, cte, body.getBytes(cs.charset()));
        byte[] raw = root.bytes();
        if (c.chance(0.12)) {
            raw = withoutCr(raw);
        }
        return new Built(raw, Expect.read(s.text(), from.address(), attachments, t.word()));
    }

    private static void encodeWith(Entity e, Cte cte, byte[] bytes) {
        switch (cte) {
            case SEVEN_BIT -> e.header("Content-Transfer-Encoding", "7bit").body(bytes);
            case NONE -> e.body(bytes);
            case EIGHT_BIT -> e.header("Content-Transfer-Encoding", "8bit").body(bytes);
            case BINARY -> e.header("Content-Transfer-Encoding", "binary").body(bytes);
            case BASE64 -> e.header("Content-Transfer-Encoding", "base64").body(Mime.base64(bytes, 76));
            case BASE64_SHORT_LINES -> e.header("Content-Transfer-Encoding", "base64").body(Mime.base64(bytes, 64));
            case BASE64_ONE_LINE -> e.header("Content-Transfer-Encoding", "base64").body(Mime.base64(bytes, 0));
            case QP -> e.header("Content-Transfer-Encoding", "quoted-printable").body(Mime.quotedPrintable(bytes, true));
            case QP_UPPER -> e.header("Content-Transfer-Encoding", "QUOTED-PRINTABLE").body(Mime.quotedPrintable(bytes, true));
            case BASE64_MIXED_CASE -> e.header("Content-Transfer-Encoding", "Base64").body(Mime.base64(bytes, 76));
        }
    }

    /** Subjects and senders the hard ways: long folded words, Q in Latin charsets, mixed plain and encoded, raw UTF-8. */
    private static Built header(Ctx c) {
        Lang lang = c.pick(Langs.ALL);
        String subjectText;
        String subjectHeader;
        switch (c.between(0, 6)) {
            case 0 -> {
                // Long and in many B words, folded.
                subjectText = words(c, lang, UTF8.charset(), c.between(8, 16), true);
                subjectHeader = Mime.encodedWords(subjectText, StandardCharsets.UTF_8, c.labelCase("utf-8"), true);
            }
            case 1 -> {
                // Q words in a Latin charset, underscores for spaces.
                Cs cs = Langs.cs(c.pick(List.of("iso-8859-1", "iso-8859-2", "iso-8859-15", "windows-1252")));
                Lang l = c.pick(cs.langs());
                subjectText = words(c, l, cs.charset(), c.between(3, 9), true);
                subjectHeader = Mime.encodedWords(subjectText, cs.charset(), c.labelCase(cs.label()), false);
            }
            case 2 -> {
                // Plain text around encoded words: the spaces beside plain text stay.
                String a = words(c, lang, UTF8.charset(), c.between(2, 4), true);
                String plain = words(c, Langs.EN, StandardCharsets.US_ASCII, c.between(1, 3), false);
                String b = words(c, lang, UTF8.charset(), c.between(2, 4), false);
                subjectText = "Re: " + a + " " + plain + " " + b;
                subjectHeader = "Re: " + Mime.encodedWords(a, StandardCharsets.UTF_8, "utf-8", c.chance(0.5)) + " " + plain + " "
                        + Mime.encodedWords(b, StandardCharsets.UTF_8, "UTF-8", c.chance(0.5));
            }
            case 3 -> {
                // RFC 6532: raw UTF-8, folded at a space.
                subjectText = words(c, lang, UTF8.charset(), c.between(3, 12), true);
                subjectHeader = foldAtSpaces(c, subjectText);
            }
            case 4 -> {
                // Plain ASCII, long, folded several times.
                subjectText = words(c, Langs.EN, StandardCharsets.US_ASCII, c.between(14, 30), true);
                subjectHeader = foldAtSpaces(c, subjectText);
            }
            case 5 -> {
                // Lower-case B and Q markers.
                subjectText = words(c, lang, UTF8.charset(), c.between(3, 8), true);
                subjectHeader = Mime.encodedWords(subjectText, StandardCharsets.UTF_8, "utf-8", c.chance(0.5))
                        .replace("?B?", "?b?").replace("?Q?", "?q?");
            }
            default -> {
                // RFC 2231's language tag inside an encoded word.
                subjectText = words(c, lang, UTF8.charset(), c.between(2, 6), true);
                subjectHeader = Mime.encodedWords(subjectText, StandardCharsets.UTF_8, "utf-8*" + c.pick(List.of("en", "fr", "de", "ja")),
                        c.chance(0.5));
            }
        }
        Sender from = trickySender(c, lang);
        Entity root = envelope(c, from, subjectHeader);
        if (c.chance(0.5)) {
            root.header("Reply-To", "\"" + c.pick(Langs.EN.names()) + "\" <" + c.pick(LOCALS) + "@" + c.pick(DOMAINS) + ">");
        }
        if (c.chance(0.4)) {
            root.header("Cc", "team: " + c.pick(LOCALS) + "@" + c.pick(DOMAINS) + ",\r\n\t" + c.pick(LOCALS) + "@" + c.pick(DOMAINS) + ";,"
                    + " \"Desk, Office\" <office@desk.example>");
        }
        Text t = text(c, lang, UTF8.charset(), c.between(1, 2));
        int attachments = 0;
        if (c.chance(0.35)) {
            root.multipart("mixed", c.boundary(), null);
            root.add(textPart(c, new Entity(), "plain", t.plain(), UTF8));
            String name = words(c, lang, UTF8.charset(), c.between(4, 10), false).replace(' ', '-') + ".pdf";
            Entity att = new Entity();
            att.header("Content-Type", "application/pdf; name=\"" + Mime.encodedWords(name, StandardCharsets.UTF_8, "utf-8", true)
                    .replace("\r\n ", " ") + "\"");
            att.header("Content-Disposition", "attachment" + Mime.rfc2231("filename", name, StandardCharsets.UTF_8, "utf-8", c.between(20, 60)));
            att.header("Content-Transfer-Encoding", "base64");
            att.body(Mime.base64(Blobs.stub(c.rnd, Blobs.ascii("%PDF-1.7\n"), c.between(300, 3000)), 76));
            root.add(att);
            attachments = 1;
        } else {
            textPart(c, root, "plain", t.plain(), UTF8);
        }
        return new Built(root.bytes(), Expect.read(subjectText, from.address(), attachments, t.word()));
    }

    /** Senders a parser has to read with care. */
    private static Sender trickySender(Ctx c, Lang lang) {
        String local = c.pick(LOCALS);
        String domain = c.pick(DOMAINS);
        String address = local + "@" + domain;
        String name = c.pick(Langs.EN.names());
        String header = switch (c.between(0, 8)) {
            case 0 -> "\"" + name.replace(" ", ", ") + "\" <" + address + ">";
            case 1 -> "\"The \\\"" + name + "\\\" desk\" <" + address + ">";
            case 2 -> address + " (" + name + ")";
            case 3 -> "<" + address + ">";
            case 4 -> name + " <" + address.toUpperCase(Locale.ROOT) + ">";
            case 5 -> "\"billing@bank.example\" <" + address + ">";
            case 6 -> Mime.encodedWords(c.pick(lang.names()) + ", " + name, StandardCharsets.UTF_8, "utf-8", c.chance(0.5)) + " <" + address + ">";
            case 7 -> "\"" + name.replace(" ", "\r\n ") + "\" <" + address + ">";
            default -> "  " + name + "   <" + address + ">  ";
        };
        return new Sender(header, Mime.lower(address));
    }

    /** The shapes mail comes in: alternative, mixed, related, nested deep, digest, signed, a bounce, forwards, invites. */
    private static Built structure(Ctx c) {
        Lang lang = c.pick(Langs.ALL);
        Text t = text(c, lang, UTF8.charset(), c.between(1, 3));
        Subject s = subject(c, lang, UTF8);
        Sender from = sender(c, lang, UTF8);
        Entity root;
        Integer attachments = 0;
        Subject subject = s;
        switch (c.between(0, 11)) {
            case 0 -> {
                root = envelope(c, from, s.header());
                root.multipart("alternative", c.boundary(), null).add(plain(c, t)).add(html(c, t));
            }
            case 1 -> {
                root = envelope(c, from, s.header());
                root.multipart("mixed", c.boundary(), null);
                root.add(c.chance(0.5) ? alternative(c, t) : plain(c, t));
                int k = c.between(1, 3);
                for (int i = 0; i < k; i++) {
                    root.add(smallAttachment(c, i));
                }
                attachments = k;
            }
            case 2 -> {
                root = envelope(c, from, s.header());
                Entity related = related(c, t);
                if (c.chance(0.5)) {
                    root.multipart("alternative", c.boundary(), null).add(plain(c, t)).add(related);
                } else {
                    root.multipart("mixed", c.boundary(), null).add(related).add(smallAttachment(c, 0));
                    attachments = 1;
                }
            }
            case 3 -> {
                root = envelope(c, from, s.header());
                attachments = nested(c, root, t, c.between(1, 19));
            }
            case 4 -> {
                root = envelope(c, from, s.header());
                Entity digest = new Entity().multipart("digest", c.boundary(), null);
                int k = c.between(2, 5);
                for (int i = 0; i < k; i++) {
                    // A digest's parts are message/rfc822 by default, with no header of their own.
                    digest.add(new Entity().body(innerMessage(c, c.pick(Langs.ALL))));
                }
                root.multipart("mixed", c.boundary(), null).add(plain(c, t)).add(digest);
                attachments = null;
            }
            case 5 -> {
                root = envelope(c, from, s.header());
                root.multipart("signed", c.boundary(), "; micalg=pgp-sha256; protocol=\"application/pgp-signature\"");
                Entity signedBody = new Entity();
                textPart(c, signedBody, "plain", t.plain(), UTF8, Cte.QP);
                Entity sig = new Entity();
                sig.header("Content-Type", "application/pgp-signature; name=\"signature.asc\"");
                sig.header("Content-Description", "OpenPGP digital signature");
                sig.header("Content-Disposition", "attachment; filename=\"signature.asc\"");
                sig.body("-----BEGIN PGP SIGNATURE-----\r\n\r\n" + new String(Mime.base64(Blobs.stub(c.rnd, new byte[] {(byte) 0x88}, 119), 64),
                        StandardCharsets.US_ASCII) + "\r\n=" + c.hex(4) + "\r\n-----END PGP SIGNATURE-----");
                root.add(signedBody).add(sig);
                attachments = 1;
            }
            case 6 -> {
                root = envelope(c, from, s.header());
                root.multipart("signed", c.boundary(), "; protocol=\"application/pkcs7-signature\"; micalg=sha-256");
                Entity sig = new Entity();
                sig.header("Content-Type", "application/pkcs7-signature; name=\"smime.p7s\"");
                sig.header("Content-Transfer-Encoding", "base64");
                sig.header("Content-Disposition", "attachment; filename=\"smime.p7s\"");
                sig.body(Mime.base64(Blobs.stub(c.rnd, new byte[] {0x30, (byte) 0x82, 0x0b, 0x2c, 0x06, 0x09, 0x2a, (byte) 0x86, 0x48},
                        c.between(1500, 4000)), 76));
                root.add(c.chance(0.5) ? alternative(c, t) : plain(c, t)).add(sig);
                attachments = 1;
            }
            case 7 -> {
                // A delivery status notification: how many attachments a reader shows there is a choice.
                String daemon = "mailer-daemon@mx." + c.pick(DOMAINS);
                from = new Sender("Mail Delivery System <" + daemon + ">", daemon);
                subject = new Subject("Undelivered Mail Returned to Sender", "Undelivered Mail Returned to Sender");
                Text human = text(c, Langs.EN, StandardCharsets.US_ASCII, 1);
                t = human;
                root = envelope(c, from, subject.header());
                root.header("Auto-Submitted", "auto-replied");
                root.multipart("report", c.boundary(), "; report-type=delivery-status");
                Entity first = new Entity();
                first.header("Content-Type", "text/plain; charset=us-ascii");
                first.header("Content-Description", "Notification");
                first.body("This is the mail system at host mx.example.net.\r\n\r\n" + human.plain()
                        + "\r\n\r\n<nobody@example.net>: host mx.example.net[192.0.2.25] said: 550 5.1.1 user unknown");
                Entity status = new Entity();
                status.header("Content-Type", "message/delivery-status");
                status.header("Content-Description", "Delivery report");
                status.body("Reporting-MTA: dns; mx.example.net\r\nArrival-Date: " + date(c) + "\r\n\r\nFinal-Recipient: rfc822; nobody@example.net\r\n"
                        + "Original-Recipient: rfc822;nobody@example.net\r\nAction: failed\r\nStatus: 5.1.1\r\n"
                        + "Remote-MTA: dns; mx.example.net\r\nDiagnostic-Code: smtp; 550 5.1.1 <nobody@example.net>: Recipient address rejected: User unknown");
                Entity original = new Entity();
                if (c.chance(0.5)) {
                    original.header("Content-Type", "message/rfc822");
                    original.header("Content-Description", "Undelivered Message");
                    original.body(innerMessage(c, lang));
                } else {
                    original.header("Content-Type", "text/rfc822-headers");
                    byte[] inner = innerMessage(c, lang);
                    String all = new String(inner, StandardCharsets.UTF_8);
                    original.body(all.substring(0, all.indexOf("\r\n\r\n")));
                }
                root.add(first).add(status).add(original);
                attachments = null;
            }
            case 8 -> {
                Lang innerLang = c.pick(Langs.ALL);
                Subject inner = subject(c, innerLang, UTF8);
                subject = new Subject("Fwd: " + inner.text(), "Fwd: " + inner.header());
                root = envelope(c, from, subject.header());
                Entity fwd = new Entity();
                fwd.header("Content-Type", "message/rfc822");
                fwd.header("Content-Disposition", "attachment; filename=\"forwarded message.eml\"");
                fwd.body(innerMessage(c, innerLang, inner.header()));
                root.multipart("mixed", c.boundary(), null).add(plain(c, t)).add(fwd);
                attachments = 1;
            }
            case 9 -> {
                // Gmail's forward: the old message is quoted in the text.
                Subject inner = subject(c, lang, UTF8);
                subject = new Subject("Fwd: " + inner.text(), "Fwd: " + inner.header());
                root = envelope(c, from, subject.header());
                String quoted = "---------- Forwarded message ---------\r\nFrom: " + c.pick(Langs.EN.names()) + " <" + c.pick(LOCALS) + "@"
                        + c.pick(DOMAINS) + ">\r\nDate: " + date(c) + "\r\nSubject: " + inner.text() + "\r\nTo: <me@desk.example>\r\n\r\n";
                Text fw = new Text(quoted + t.plain(), "<div dir=\"ltr\">---------- Forwarded message ---------<br>" + t.html() + "</div>", t.word());
                root.multipart("alternative", "000000000000" + c.hex(12), null).add(plain(c, fw)).add(html(c, fw));
            }
            case 10 -> {
                root = envelope(c, from, s.header());
                Entity ics = new Entity();
                ics.header("Content-Type", "text/calendar; charset=utf-8; method=REQUEST; name=\"invite.ics\"");
                ics.header("Content-Disposition", "attachment; filename=\"invite.ics\"");
                ics.header("Content-Transfer-Encoding", "base64");
                ics.body(Mime.base64(ics(c, s.text(), from.address()).getBytes(StandardCharsets.UTF_8), 76));
                root.multipart("mixed", c.boundary(), null).add(alternative(c, t)).add(ics);
                attachments = 1;
            }
            default -> {
                // Google Calendar's shape: the invite inside the alternative too, and as a file.
                root = envelope(c, from, s.header());
                String event = ics(c, s.text(), from.address());
                Entity cal = new Entity();
                cal.header("Content-Type", "text/calendar; charset=\"UTF-8\"; method=REQUEST");
                cal.header("Content-Transfer-Encoding", "quoted-printable");
                cal.body(Mime.quotedPrintable(event.getBytes(StandardCharsets.UTF_8), true));
                Entity alt = new Entity().multipart("alternative", c.boundary(), null).add(plain(c, t)).add(html(c, t)).add(cal);
                Entity file = new Entity();
                file.header("Content-Type", "application/ics; name=\"invite.ics\"");
                file.header("Content-Disposition", "attachment; filename=\"invite.ics\"");
                file.header("Content-Transfer-Encoding", "base64");
                file.body(Mime.base64(event.getBytes(StandardCharsets.UTF_8), 76));
                root.multipart("mixed", c.boundary(), null).add(alt).add(file);
                attachments = null;
            }
        }
        return new Built(root.bytes(), Expect.read(subject.text(), from.address(), attachments, t.word()));
    }

    /** Multiparts {@code depth} deep (the message's own the first) with the body at the bottom; returns attachments. */
    private static int nested(Ctx c, Entity root, Text t, int depth) {
        List<Entity> levels = new ArrayList<>();
        levels.add(root);
        for (int i = 1; i < depth; i++) {
            levels.add(new Entity());
        }
        int attachments = 0;
        for (int i = 0; i < depth; i++) {
            Entity level = levels.get(i);
            level.multipart(c.chance(0.8) ? "mixed" : "related", "lvl" + i + "_" + c.hex(8), null);
            level.add(i + 1 < depth ? levels.get(i + 1) : plain(c, t));
            if (c.chance(0.15)) {
                level.add(smallAttachment(c, i));
                attachments++;
            }
        }
        return attachments;
    }

    private static String ics(Ctx c, String summary, String organizer) {
        String day = "202612" + (10 + c.between(0, 18));
        return "BEGIN:VCALENDAR\r\nPRODID:-//Example//Courier corpus//EN\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\n"
                + "DTSTART:" + day + "T150000Z\r\nDTEND:" + day + "T160000Z\r\nDTSTAMP:20261101T120000Z\r\n"
                + "ORGANIZER;CN=Organizer:mailto:" + organizer + "\r\nUID:" + c.hex(16) + "@example.com\r\n"
                + "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@desk.example\r\n"
                + "SUMMARY:" + summary.replace(",", "\\,").replace(";", "\\;") + "\r\nSTATUS:CONFIRMED\r\nSEQUENCE:0\r\nEND:VEVENT\r\nEND:VCALENDAR";
    }

    /** One to four attachments of every kind, name and size up to about 200 KB, after a body. */
    private static Built attachment(Ctx c) {
        Lang lang = c.pick(Langs.ALL);
        Text t = text(c, lang, UTF8.charset(), c.between(1, 2));
        Subject s = subject(c, lang, UTF8);
        Sender from = sender(c, lang, UTF8);
        Entity root = envelope(c, from, s.header());
        root.multipart("mixed", c.boundary(), null).add(c.chance(0.6) ? plain(c, t) : alternative(c, t));
        int k = c.between(1, 4);
        for (int i = 0; i < k; i++) {
            root.add(fileAttachment(c, lang, i));
        }
        return new Built(root.bytes(), Expect.read(s.text(), from.address(), k, t.word()));
    }

    /** A kind of file: its type, an extension, and how its bytes start. */
    private record Kind(String type, String ext, byte[] magic) {
    }

    private static final List<Kind> KINDS = List.of(
            new Kind("application/pdf", "pdf", "%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n".getBytes(StandardCharsets.ISO_8859_1)),
            new Kind("image/png", "png", null),
            new Kind("image/jpeg", "jpg", new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 0, 0x10, 'J', 'F', 'I', 'F', 0}),
            new Kind("image/gif", "gif", Blobs.ascii("GIF89a")),
            new Kind("application/zip", "zip", null),
            new Kind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx", null),
            new Kind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx", null),
            new Kind("text/plain", "txt", null),
            new Kind("text/csv", "csv", null),
            new Kind("application/octet-stream", "bin", new byte[] {0}),
            new Kind("application/x-msdownload", "exe", new byte[] {'M', 'Z', (byte) 0x90, 0, 3, 0}),
            new Kind("application/msword", "doc", new byte[] {(byte) 0xd0, (byte) 0xcf, 0x11, (byte) 0xe0, (byte) 0xa1, (byte) 0xb1, 0x1a, (byte) 0xe1}),
            new Kind("audio/mpeg", "mp3", Blobs.ascii("ID3\u0004\u0000")),
            new Kind("video/mp4", "mp4", new byte[] {0, 0, 0, 0x18, 'f', 't', 'y', 'p', 'm', 'p', '4', '2'}),
            new Kind("application/json", "json", null),
            new Kind("text/html", "html", null),
            new Kind("application/javascript", "js", null),
            new Kind("application/java-archive", "jar", null));

    private static final List<String> BASE_NAMES = List.of("report", "invoice", "scan", "photo", "minutes", "budget-2026", "contract",
            "Q3 results", "IMG_2041", "notes (final)", "draft_v2", "receipt", "timetable", "presentation");

    private static Entity fileAttachment(Ctx c, Lang lang, int index) {
        Kind kind = c.pick(KINDS);
        int size = c.chance(0.6) ? c.between(200, 4000) : c.chance(0.875) ? c.between(4000, 32_000) : c.between(32_000, 200_000);
        byte[] data = fileBytes(c, kind, size, lang);
        String base = c.chance(0.7) ? c.pick(BASE_NAMES) : words(c, lang, StandardCharsets.UTF_8, c.between(1, 3), false).replace(' ', '_');
        String name = switch (c.between(0, 9)) {
            case 0 -> base + ".pdf." + kind.ext();
            case 1 -> base + "\u202e" + new StringBuilder(kind.ext()).reverse() + ".exe";
            case 2 -> base + " " + "(" + (index + 1) + ")." + kind.ext().toUpperCase(Locale.ROOT);
            default -> base + "." + kind.ext();
        };
        boolean ascii = StandardCharsets.US_ASCII.newEncoder().canEncode(name);
        Entity e = new Entity();
        String typeName;
        String disposition;
        if (ascii) {
            typeName = "; name=\"" + name + "\"";
            disposition = "attachment; filename=\"" + name + "\"";
        } else if (c.chance(0.5)) {
            // Outlook and Gmail: an encoded word inside quotes.
            String words = Mime.encodedWords(name, StandardCharsets.UTF_8, "UTF-8", true).replace("\r\n ", " ");
            typeName = "; name=\"" + words + "\"";
            disposition = "attachment; filename=\"" + words + "\"";
        } else {
            // RFC 2231, continued past 40 characters.
            typeName = Mime.rfc2231("name", name, StandardCharsets.UTF_8, "utf-8", 40);
            disposition = "attachment" + Mime.rfc2231("filename", name, StandardCharsets.UTF_8, "utf-8", 40);
        }
        e.header("Content-Type", kind.type() + typeName);
        e.header("Content-Disposition", disposition + (c.chance(0.3) ? "; size=" + data.length : ""));
        boolean text = kind.type().startsWith("text/") || kind.ext().equals("json") || kind.ext().equals("js");
        if (text && c.chance(0.4)) {
            e.header("Content-Transfer-Encoding", "quoted-printable").body(Mime.quotedPrintable(data, true));
        } else {
            e.header("Content-Transfer-Encoding", "base64").body(Mime.base64(data, 76));
        }
        return e;
    }

    private static byte[] fileBytes(Ctx c, Kind kind, int size, Lang lang) {
        return switch (kind.ext()) {
            case "png" -> {
                int side = Math.max(1, (int) Math.sqrt(size / 3.0));
                yield Blobs.png(c.rnd, side, Math.max(1, size / 3 / side));
            }
            case "gif" -> size < 400 ? Blobs.PIXEL_GIF : Blobs.stub(c.rnd, kind.magic(), size);
            case "zip", "jar", "docx", "xlsx" -> zipOf(c, kind.ext(), size, lang);
            case "txt" -> textOfSize(c, lang, size);
            case "csv" -> Blobs.csv(c.rnd, size);
            case "json" -> ("{\"items\":[" + "{\"id\":1,\"ok\":true},".repeat(Math.max(1, size / 20)) + "{\"id\":0}]}")
                    .getBytes(StandardCharsets.US_ASCII);
            case "html" -> ("<!DOCTYPE html><html><body><form action=\"https://login.example/\"><input name=\"user\"><input type=\"password\" name=\"p\">"
                    + "</form><p>" + Mime.escapeHtml(new String(textOfSize(c, lang, size), StandardCharsets.UTF_8)) + "</p></body></html>")
                    .getBytes(StandardCharsets.UTF_8);
            case "js" -> ("var a = 1;\r\n" + "a = a + 1;\r\n".repeat(Math.max(1, size / 12))).getBytes(StandardCharsets.US_ASCII);
            default -> Blobs.stub(c.rnd, kind.magic(), size);
        };
    }

    /** Paragraphs of {@code lang} up to about {@code size} bytes of UTF-8. */
    private static byte[] textOfSize(Ctx c, Lang lang, int size) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(size + 1024);
        while (out.size() < size) {
            out.writeBytes((text(c, lang, StandardCharsets.UTF_8, 1).plain() + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        }
        return out.toByteArray();
    }

    private static byte[] zipOf(Ctx c, String ext, int size, Lang lang) {
        List<Blobs.Entry> entries = new ArrayList<>();
        switch (ext) {
            case "docx" -> {
                entries.add(new Blobs.Entry("[Content_Types].xml", Blobs.ascii("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns="
                        + "\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/word/document.xml\" ContentType="
                        + "\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>")));
                entries.add(new Blobs.Entry("word/document.xml", ("<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:document xmlns:w="
                        + "\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>"
                        + Mime.escapeHtml(new String(textOfSize(c, lang, size), StandardCharsets.UTF_8)) + "</w:t></w:r></w:p></w:body></w:document>")
                        .getBytes(StandardCharsets.UTF_8)));
            }
            case "xlsx" -> {
                entries.add(new Blobs.Entry("[Content_Types].xml", Blobs.ascii("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types/>")));
                entries.add(new Blobs.Entry("xl/workbook.xml", Blobs.ascii("<?xml version=\"1.0\" encoding=\"UTF-8\"?><workbook/>")));
                entries.add(new Blobs.Entry("xl/worksheets/sheet1.xml", Blobs.csv(c.rnd, size)));
            }
            case "jar" -> {
                entries.add(new Blobs.Entry("META-INF/MANIFEST.MF", Blobs.ascii("Manifest-Version: 1.0\r\nMain-Class: example.Main\r\n\r\n")));
                entries.add(new Blobs.Entry("example/Main.class",
                        Blobs.stub(c.rnd, new byte[] {(byte) 0xca, (byte) 0xfe, (byte) 0xba, (byte) 0xbe, 0, 0, 0, 65}, size)));
            }
            default -> {
                int k = c.between(1, 4);
                for (int i = 0; i < k; i++) {
                    boolean program = c.chance(0.2);
                    entries.add(new Blobs.Entry(program ? "setup" + i + ".exe" : "file" + i + ".txt",
                            program ? Blobs.stub(c.rnd, new byte[] {'M', 'Z'}, size / k) : textOfSize(c, lang, size / k)));
                }
            }
        }
        return Blobs.zip(entries);
    }

    private static Entity smallAttachment(Ctx c, int index) {
        Entity e = new Entity();
        String name = c.pick(List.of("scan", "photo", "agenda", "list")) + "-" + (index + 1) + "." + c.pick(List.of("pdf", "png", "txt"));
        String type = name.endsWith("pdf") ? "application/pdf" : name.endsWith("png") ? "image/png" : "text/plain";
        e.header("Content-Type", type + "; name=\"" + name + "\"");
        e.header("Content-Disposition", "attachment; filename=\"" + name + "\"");
        e.header("Content-Transfer-Encoding", "base64");
        byte[] data = type.equals("image/png") ? Blobs.png(c.rnd, c.between(1, 16), c.between(1, 16))
                : Blobs.stub(c.rnd, type.equals("application/pdf") ? Blobs.ascii("%PDF-1.4\n") : Blobs.ascii("list\r\n"), c.between(100, 1500));
        return e.body(Mime.base64(data, 76));
    }

    /** Hostile HTML: a few of the {@link HostileHtml} vectors after the words, which come first so no vector hides them. */
    private static Built html(Ctx c) {
        Lang lang = c.pick(Langs.ALL);
        Text t = text(c, lang, UTF8.charset(), c.between(1, 2));
        Subject s = subject(c, lang, UTF8);
        Sender from = sender(c, lang, UTF8);
        Entity root = envelope(c, from, s.header());
        List<HostileHtml.Vector> all = Vectors.ALL;
        StringBuilder inner = new StringBuilder(t.html());
        int k = c.between(1, 5);
        for (int i = 0; i < k; i++) {
            inner.append("\r\n").append(c.pick(all).html().replace("\n", "\r\n"));
        }
        String doc = htmlDoc("utf-8", inner.toString());
        Entity htmlPart = new Entity();
        htmlPart.header("Content-Type", "text/html; charset=utf-8");
        encodeWith(htmlPart, c.chance(0.5) ? Cte.QP : Cte.BASE64, doc.getBytes(StandardCharsets.UTF_8));
        if (c.chance(0.5)) {
            root.multipart("alternative", c.boundary(), null).add(plain(c, t)).add(htmlPart);
        } else {
            root.headers.addAll(htmlPart.headers);
            root.body(htmlPart.body);
        }
        return new Built(root.bytes(), Expect.read(s.text(), from.address(), 0, t.word()));
    }

    /** Newsletters: tracking pixels, tracking parameters, links that lie about where they go, list headers. */
    private static Built links(Ctx c) {
        Lang lang = c.pick(Langs.ALL);
        Text t = text(c, lang, UTF8.charset(), c.between(1, 3));
        Subject s = subject(c, lang, UTF8);
        String shop = c.pick(List.of("shop.example", "news.example", "example.com", "store.example.net", "mail.example.org"));
        Sender from = new Sender(Mime.encodedWords(c.pick(lang.names()), StandardCharsets.UTF_8, "utf-8", true) + " <news@" + shop + ">",
                "news@" + shop);
        Entity root = envelope(c, from, s.header());
        root.header("List-Id", "\"" + shop + " news\" <news." + shop + ">");
        root.header("List-Unsubscribe", "<https://" + shop + "/unsubscribe?u=" + c.hex(16) + ">, <mailto:unsubscribe@" + shop + "?subject=unsubscribe>");
        root.header("List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
        if (c.chance(0.5)) {
            root.header("Precedence", c.pick(List.of("bulk", "list")));
        }
        StringBuilder h = new StringBuilder();
        h.append("<table width=\"600\" align=\"center\" cellpadding=\"0\" cellspacing=\"0\"><tr><td>\r\n");
        h.append("<img src=\"https://cdn.").append(shop).append("/img/banner.jpg\" width=\"600\" alt=\"Banner\">\r\n");
        h.append(t.html()).append("\r\n<p>\r\n");
        int k = c.between(3, 7);
        for (int i = 0; i < k; i++) {
            h.append(c.pick(LINK_SHAPES).replace("{shop}", shop).replace("{id}", c.hex(10)).replace("{puny}", PUNY)).append("<br>\r\n");
        }
        h.append("</p>\r\n");
        int pixels = c.between(1, 3);
        for (int i = 0; i < pixels; i++) {
            h.append(c.pick(PIXELS).replace("{shop}", shop).replace("{id}", c.hex(16))).append("\r\n");
        }
        h.append("<p style=\"font-size:11px\"><a href=\"https://").append(shop).append("/unsubscribe?u=").append(c.hex(16))
                .append("\">Unsubscribe</a></p>\r\n</td></tr></table>");
        Entity htmlPart = textPart(c, new Entity(), "html", htmlDoc("utf-8", h.toString()), UTF8, c.chance(0.5) ? Cte.QP : Cte.BASE64);
        if (c.chance(0.5)) {
            root.multipart("alternative", c.boundary(), null).add(plain(c, t)).add(htmlPart);
        } else {
            root.headers.addAll(htmlPart.headers);
            root.body(htmlPart.body);
        }
        return new Built(root.bytes(), Expect.read(s.text(), from.address(), 0, t.word()));
    }

    /** The mixed-script host, written in punycode: a Cyrillic a in place of the Latin one. */
    private static final String PUNY = IDN.toASCII("p\u0430ypal.example");

    private static final List<String> LINK_SHAPES = List.of(
            "<a href=\"https://{shop}/sale?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=autumn_2026&amp;utm_content=hero\">Autumn sale</a>",
            "<a href=\"https://www.example.com/article?id=42&amp;fbclid=IwAR{id}\">Read the story</a>",
            "<a href=\"https://{shop}/?gclid=Cj0KCQiA{id}&amp;utm_term=boots\">Shop now</a>",
            "<a href=\"https://{shop}/p/{id}?mc_cid={id}&amp;mc_eid={id}\">See the product</a>",
            "<a href=\"https://click.{shop}/ls/click?upn={id}&amp;redirect=https%3A%2F%2F{shop}%2F\">Your account</a>",
            "<a href=\"http://paypal.com.account-verify.example/login?session={id}\">https://www.paypal.com/</a>",
            "<a href=\"http://198.51.100.23/login.php\">Sign in to your account</a>",
            "<a href=\"http://203.0.113.9:8080/invoice/{id}\">View invoice</a>",
            "<a href=\"http://3325256727/verify\">Verify your address</a>",
            "<a href=\"http://{puny}/signin\">p\u0430ypal.example</a>",
            "<a href=\"http://p\u0430ypal.example/signin\">Confirm your details</a>",
            "<a href=\"javascript:alert(document.domain)\">View this email online</a>",
            "<a href=\"data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==\">Open the attachment</a>",
            "<a href=\"mailto:help@{shop}?subject=Question\">Write to us</a>",
            "<a href=\"//{shop}/protocol-relative\">Our blog</a>",
            "<a href=\"https://{shop}/track?url=https%3A%2F%2Fevil.example%2F&amp;utm_source=mail\">Track your parcel</a>");

    private static final List<String> PIXELS = List.of(
            "<img src=\"https://t.{shop}/open/{id}.gif\" width=\"1\" height=\"1\" alt=\"\">",
            "<img src=\"https://email.{shop}/wf/open?upn={id}\" width=\"0\" height=\"0\" style=\"border:0\" alt=\"\">",
            "<img src=\"https://pixel.example.net/p.gif?e={id}\" style=\"display:none\">",
            "<img src=\"https://{shop}/e/o/{id}\" alt=\"\" style=\"width:1px;height:1px;visibility:hidden\">",
            "<img src=\"https://track.example.org/beacon/{id}/open.png\" height=\"1\" width=\"1\" border=\"0\">",
            "<img src=\"https://{shop}/track/open.php?u={id}&amp;id={id}\" height=\"1\" width=\"1\">",
            "<div style=\"background-image:url('https://t.{shop}/o/{id}.png')\"></div>");

    private enum Mutation {
        TRUNCATE, BOUNDARY, FLIP, CR, DUPLICATE_HEADER, NO_BLANK_LINE, NULS
    }

    /** A clean sample of another family, then broken: what a parser does with it is its choice, as long as it's clean. */
    private static Built mutation(Ctx c) {
        Family base = c.pick(List.of(Family.CHARSET, Family.ENCODING, Family.HEADER, Family.STRUCTURE, Family.ATTACHMENT, Family.HTML, Family.LINKS));
        byte[] raw = build(base, c).raw();
        int ops = c.between(1, 2);
        for (int i = 0; i < ops; i++) {
            raw = switch (c.pick(Arrays.asList(Mutation.values()))) {
                case TRUNCATE -> Arrays.copyOf(raw, c.between(raw.length / 5, Math.max(raw.length / 5, raw.length * 19 / 20)));
                case BOUNDARY -> corruptBoundary(c, raw);
                case FLIP -> {
                    byte[] out = raw.clone();
                    int k = c.between(1, 16);
                    for (int j = 0; j < k && out.length > 0; j++) {
                        out[c.rnd.nextInt(out.length)] = (byte) c.rnd.nextInt(256);
                    }
                    yield out;
                }
                case CR -> c.chance(0.5) ? withoutCr(raw) : everyOtherCr(raw);
                case DUPLICATE_HEADER -> insertAfterFirstLine(raw, c.pick(List.of(
                        "Subject: =?utf-8?B?" + java.util.Base64.getEncoder().encodeToString("second subject".getBytes(StandardCharsets.UTF_8)) + "?=",
                        "From: Other <other@example.net>", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64",
                        "MIME-Version: 1.0", "Content-Type: multipart/mixed; boundary=\"other\"", "Date: yesterday")));
                case NO_BLANK_LINE -> {
                    String s = new String(raw, StandardCharsets.ISO_8859_1);
                    int at = s.indexOf("\r\n\r\n");
                    yield at < 0 ? raw : (s.substring(0, at) + "\r\n" + s.substring(at + 4)).getBytes(StandardCharsets.ISO_8859_1);
                }
                case NULS -> {
                    ByteArrayOutputStream out = new ByteArrayOutputStream(raw.length + 8);
                    int k = c.between(1, 8);
                    int[] at = new int[k];
                    for (int j = 0; j < k; j++) {
                        at[j] = raw.length == 0 ? 0 : c.rnd.nextInt(raw.length);
                    }
                    Arrays.sort(at);
                    int next = 0;
                    for (int j = 0; j < raw.length; j++) {
                        while (next < k && at[next] == j) {
                            out.write(0);
                            next++;
                        }
                        out.write(raw[j]);
                    }
                    yield out.toByteArray();
                }
            };
        }
        return new Built(raw, Expect.either());
    }

    private static byte[] corruptBoundary(Ctx c, byte[] raw) {
        String s = new String(raw, StandardCharsets.ISO_8859_1);
        List<Integer> starts = new ArrayList<>();
        for (int i = s.indexOf("\n--"); i >= 0; i = s.indexOf("\n--", i + 1)) {
            starts.add(i + 3);
        }
        if (starts.isEmpty()) {
            return truncateHeaders(raw);
        }
        byte[] out = raw.clone();
        int at = c.pick(starts) + c.between(0, 6);
        if (at < out.length) {
            out[at] = (byte) (out[at] == 'x' ? 'y' : 'x');
        }
        return out;
    }

    private static byte[] truncateHeaders(byte[] raw) {
        String s = new String(raw, StandardCharsets.ISO_8859_1);
        int at = s.indexOf("\r\n\r\n");
        return at < 0 ? raw : Arrays.copyOf(raw, at / 2);
    }

    private static byte[] insertAfterFirstLine(byte[] raw, String header) {
        String s = new String(raw, StandardCharsets.ISO_8859_1);
        int nl = s.indexOf('\n');
        if (nl < 0) {
            return raw;
        }
        return (s.substring(0, nl + 1) + new String(header.getBytes(StandardCharsets.UTF_8), StandardCharsets.ISO_8859_1) + "\r\n" + s.substring(nl + 1))
                .getBytes(StandardCharsets.ISO_8859_1);
    }

    static byte[] withoutCr(byte[] raw) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(raw.length);
        for (byte b : raw) {
            if (b != '\r') {
                out.write(b);
            }
        }
        return out.toByteArray();
    }

    private static byte[] everyOtherCr(byte[] raw) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(raw.length);
        boolean drop = false;
        for (byte b : raw) {
            if (b == '\r') {
                drop = !drop;
                if (drop) {
                    continue;
                }
            }
            out.write(b);
        }
        return out.toByteArray();
    }

    // ---- Parts ----

    private static Entity plain(Ctx c, Text t) {
        return textPart(c, new Entity(), "plain", t.plain(), UTF8);
    }

    private static Entity html(Ctx c, Text t) {
        return textPart(c, new Entity(), "html", htmlDoc("utf-8", t.html()), UTF8);
    }

    private static Entity alternative(Ctx c, Text t) {
        return new Entity().multipart("alternative", c.boundary(), null).add(plain(c, t)).add(html(c, t));
    }

    /** multipart/related: the HTML with its pictures by cid, each marked inline. */
    private static Entity related(Ctx c, Text t) {
        Entity related = new Entity().multipart("related", c.boundary(), "; type=\"text/html\"");
        int k = c.between(1, 3);
        StringBuilder imgs = new StringBuilder();
        List<Entity> images = new ArrayList<>();
        for (int i = 0; i < k; i++) {
            String cid = "image" + (i + 1) + "." + c.hex(8) + "@example.com";
            boolean gif = c.chance(0.3);
            String name = "image" + (i + 1) + (gif ? ".gif" : ".png");
            imgs.append("<img src=\"cid:").append(cid).append("\" alt=\"").append(name).append("\" width=\"64\"><br>\r\n");
            Entity img = new Entity();
            img.header("Content-Type", (gif ? "image/gif" : "image/png") + "; name=\"" + name + "\"");
            img.header("Content-Disposition", "inline; filename=\"" + name + "\"");
            img.header("Content-ID", "<" + cid + ">");
            img.header("Content-Transfer-Encoding", "base64");
            img.body(Mime.base64(gif ? Blobs.PIXEL_GIF : Blobs.png(c.rnd, c.between(1, 24), c.between(1, 24)), 76));
            images.add(img);
        }
        related.add(textPart(c, new Entity(), "html", htmlDoc("utf-8", t.html() + "\r\n" + imgs), UTF8));
        images.forEach(related::add);
        return related;
    }

    private static Entity textPart(Ctx c, Entity e, String subtype, String text, Cs cs) {
        return textPart(c, e, subtype, text, cs, null);
    }

    /** A text part in {@code cs}, with a transfer encoding the charset allows (or the one given). */
    private static Entity textPart(Ctx c, Entity e, String subtype, String text, Cs cs, Cte forced) {
        byte[] bytes = encode(text, cs);
        String label = c.labelCase(cs.label());
        e.header("Content-Type", "text/" + subtype + "; charset=" + (c.chance(0.5) ? "\"" + label + "\"" : label));
        Cte cte = forced != null ? forced : switch (cs.wire()) {
            case EIGHT_BIT -> c.pick(List.of(Cte.EIGHT_BIT, Cte.QP, Cte.BASE64));
            case SEVEN_BIT -> c.pick(List.of(Cte.SEVEN_BIT, Cte.NONE, Cte.QP));
            case ESCAPED -> c.pick(List.of(Cte.SEVEN_BIT, Cte.BASE64));
            case UTF16 -> Cte.BASE64;
        };
        encodeWith(e, cte, bytes);
        return e;
    }

    /** {@code text} in the charset, a byte order mark first for UTF-16, checked to read back the same. */
    private static byte[] encode(String text, Cs cs) {
        byte[] body = text.getBytes(cs.charset());
        if (cs.bom() != null) {
            byte[] bom = cs.bom().equals("LE") ? new byte[] {(byte) 0xff, (byte) 0xfe} : new byte[] {(byte) 0xfe, (byte) 0xff};
            byte[] out = new byte[bom.length + body.length];
            System.arraycopy(bom, 0, out, 0, bom.length);
            System.arraycopy(body, 0, out, bom.length, body.length);
            body = out;
        }
        String back = new String(body, Charset.forName(cs.label()));
        if (!back.equals(text) && !back.equals("\ufeff" + text)) {
            throw new IllegalStateException("text doesn't survive " + cs.label());
        }
        return body;
    }

    static String htmlDoc(String label, String inner) {
        return "<!DOCTYPE html>\r\n<html><head><meta http-equiv=\"Content-Type\" content=\"text/html; charset=" + label + "\"></head>\r\n<body>\r\n"
                + inner + "\r\n</body></html>";
    }

    /** A small whole message, for digests, bounces and forwards. */
    private static byte[] innerMessage(Ctx c, Lang lang) {
        return innerMessage(c, lang, subject(c, lang, UTF8).header());
    }

    private static byte[] innerMessage(Ctx c, Lang lang, String subjectHeader) {
        Entity e = new Entity();
        e.header("From", c.pick(Langs.EN.names()) + " <" + c.pick(LOCALS) + "@" + c.pick(DOMAINS) + ">");
        e.header("To", "me@desk.example");
        e.header("Subject", subjectHeader);
        e.header("Date", date(c));
        e.header("Message-ID", "<" + c.hex(16) + "@example.org>");
        e.header("MIME-Version", "1.0");
        textPart(c, e, "plain", text(c, lang, StandardCharsets.UTF_8, 1).plain(), UTF8);
        return e.bytes();
    }

    // ---- Text, subjects, senders ----

    /** A body's text: plain with CRLF lines, the same as HTML paragraphs, and the word a check looks for. */
    record Text(String plain, String html, String word) {
    }

    static Text text(Ctx c, Lang lang, Charset charset, int paragraphs) {
        List<String> words = lang.wordsIn(charset);
        List<String> checks = lang.checkWordsIn(charset);
        if (words.size() < 8 || checks.isEmpty()) {
            throw new IllegalStateException(lang.code() + " has too few words in " + charset);
        }
        String word = c.pick(checks);
        int wordParagraph = c.rnd.nextInt(paragraphs);
        StringBuilder plain = new StringBuilder();
        StringBuilder html = new StringBuilder();
        for (int p = 0; p < paragraphs; p++) {
            int sentences = c.between(2, 4);
            int wordSentence = c.rnd.nextInt(sentences);
            List<String> lineWords = new ArrayList<>();
            for (int s = 0; s < sentences; s++) {
                int k = c.between(4, 10);
                List<String> sentence = new ArrayList<>();
                for (int i = 0; i < k; i++) {
                    sentence.add(c.pick(words));
                }
                if (lang.cased()) {
                    String first = sentence.get(0);
                    int cp = first.codePointAt(0);
                    sentence.set(0, new String(Character.toChars(Character.toTitleCase(cp))) + first.substring(Character.charCount(cp)));
                }
                if (p == wordParagraph && s == wordSentence) {
                    sentence.add(c.between(1, sentence.size()), word);
                }
                String last = sentence.remove(sentence.size() - 1);
                sentence.add(last + lang.stop());
                lineWords.addAll(sentence);
            }
            List<String> lines = wrap(lineWords, 72);
            if (p > 0) {
                plain.append("\r\n\r\n");
                html.append("\r\n");
            }
            plain.append(String.join("\r\n", lines));
            html.append("<p>").append(Mime.escapeHtml(String.join("\r\n", lines))).append("</p>");
        }
        return new Text(plain.toString(), html.toString(), word);
    }

    /** Words into lines of at most {@code width} code points, breaking only at spaces. */
    private static List<String> wrap(List<String> words, int width) {
        List<String> lines = new ArrayList<>();
        StringBuilder line = new StringBuilder();
        for (String w : words) {
            if (line.length() > 0 && line.codePointCount(0, line.length()) + 1 + w.codePointCount(0, w.length()) > width) {
                lines.add(line.toString());
                line.setLength(0);
            }
            if (line.length() > 0) {
                line.append(' ');
            }
            line.append(w);
        }
        if (line.length() > 0) {
            lines.add(line.toString());
        }
        return lines;
    }

    /** {@code k} words of {@code lang} that {@code charset} can write, single-spaced, the first capitalised if asked. */
    private static String words(Ctx c, Lang lang, Charset charset, int k, boolean capital) {
        List<String> words = lang.wordsIn(charset);
        List<String> out = new ArrayList<>();
        for (int i = 0; i < k; i++) {
            out.add(c.pick(words));
        }
        String s = String.join(" ", out);
        if (capital && lang.cased()) {
            int cp = s.codePointAt(0);
            s = new String(Character.toChars(Character.toTitleCase(cp))) + s.substring(Character.charCount(cp));
        }
        return s;
    }

    /** A subject: its decoded text and the header that carries it. */
    record Subject(String text, String header) {
    }

    /** A subject in {@code lang}, in encoded words of the body's charset (UTF-8 for UTF-16), sometimes after "Re: ". */
    private static Subject subject(Ctx c, Lang lang, Cs cs) {
        Charset charset = cs.wire() == Wire.UTF16 ? StandardCharsets.UTF_8 : cs.charset();
        String label = cs.wire() == Wire.UTF16 ? "utf-8" : c.labelCase(cs.label());
        String text = words(c, lang, charset, c.between(3, 7), true);
        String header = switch (cs.wire()) {
            case SEVEN_BIT -> text;
            case ESCAPED -> Mime.encodedWords(text, charset, label, true);
            default -> Mime.encodedWords(text, charset, label, c.chance(0.6));
        };
        if (c.chance(0.25)) {
            String prefix = c.pick(List.of("Re: ", "RE: ", "Fwd: ", "FW: ", "AW: ", "TR: "));
            return new Subject(prefix + text, prefix + header);
        }
        return new Subject(text, header);
    }

    private static Subject plainSubject(Ctx c, Lang lang) {
        String text = words(c, lang, StandardCharsets.US_ASCII, c.between(3, 7), true);
        return new Subject(text, text);
    }

    /** Folds a single-spaced header value by putting a CRLF before some of its spaces: unfolding gives it back. */
    private static String foldAtSpaces(Ctx c, String value) {
        StringBuilder out = new StringBuilder();
        int col = 9;
        for (String w : value.split(" ")) {
            if (out.length() > 0) {
                if (col + 1 + w.length() > 70 || c.chance(0.05)) {
                    out.append("\r\n");
                    col = 0;
                }
                out.append(' ');
                col++;
            }
            out.append(w);
            col += w.length();
        }
        return out.toString();
    }

    /** A sender: the From header's value and the address a parser should find in it, lower case. */
    record Sender(String header, String address) {
    }

    static final List<String> LOCALS = List.of("billing", "support", "office", "news", "team", "sales", "travel", "accounts", "hello",
            "info", "notices", "events", "orders", "payroll", "desk", "front.desk", "no-reply", "reports+weekly");
    static final List<String> DOMAINS = List.of("example.com", "example.org", "example.net", "mail.example", "shop.example",
            "news.example", "mail.example.com", "corp.example.org");

    private static Sender sender(Ctx c, Lang lang, Cs cs) {
        String address = c.pick(LOCALS) + "@" + c.pick(DOMAINS);
        Charset charset = cs.wire() == Wire.UTF16 ? StandardCharsets.UTF_8 : cs.charset();
        String label = cs.wire() == Wire.UTF16 ? "utf-8" : cs.label();
        List<String> names = new ArrayList<>();
        for (String n : lang.names()) {
            if (charset.newEncoder().canEncode(n)) {
                names.add(n);
            }
        }
        String name = names.isEmpty() ? c.pick(Langs.EN.names()) : c.pick(names);
        boolean ascii = StandardCharsets.US_ASCII.newEncoder().canEncode(name);
        String header = switch (c.between(0, 4)) {
            case 0 -> address;
            case 1 -> "<" + address + ">";
            case 2 -> ascii ? "\"" + name + "\" <" + address + ">" : Mime.encodedWords(name, charset, label, cs.wire() == Wire.ESCAPED || c.chance(0.5))
                    + " <" + address + ">";
            case 3 -> ascii ? name + " <" + address + ">" : Mime.encodedWords(name, charset, label, true) + " <" + address + ">";
            default -> ascii ? address + " (" + name + ")" : "\"" + Mime.encodedWords(name, StandardCharsets.UTF_8, "utf-8", true).replace("\r\n ", " ")
                    + "\" <" + address + ">";
        };
        return new Sender(header, address);
    }

    private static final int[] OFFSETS = {0, 60, -300, 540, 330, -480, 120, -180, 600};

    private static String date(Ctx c) {
        long jan2026 = 1_767_225_600L;
        return Mime.date(jan2026 + c.rnd.nextLong(300L * 86_400), OFFSETS[c.rnd.nextInt(OFFSETS.length)]);
    }

    /** The headers every generated message starts with. */
    private static Entity envelope(Ctx c, Sender from, String subjectHeader) {
        Entity e = new Entity();
        if (c.chance(0.4)) {
            e.header("Received", "from mail." + c.pick(DOMAINS) + " (mail.example.net [203.0.113." + c.between(1, 254) + "])\r\n\tby mx.desk.example with ESMTPS id "
                    + c.hex(10) + "\r\n\tfor <me@desk.example>; " + date(c));
        }
        e.header("From", from.header());
        e.header("To", c.chance(0.7) ? "me@desk.example" : "\"Desk Owner\" <me@desk.example>");
        e.header("Subject", subjectHeader);
        e.header("Date", date(c));
        e.header("Message-ID", "<gen." + c.n + "." + c.hex(12) + "@" + c.pick(DOMAINS) + ">");
        e.header("MIME-Version", "1.0");
        if (c.chance(0.3)) {
            e.header(c.pick(List.of("X-Mailer", "User-Agent")), c.pick(List.of("Corpus Mailer 1.0", "Example Mail 4.2", "Webmail (example)")));
        }
        return e;
    }

    // ---- The random source ----

    /** One sample's random source and index. */
    static final class Ctx {
        final SplittableRandom rnd;
        final int n;

        Ctx(SplittableRandom rnd, int n) {
            this.rnd = rnd;
            this.n = n;
        }

        int between(int lo, int hiInclusive) {
            return lo + rnd.nextInt(hiInclusive - lo + 1);
        }

        boolean chance(double p) {
            return rnd.nextDouble() < p;
        }

        <T> T pick(List<T> list) {
            return list.get(rnd.nextInt(list.size()));
        }

        String hex(int digits) {
            StringBuilder s = new StringBuilder(digits);
            for (int i = 0; i < digits; i++) {
                s.append(Character.forDigit(rnd.nextInt(16), 16));
            }
            return s.toString();
        }

        /** A label as senders write it: mostly lower case, sometimes upper. */
        String labelCase(String label) {
            return chance(0.3) ? label.toUpperCase(Locale.ROOT) : label;
        }

        /** A boundary in one of the styles real clients use; "=_" can't occur in base64 or quoted-printable. */
        String boundary() {
            return switch (rnd.nextInt(4)) {
                case 0 -> "----=_Part_" + n + "_" + hex(8) + "." + hex(12);
                case 1 -> "Apple-Mail=_" + hex(8).toUpperCase(Locale.ROOT) + "-" + hex(4).toUpperCase(Locale.ROOT);
                case 2 -> "_000_" + hex(16).toUpperCase(Locale.ROOT) + "_";
                default -> "=_" + hex(24);
            };
        }
    }

    /** The vectors, filled for the corpus's host, loaded once. */
    private static final class Vectors {
        static final List<HostileHtml.Vector> ALL = HostileHtml.vectors(HostileHtml.CORPUS_HIT_BASE);
    }
}
