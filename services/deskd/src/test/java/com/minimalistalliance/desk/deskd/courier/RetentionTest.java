package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.courier.store.BlobStore;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Retention (plan §2.9) and deleting for good: nothing of a deleted message stays on the drive. */
class RetentionTest {

    @Test
    void trashAndSpamGoAfterThirtyDaysAndRequestsAfterNinety(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String trash = rig.accept(Mail.from("a@x.example").id("t@x")).messageId();
            String spam = rig.accept(Mail.from("b@x.example").id("s@x")).messageId();
            String request = rig.accept(Mail.from("c@x.example").id("r@x")).messageId();
            String other = rig.accept(Mail.from("d@x.example").to("me@gmail.example").id("o@x"), StoreRig.GMAIL).messageId();
            rig.store.actions().delete(List.of(trash), false);
            rig.store.actions().move(List.of(spam), null, null, "spam");
            rig.clock.advance(Duration.ofDays(29));
            assertThat(rig.store.sweep()).isZero();
            rig.clock.advance(Duration.ofDays(2));
            assertThat(rig.store.sweep()).isEqualTo(2);
            assertThat(rig.store.queries().message(trash, 0)).isNull();
            assertThat(rig.store.queries().message(spam, 0)).isNull();
            assertThat(rig.store.queries().message(request, 0)).isNotNull();
            rig.clock.advance(Duration.ofDays(60));
            assertThat(rig.store.sweep()).isEqualTo(1);
            assertThat(rig.store.queries().message(request, 0)).isNull();
            assertThat(rig.store.queries().message(other, 0)).isNotNull();
            Invariants.check(rig.store);
        }
    }

    /**
     * The canary: a message deleted for good leaves no word of it, and no run of its blob's bytes, in any file of the store,
     * scanned while the store is still open (closing it would checkpoint for us), on every path that deletes for good:
     * Empty Trash, Delete forever and removing an account with its mail, each with a blob kept as a row and as a file
     * (Security CS-L1).
     */
    @Test
    void aMessageDeletedForGoodLeavesNoBytesInTheDatabaseTheWalOrTheBlobs(@TempDir Path dir) throws Exception {
        for (String way : List.of("empty-trash", "delete-forever", "remove-account")) {
            for (boolean large : List.of(false, true)) {
                canary(dir.resolve(way + (large ? "-file" : "-row")), way, large);
            }
        }
    }

    private static void canary(Path dir, String way, boolean large) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String canary = "CANARY-" + Long.toHexString(System.nanoTime()) + "-zebrafish";
            String account = way.equals("remove-account") ? StoreRig.GMAIL : StoreRig.DESK;
            String keep = rig.accept(Mail.from("a@x.example").id("k@x").text("ordinary words")).messageId();
            Mail m = Mail.from("a@x.example").to(account.equals(StoreRig.GMAIL) ? "me@gmail.example" : "me@desk.example").id("g@x")
                    .subject(canary).text("The secret is " + canary);
            if (large) {
                // Random letters, so its gzip stays over the 64 KiB a row may hold and it's a file.
                java.util.Random rnd = new java.util.Random(7);
                StringBuilder noise = new StringBuilder(200_000);
                for (int i = 0; i < 200_000; i++) {
                    noise.append((char) ('a' + rnd.nextInt(26)));
                }
                m.attach("noise.txt", "text/plain", noise.toString());
            }
            String gone = rig.accept(m, account).messageId();
            byte[] raw = rig.store.raw(gone);
            assertThat(raw).isNotNull();
            byte[] blobRun = null;
            if (large) {
                assertThat(blobFiles(dir)).as(way + ": the blob is a file").hasSize(1);
            } else {
                // Its raw bytes are a gzip row in the database: look for a run of those exact bytes too.
                byte[] gz = BlobStore.compressSmall(raw, BlobStore.INLINE_MAX);
                blobRun = java.util.Arrays.copyOfRange(gz, gz.length / 2 - 12, gz.length / 2 + 12);
                assertThat(found(dir, blobRun)).as(way + ": the blob's bytes are there to begin with").isTrue();
                assertThat(blobFiles(dir)).isEmpty();
            }
            switch (way) {
                case "empty-trash" -> {
                    rig.store.actions().delete(List.of(gone), false);
                    rig.store.actions().emptyTrash();
                }
                case "delete-forever" -> {
                    rig.store.actions().delete(List.of(gone), false);
                    assertThat(rig.store.actions().delete(List.of(gone), true)).isEqualTo(1);
                }
                default -> assertThat(rig.store.removeAccount(StoreRig.GMAIL, false)).isTrue();
            }
            assertThat(rig.store.queries().message(gone, 0)).isNull();
            assertThat(blobFiles(dir)).as(way + ": no blob file left").isEmpty();
            byte[] needle = canary.getBytes(StandardCharsets.UTF_8);
            try (var files = Files.walk(dir.resolve("courier"))) {
                for (Path p : files.filter(Files::isRegularFile).toList()) {
                    byte[] bytes = Files.readAllBytes(p);
                    String what = way + (large ? " file " : " row ") + p.getFileName();
                    assertThat(indexOf(bytes, needle)).as(what).isEqualTo(-1);
                    // The FTS index keeps tokens folded: look for the distinctive one too.
                    assertThat(indexOf(bytes, "zebrafish".getBytes(StandardCharsets.UTF_8))).as(what + " token").isEqualTo(-1);
                    if (blobRun != null) {
                        assertThat(indexOf(bytes, blobRun)).as(what + " blob").isEqualTo(-1);
                    }
                }
            }
            assertThat(rig.store.queries().message(keep, 0)).isNotNull();
            Invariants.check(rig.store);
        }
    }

    private static List<Path> blobFiles(Path dir) throws Exception {
        Path blobs = dir.resolve("courier").resolve("blobs");
        if (!Files.isDirectory(blobs)) {
            return List.of();
        }
        try (var files = Files.walk(blobs)) {
            return files.filter(Files::isRegularFile).filter(p -> p.getFileName().toString().endsWith(".eml.gz")).toList();
        }
    }

    private static boolean found(Path dir, byte[] needle) throws Exception {
        try (var files = Files.walk(dir.resolve("courier"))) {
            for (Path p : files.filter(Files::isRegularFile).toList()) {
                if (indexOf(Files.readAllBytes(p), needle) >= 0) {
                    return true;
                }
            }
        }
        return false;
    }

    @Test
    void removingAnAccountCanTakeItsMailOrKeepIt(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String g = rig.accept(Mail.from("a@x.example").to("me@gmail.example").id("g@x"), StoreRig.GMAIL).messageId();
            String d = rig.accept(Mail.from("a@x.example").id("d@x")).messageId();
            assertThat(rig.store.removeAccount(StoreRig.GMAIL, false)).isTrue();
            assertThat(rig.store.queries().message(g, 0)).isNull();
            assertThat(rig.store.queries().message(d, 0)).isNotNull();
            assertThat(rig.store.removeAccount(StoreRig.DESK, true)).isTrue();
            assertThat(rig.store.queries().message(d, 0)).isNotNull();
            assertThat(rig.store.accounts()).extracting(a -> a.id()).doesNotContain(StoreRig.GMAIL, StoreRig.DESK);
            Invariants.check(rig.store);
        }
    }

    private static int indexOf(byte[] hay, byte[] needle) {
        outer:
        for (int i = 0; i + needle.length <= hay.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return i;
        }
        return -1;
    }
}
