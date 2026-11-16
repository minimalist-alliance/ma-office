package com.minimalistalliance.desk.deskd.courier.relay;

import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The Courier soak's faults on the REAL staging relay and mail door (CR-4.1), made on the desk's side of the wire so nothing
 * on staging is switched off for anyone else: the relay or the door unreachable, the relay's acks lost (acked here, not
 * there, so the relay hands the envelopes back), its pages duplicated, and send answers lost after the platform took the
 * send (so the desk's retry, with the same {@code Idempotency-Key}, must not send twice).
 */
final class FaultyLinks {

    volatile boolean relayDown;
    volatile boolean loseAcks;
    volatile boolean duplicatePages;
    volatile boolean loseSendAnswers;
    volatile boolean doorDown;
    final AtomicLong injected = new AtomicLong();

    private IOException down(String what) {
        injected.incrementAndGet();
        return new ConnectException("soak fault: " + what + " unreachable");
    }

    /** The relay as the desk sees it through the faults. */
    RelayApi relay(RelayApi real) {
        return new RelayApi() {
            @Override
            public Map<String, Object> addresses() throws IOException, InterruptedException {
                if (relayDown) {
                    throw down("relay");
                }
                return real.addresses();
            }

            @Override
            public Map<String, Object> lookup(String address) throws IOException, InterruptedException {
                if (relayDown) {
                    throw down("relay");
                }
                return real.lookup(address);
            }

            @Override
            public Map<String, Object> reserveDrop(String to, long bytes) throws IOException, InterruptedException {
                if (relayDown) {
                    throw down("relay");
                }
                return real.reserveDrop(to, bytes);
            }

            @Override
            public void upload(String url, Map<String, String> headers, byte[] bytes) throws IOException, InterruptedException {
                if (relayDown) {
                    throw down("relay");
                }
                real.upload(url, headers, bytes);
            }

            @Override
            public Map<String, Object> send(Map<String, Object> envelope, String idempotencyKey) throws IOException, InterruptedException {
                if (relayDown) {
                    throw down("relay");
                }
                Map<String, Object> answer = real.send(envelope, idempotencyKey);
                if (loseSendAnswers) {
                    injected.incrementAndGet();
                    throw new IOException("soak fault: the relay's answer was lost");
                }
                return answer;
            }

            @Override
            @SuppressWarnings("unchecked")
            public Map<String, Object> collect(String after, int limit) throws IOException, InterruptedException {
                if (relayDown) {
                    throw down("relay");
                }
                Map<String, Object> page = real.collect(after, limit);
                if (duplicatePages && page.get("envelopes") instanceof List<?> items && !items.isEmpty()) {
                    injected.incrementAndGet();
                    List<Object> twice = new ArrayList<>(items);
                    twice.addAll(items);
                    Map<String, Object> copy = new java.util.LinkedHashMap<>(page);
                    copy.put("envelopes", twice);
                    return copy;
                }
                return page;
            }

            @Override
            public InputStream download(String url, long max) throws IOException, InterruptedException {
                if (relayDown) {
                    throw down("relay");
                }
                return real.download(url, max);
            }

            @Override
            public Map<String, Object> ack(List<String> ids) throws IOException, InterruptedException {
                if (relayDown) {
                    throw down("relay");
                }
                if (loseAcks) {
                    // Answered here, never reached the relay: it hands these back on the next collect.
                    injected.incrementAndGet();
                    return Map.of("acked", ids.size());
                }
                return real.ack(ids);
            }

            @Override
            public Map<String, Object> pending() throws IOException, InterruptedException {
                if (relayDown) {
                    throw down("relay");
                }
                return real.pending();
            }
        };
    }

    /** courier-send as the desk sees it through the faults. */
    CourierSend door(CourierSend real) {
        return new CourierSend() {
            @Override
            public boolean available() {
                return real.available();
            }

            @Override
            public Accepted submit(Submission s) throws IOException, InterruptedException {
                if (doorDown) {
                    throw down("courier-send");
                }
                Accepted a = real.submit(s);
                if (loseSendAnswers) {
                    injected.incrementAndGet();
                    throw new IOException("soak fault: courier-send's answer was lost");
                }
                return a;
            }
        };
    }
}
