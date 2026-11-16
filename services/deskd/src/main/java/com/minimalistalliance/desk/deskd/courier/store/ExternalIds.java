package com.minimalistalliance.desk.deskd.courier.store;

import java.nio.charset.StandardCharsets;

/**
 * The sink's keys, for transports. An email's key doesn't depend on where the source keeps it (an IMAP UID changes with a
 * UIDVALIDITY reset or a move), only on the account, the message's own id and its exact bytes: so a re-sync brings no
 * second copy, and two different messages that share a Message-ID (a Sent copy and the list's echo) stay two.
 */
public final class ExternalIds {

    private ExternalIds() {}

    /** {@code e1:<sha256 of account, Message-ID and the raw bytes' sha256>}. */
    public static String email(String accountId, String messageIdHeader, byte[] raw) {
        String rawSha = BlobStore.sha256(raw);
        String id = Norm.msgid(messageIdHeader);
        String basis = accountId + "\n" + (id == null ? "" : id) + "\n" + rawSha;
        return "e1:" + BlobStore.sha256(basis.getBytes(StandardCharsets.UTF_8));
    }

    /** A key is 1 to 512 printable ASCII characters. */
    static boolean valid(String externalId) {
        if (externalId == null || externalId.isEmpty() || externalId.length() > 512) {
            return false;
        }
        for (int i = 0; i < externalId.length(); i++) {
            char c = externalId.charAt(i);
            if (c < 0x21 || c > 0x7E) {
                return false;
            }
        }
        return true;
    }
}
