package com.minimalistalliance.desk.deskd.courier;

import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.ExternalIds;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;

/** An email for tests, written as RFC 5322 bytes, so the store gets it as a transport would: raw, then parsed. */
final class Mail {

    String from = "Dana Smith <dana@example.com>";
    List<String> to = new ArrayList<>(List.of("me@desk.example"));
    List<String> cc = new ArrayList<>();
    String subject = "Hello";
    String messageId;
    String inReplyTo;
    String references;
    String listId;
    boolean listUnsubscribe;
    String precedence;
    Instant date = Instant.parse("2026-11-01T10:00:00Z");
    String text = "Hi there.";
    List<String[]> attachments = new ArrayList<>(); // name, type, content
    List<String> extraHeaders = new ArrayList<>();

    /** The From's address alone: inside the angle brackets, or the whole field. */
    String fromAddress() {
        int lt = from.lastIndexOf('<');
        int gt = from.lastIndexOf('>');
        return lt >= 0 && gt > lt ? from.substring(lt + 1, gt) : from.strip();
    }

    static Mail from(String from) {
        Mail m = new Mail();
        m.from = from;
        return m;
    }

    /** Another sender, in place of the one it was made with. */
    Mail sender(String from) {
        this.from = from;
        return this;
    }

    Mail to(String... to) {
        this.to = new ArrayList<>(List.of(to));
        return this;
    }

    Mail cc(String... cc) {
        this.cc = new ArrayList<>(List.of(cc));
        return this;
    }

    Mail subject(String s) {
        subject = s;
        return this;
    }

    Mail id(String id) {
        messageId = id;
        return this;
    }

    Mail replyTo(String parent, String refs) {
        inReplyTo = parent;
        references = refs;
        return this;
    }

    Mail text(String t) {
        text = t;
        return this;
    }

    Mail at(String iso) {
        date = Instant.parse(iso);
        return this;
    }

    Mail list(String id) {
        listId = id;
        listUnsubscribe = true;
        return this;
    }

    Mail bulk() {
        listUnsubscribe = true;
        return this;
    }

    Mail attach(String name, String type, String content) {
        attachments.add(new String[] {name, type, content});
        return this;
    }

    Mail header(String line) {
        extraHeaders.add(line);
        return this;
    }

    byte[] bytes() {
        StringBuilder b = new StringBuilder();
        b.append("From: ").append(from).append("\r\n");
        if (!to.isEmpty()) {
            b.append("To: ").append(String.join(", ", to)).append("\r\n");
        }
        if (!cc.isEmpty()) {
            b.append("Cc: ").append(String.join(", ", cc)).append("\r\n");
        }
        if (subject != null) {
            b.append("Subject: ").append(subject).append("\r\n");
        }
        if (date != null) {
            b.append("Date: ").append(DateTimeFormatter.RFC_1123_DATE_TIME.format(date.atOffset(ZoneOffset.UTC))).append("\r\n");
        }
        if (messageId != null) {
            b.append("Message-ID: <").append(messageId).append(">\r\n");
        }
        if (inReplyTo != null) {
            b.append("In-Reply-To: <").append(inReplyTo).append(">\r\n");
        }
        if (references != null) {
            b.append("References: ").append(references).append("\r\n");
        }
        if (listId != null) {
            b.append("List-Id: ").append(listId).append("\r\n");
        }
        if (listUnsubscribe) {
            b.append("List-Unsubscribe: <mailto:unsubscribe@example.com>\r\n");
        }
        if (precedence != null) {
            b.append("Precedence: ").append(precedence).append("\r\n");
        }
        for (String h : extraHeaders) {
            b.append(h).append("\r\n");
        }
        b.append("MIME-Version: 1.0\r\n");
        if (attachments.isEmpty()) {
            b.append("Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n");
            b.append(text.replace("\n", "\r\n"));
        } else {
            b.append("Content-Type: multipart/mixed; boundary=\"XYZ\"\r\n\r\n");
            b.append("--XYZ\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n").append(text.replace("\n", "\r\n")).append("\r\n");
            for (String[] a : attachments) {
                b.append("--XYZ\r\nContent-Type: ").append(a[1]).append("\r\nContent-Disposition: attachment; filename=\"")
                        .append(a[0]).append("\"\r\nContent-Transfer-Encoding: base64\r\n\r\n")
                        .append(java.util.Base64.getMimeEncoder().encodeToString(a[2].getBytes(StandardCharsets.UTF_8))).append("\r\n");
            }
            b.append("--XYZ--\r\n");
        }
        return b.toString().getBytes(StandardCharsets.UTF_8);
    }

    /** As a transport hands it to the sink. */
    Courier.Inbound inbound(String accountId) {
        byte[] raw = bytes();
        return Courier.Inbound.email(accountId, ExternalIds.email(accountId, messageId == null ? null : "<" + messageId + ">", raw), raw,
                Courier.Origin.LIVE);
    }
}
