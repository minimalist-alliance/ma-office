package com.minimalistalliance.desk.deskd.docs;

import com.minimalistalliance.desk.deskd.courier.CourierModule;
import com.minimalistalliance.desk.deskd.courier.parse.CourierSandbox;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.store.Queries;
import java.util.ArrayList;
import java.util.List;

/**
 * Courier's accepted attachments for the index (API.md §25 "Intake"): structure from Courier's store, a part's decoded
 * bytes cut out of the raw message by the sandbox ({@code courier1 part}), as Save to Files does. Nothing while Courier is
 * off or has no store.
 */
public final class CourierDocs {

    private CourierDocs() {}

    public static Intake.CourierSource of(CourierModule courier, CourierSandbox sandbox) {
        return new Intake.CourierSource() {
            @Override
            public List<Item> after(long laneAt, long seq, int messages) throws Exception {
                CourierStore store = courier.usable() ? courier.store() : null;
                if (store == null) {
                    return List.of();
                }
                List<Item> out = new ArrayList<>();
                for (Queries.DocAttachment a : store.queries().documentsAfter(laneAt, seq, messages)) {
                    out.add(new Item(a.seq(), a.laneAt(), a.messageId(), a.part(), a.name(), a.type(), a.bytes(), a.danger(), a.lane(),
                            a.bulk(), a.senderKnown(), a.origin(), a.threadRef(), a.subject(), a.receivedAt(), a.fromAddress(), a.fromName(),
                            a.channelId(), a.contactId()));
                }
                return out;
            }

            @Override
            public byte[] part(String messageId, String part) throws Exception {
                CourierStore store = courier.usable() ? courier.store() : null;
                if (store == null) {
                    return null;
                }
                byte[] raw = store.raw(messageId);
                if (raw == null) {
                    return null;
                }
                CourierSandbox.Answer a = sandbox.part(raw, part);
                return a instanceof CourierSandbox.Ok ok ? ok.body() : null;
            }
        };
    }
}
