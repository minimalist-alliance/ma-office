package com.minimalistalliance.desk.deskd.courier.relay;

import java.io.IOException;
import java.util.List;
import java.util.Map;

/**
 * The seam to Platform's {@code courier-send} (the launch plan §2.10; Wave 2.4, contract 0.4.1, being built on SES): the
 * desk hands over a message from its own address, already written, and the platform checks the From, the size, the
 * recipients and the tier's caps, then gives it to the sending provider, which signs it for the Courier domain. Bounces
 * and complaints come back as delivery notes, sealed to the desk by the mail door.
 *
 * <p>Coded against the format proposed in the draft ADR "Courier's transports" §5, since 0.4.1 isn't written:
 * {@link PlatformCourierSend} is that format, and the test kit's fake relay serves it. Whatever 0.4.1 settles on is a new
 * implementation of this interface; nothing else changes.
 */
public interface CourierSend {

    /**
     * One message from the desk's address.
     *
     * @param from the desk's canonical address, which the platform checks against the desk
     * @param to every envelope recipient, 1 to 50, outside the Courier domain (members' addresses go sealed, never here)
     * @param rfcMessageId the {@code Message-ID} without brackets, what delivery notes name
     * @param raw the RFC 5322 bytes as written by {@code MimeWriter}
     * @param idempotencyKey the same on every try of one send, so a try whose answer was lost isn't sent twice
     */
    record Submission(String from, List<String> to, String rfcMessageId, byte[] raw, String idempotencyKey) {
        /** No text in logs. */
        @Override
        public String toString() {
            return "Submission[" + to.size() + " to, " + raw.length + " bytes]";
        }
    }

    /** Taken by the platform: its id, and per recipient whether it went to the provider ({@code accepted}) or why not. */
    record Accepted(String id, List<String> accepted, Map<String, String> refused) {}

    /** Whether the platform says sending from desk addresses works now (a provider is live, and this desk may send). */
    boolean available();

    /**
     * @throws RelayApi.Refused the platform's refusal: its status and code
     * @throws IOException no clear answer (unreachable, timed out): it may or may not have gone
     */
    Accepted submit(Submission s) throws IOException, InterruptedException;

    /** None: the desk's address only receives. */
    CourierSend NONE = new CourierSend() {
        @Override
        public boolean available() {
            return false;
        }

        @Override
        public Accepted submit(Submission s) throws IOException {
            throw new RelayApi.Refused(503, "no_provider", null);
        }
    };
}
