package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.courier.envelope.IdentityKeyPair;
import com.minimalistalliance.desk.courier.envelope.PublishedKeys;
import com.minimalistalliance.desk.courier.envelope.SafetyNumber;
import com.minimalistalliance.desk.deskd.courier.keys.DeskKeys;
import com.minimalistalliance.desk.deskd.courier.keys.KeyPublisher;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** {@code courier.keys} and the keys' publishing, through deskd's real frames, sessions and RPC layer (Wave 1.4). */
@SuppressWarnings("unchecked")
class CourierKeysMethodsTest {

    @TempDir
    Path dir;

    private final List<PublishedKeys> published = new CopyOnWriteArrayList<>();
    private final KeyPublisher publisher = keys -> {
        published.add(keys);
        return new KeyPublisher.Result(KeyPublisher.Outcome.PUBLISHED, 1, keys.fingerprint(), null, null);
    };

    private CourierRig rig(boolean withKeysDirectory) throws Exception {
        Path keys = dir.resolve("keys");
        if (withKeysDirectory) {
            Files.createDirectory(keys, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        }
        return new CourierRig(dir, dir.resolve("courier"), DeskKeys.Settings.defaults(keys), publisher);
    }

    @Test
    void theDeskTellsItsKeysAndASafetyNumberAndPublishesAtStart() throws Exception {
        try (CourierRig rig = rig(true)) {
            TestClient owner = rig.owner("s1");
            await().until(() -> !published.isEmpty());
            Map<String, Object> k = rig.ok(owner, "courier.keys");
            PublishedKeys mine = rig.module.keys().publicKeys();
            assertThat(k).containsEntry("available", true)
                    .containsEntry("identityKey", mine.identityKey().text())
                    .containsEntry("boxKey", mine.boxKey().text())
                    .containsEntry("fingerprint", mine.fingerprint());
            assertThat((Map<String, Object>) k.get("published")).containsEntry("current", true);
            assertThat(k.toString()).doesNotContain("seed").doesNotContain("secret");
            assertThat(published).hasSize(1).first().matches(p -> p.sameKeys(mine));

            IdentityKeyPair dana = IdentityKeyPair.generate(new SecureRandom());
            Map<String, Object> withPeer = rig.ok(owner, "courier.keys", "peer", dana.publicKey().text());
            assertThat(withPeer.get("safetyNumber")).isEqualTo(SafetyNumber.between(mine.identityKey(), dana.publicKey()));
            Map<String, Object> bad = rig.err(owner, "bad_request", "courier.keys", "peer", "not-a-key");
            assertThat((Map<String, Object>) bad.get("details")).containsEntry("reason", "peer");
        }
    }

    @Test
    void noKeysDirectoryIsUnavailableAndPublishesNothing() throws Exception {
        try (CourierRig rig = rig(false)) {
            TestClient owner = rig.owner("s1");
            Map<String, Object> e = rig.err(owner, "unavailable", "courier.keys");
            assertThat((Map<String, Object>) e.get("details")).containsEntry("reason", "keys");
            rig.module.sweep();
            assertThat(published).isEmpty();
            assertThat(rig.ok(owner, "courier.status").get("state")).isEqualTo("on");
        }
    }

    @Test
    void aTeensOrGuildDeskPublishesNothingAndRefusesTheCall() throws Exception {
        try (CourierRig rig = rig(true)) {
            await().until(() -> !published.isEmpty());
            published.clear();
            rig.band.set(AgeBand.Band.TEEN);
            // A rotation is due, but nothing goes out while Courier is refused here.
            rig.clock.advance(java.time.Duration.ofDays(181));
            rig.module.sweep();
            TestClient owner = rig.owner("s1");
            rig.err(owner, "forbidden", "courier.keys");
            rig.band.set(AgeBand.Band.ADULT);
            rig.guild.set(true);
            rig.module.sweep();
            rig.err(owner, "forbidden", "courier.keys");
            assertThat(published).isEmpty();
            rig.guild.set(false);
            rig.module.sweep();
            assertThat(published).hasSize(1);
        }
    }
}
