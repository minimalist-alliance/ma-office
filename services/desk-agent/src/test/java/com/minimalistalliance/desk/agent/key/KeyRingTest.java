package com.minimalistalliance.desk.agent.key;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.provider.ProviderId;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class KeyRingTest {

    private static final String KEY = "sk-ant-api03-abcdefghijklmnop";

    private final List<String> recorded = new ArrayList<>();
    private final KeyRing ring = new KeyRing((action, target, decision) -> recorded.add(action + " " + target + " "
            + decision));

    @Test
    void theCallersBytesAreZeroedAndTheRingHoldsItsOwnCopy() {
        byte[] secret = bytes(KEY);
        ring.put("k1", ProviderId.ANTHROPIC, secret);
        assertThat(secret).containsOnly(0);
        try (KeyLease lease = ring.lend("k1")) {
            assertThat(lease.headerValue("")).isEqualTo(KEY);
            assertThat(lease.provider()).isEqualTo(ProviderId.ANTHROPIC);
        }
        assertThat(recorded).containsExactly("key.add key:k1 provider:anthropic");
    }

    @Test
    void theRingsCopyIsOffHeapAndADropZeroesIt() {
        ring.put("k1", ProviderId.OPENAI, bytes(KEY));
        ByteBuffer held = ring.heldBuffer("k1");
        assertThat(held.isDirect()).isTrue();
        assertThat(ring.drop("k1")).isTrue();
        for (int i = 0; i < held.capacity(); i++) {
            assertThat(held.get(i)).isZero();
        }
        assertThat(ring.lend("k1")).isNull();
        assertThat(ring.drop("k1")).isFalse();
        assertThat(recorded).last().isEqualTo("key.drop key:k1 zeroed");
    }

    @Test
    void aLeaseZeroesItsCopyWhenItCloses() {
        ring.put("k1", ProviderId.OPENAI, bytes(KEY));
        KeyLease lease = ring.lend("k1");
        byte[] lent = lease.bytes();
        lease.close();
        assertThat(lent).containsOnly(0);
        assertThatThrownBy(lease::bytes).isInstanceOf(IllegalStateException.class);
        // The ring's own copy is untouched.
        try (KeyLease again = ring.lend("k1")) {
            assertThat(again.headerValue("Bearer ")).isEqualTo("Bearer " + KEY);
        }
    }

    @Test
    void replacingAKeyZeroesTheOldOne() {
        ring.put("k1", ProviderId.OPENAI, bytes(KEY));
        ByteBuffer old = ring.heldBuffer("k1");
        ring.put("k1", ProviderId.OPENAI, bytes("sk-another-key-123456"));
        assertThat(old.get(0)).isZero();
        assertThat(ring.size()).isEqualTo(1);
    }

    @Test
    void dropAllZeroesEverything() {
        ring.put("k1", ProviderId.OPENAI, bytes(KEY));
        ring.put("k2", ProviderId.XAI, bytes("xai-0123456789abcdef"));
        ByteBuffer one = ring.heldBuffer("k1");
        ByteBuffer two = ring.heldBuffer("k2");
        assertThat(ring.dropAll()).isEqualTo(2);
        assertThat(one.get(0)).isZero();
        assertThat(two.get(0)).isZero();
        assertThat(recorded).last().isEqualTo("key.drop keys:all zeroed:2");
    }

    /** A key goes in an HTTP header, so anything that could end the header line is refused, and zeroed. */
    @Test
    void refusesWhatIsntAKeyAndStillZeroesIt() {
        for (String bad : new String[] {"short", "sk-has space-0123", "sk-crlf\r\nX-Evil: 1", "sk-ünïcode-0123"}) {
            byte[] secret = bad.getBytes(StandardCharsets.UTF_8);
            assertThatThrownBy(() -> ring.put("k1", ProviderId.OPENAI, secret))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageNotContaining(bad);
            assertThat(secret).containsOnly(0);
        }
        assertThatThrownBy(() -> ring.put("bad id", ProviderId.OPENAI, bytes(KEY)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(ring.size()).isZero();
        assertThat(recorded).isEmpty();
    }

    @Test
    void aKeyThatCantBeRecordedIsntKept() {
        KeyRing failing = new KeyRing((action, target, decision) -> {
            throw new java.sql.SQLException("closed");
        });
        byte[] secret = bytes(KEY);
        assertThatThrownBy(() -> failing.put("k1", ProviderId.OPENAI, secret)).isInstanceOf(IllegalStateException.class);
        assertThat(secret).containsOnly(0);
        assertThat(failing.size()).isZero();
    }

    @Test
    void aRestoredKeyIsHeldAndZeroedLikeAnAddedOneButWritesNoRow() {
        byte[] secret = bytes(KEY);
        ring.restore("k1", ProviderId.OPENAI, secret);
        assertThat(secret).containsOnly(0);
        assertThat(ring.heldBuffer("k1").isDirect()).isTrue();
        assertThat(ring.providerOf("k1")).isEqualTo(ProviderId.OPENAI);
        try (KeyLease lease = ring.lend("k1")) {
            assertThat(lease.headerValue("")).isEqualTo(KEY);
        }
        assertThat(recorded).isEmpty();
    }

    /** A sealed file opened, but it still goes in an HTTP header, so the same check holds. */
    @Test
    void aRestoreRefusesWhatIsntAKeyAndStillZeroesIt() {
        byte[] secret = "sk-crlf\r\nX-Evil: 1".getBytes(StandardCharsets.US_ASCII);
        assertThatThrownBy(() -> ring.restore("k1", ProviderId.OPENAI, secret))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(secret).containsOnly(0);
        assertThat(ring.size()).isZero();
    }

    @Test
    void nothingPrintsAKey() {
        ring.put("k1", ProviderId.OPENAI, bytes(KEY));
        try (KeyLease lease = ring.lend("k1")) {
            assertThat(lease.toString()).doesNotContain(KEY).contains("k1");
        }
        assertThat(ring.toString()).doesNotContain(KEY);
    }

    private static byte[] bytes(String key) {
        return key.getBytes(StandardCharsets.US_ASCII);
    }
}
