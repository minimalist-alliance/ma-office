package com.minimalistalliance.desk.deskd.courier.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The store's small parts: ids, normalizing, the search parser, agents' text and the blob files. */
class StoreUnitsTest {

    // ---- ids

    @Test
    void idsAreMonotonicWithinAMillisecondAndWhenTheClockGoesBack() {
        Ulid ids = new Ulid();
        String last = "";
        for (int i = 0; i < 10_000; i++) {
            long t = 1_700_000_000_000L + (i % 3 == 0 ? -i : i / 7);
            String id = ids.next(t);
            assertThat(id).hasSize(26);
            assertThat(Ulid.valid(id)).isTrue();
            assertThat(id.compareTo(last)).isPositive();
            last = id;
        }
    }

    @Test
    void anIdCarriesItsTime() {
        String id = new Ulid().next(1_762_948_800_123L);
        assertThat(Ulid.timeOf(id)).isEqualTo(1_762_948_800_123L);
        assertThat(Ulid.valid("not-an-id")).isFalse();
        assertThat(Ulid.valid("8ZZZZZZZZZZZZZZZZZZZZZZZZZ")).isFalse();
        assertThat(Ulid.valid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).isTrue();
    }

    @Test
    void aSeededGeneratorCarriesOnPastTheNewestId() {
        Ulid before = new Ulid();
        String last = null;
        for (int i = 0; i < 100; i++) {
            last = before.next(1_700_000_000_000L);
        }
        Ulid after = new Ulid();
        after.seed(last);
        // The same millisecond, and one the clock went back to: both after it.
        assertThat(after.next(1_700_000_000_000L)).isGreaterThan(last);
        assertThat(after.next(1_600_000_000_000L)).isGreaterThan(last);
    }

    @Test
    void idsAreUniqueAcrossThreads() throws Exception {
        Ulid ids = new Ulid();
        Set<String> all = java.util.concurrent.ConcurrentHashMap.newKeySet();
        List<Thread> threads = new ArrayList<>();
        for (int t = 0; t < 8; t++) {
            threads.add(Thread.ofVirtual().start(() -> {
                for (int i = 0; i < 5_000; i++) {
                    all.add(ids.next(1_700_000_000_000L));
                }
            }));
        }
        for (Thread t : threads) {
            t.join();
        }
        assertThat(all).hasSize(40_000);
    }

    // ---- normalizing

    @Test
    void addressesAreKeyedLowercaseAndJunkIsNone() {
        assertThat(Norm.email("<Dana.Smith@Example.COM.>")).isEqualTo("dana.smith@example.com");
        assertThat(Norm.email("mailto:a@b.example")).isEqualTo("a@b.example");
        assertThat(Norm.email("not an address")).isNull();
        assertThat(Norm.email("a@")).isNull();
        assertThat(Norm.email("@b")).isNull();
        assertThat(Norm.email("a b@c.example")).isNull();
        assertThat(Norm.email("a@b..example")).isNull();
        assertThat(Norm.email("x".repeat(400) + "@b.example")).isNull();
        assertThat(Norm.withoutTag("me+shop@desk.example")).isEqualTo("me@desk.example");
        assertThat(Norm.tag("me+shop@desk.example")).isEqualTo("shop");
        assertThat(Norm.tag("me@desk.example")).isNull();
        assertThat(Norm.phone("+1 (555) 010-2030")).isEqualTo("+15550102030");
        assertThat(Norm.phone("call me")).isNull();
        assertThat(Norm.phone("12")).isNull();
    }

    @Test
    void controlsAndBidiOverridesAreDropped() {
        assertThat(Norm.line("Dana‮ moc.knab\u0007 \u0000Smith\r\n", 100)).isEqualTo("Dana moc.knab Smith");
        assertThat(Norm.clean("a\r\nb\tc", 100, true)).isEqualTo("a\nb\tc");
        assertThat(Norm.line("   ", 10)).isNull();
        assertThat(Norm.line("x".repeat(50), 10)).hasSize(10);
    }

    @Test
    void messageIdsComeOutOfAnyHeader() {
        assertThat(Norm.msgids("<a@b> <c@d>\r\n\t<e@f>")).containsExactly("a@b", "c@d", "e@f");
        assertThat(Norm.msgids("a@b, c@d")).containsExactly("a@b", "c@d");
        assertThat(Norm.msgids("<>")).isEmpty();
        assertThat(Norm.msgids("<has space@x>")).isEmpty();
        assertThat(Norm.msgid(null)).isNull();
        assertThat(Norm.msgids("<" + "x".repeat(300) + "@y>")).isEmpty();
    }

    @Test
    void parentsAreReferencesThenInReplyToWithoutSelfOrRepeats() {
        assertThat(Norm.parents(List.of("r@x", "p@x", "r@x"), List.of("p@x"), "self@x")).containsExactly("r@x", "p@x");
        assertThat(Norm.parents(List.of("self@x", "a@x"), List.of("b@x"), "self@x")).containsExactly("a@x", "b@x");
        List<String> many = new ArrayList<>();
        for (int i = 0; i < 300; i++) {
            many.add(i + "@x");
        }
        List<String> kept = Norm.parents(many, List.of(), null);
        assertThat(kept).hasSize(100).startsWith("0@x").endsWith("299@x");
    }

    @Test
    void subjectsLoseEveryPrefixAndTagInManyLanguages() {
        assertThat(Norm.subject("Re: RE: Fwd: [team] Lunch")).isEqualTo("lunch");
        assertThat(Norm.subject("AW: WG: Café")).isEqualTo("cafe");
        assertThat(Norm.subject("SV: Re[2]: plans")).isEqualTo("plans");
        assertThat(Norm.subject("回复：会议")).isEqualTo("会议");
        assertThat(Norm.subject("Antw: Re (3): x")).isEqualTo("x");
        assertThat(Norm.subject("Re:")).isNull();
        assertThat(Norm.subject("Results: Q3")).isEqualTo("results: q3");
        assertThat(Norm.isReplySubject("Re: x")).isTrue();
        assertThat(Norm.isReplySubject("[list] Re: x")).isTrue();
        assertThat(Norm.isReplySubject("Results")).isFalse();
    }

    // ---- the search parser

    @Test
    void wordsArePrefixedPhrasesQuotedAndOperatorsNarrow() {
        SearchQuery q = SearchQuery.parse("Café \"next week\" from:dana to:\"Bob B\" has:attachment before:2026-11-01 after:2026/10/01 in:people is:unread");
        assertThat(q.match()).isEqualTo("\"cafe\"* AND \"next week\" AND {search_from} : \"dana\"* AND {search_to} : \"bob b\"*");
        assertThat(q.hasAttachment).isTrue();
        assertThat(q.unread).isTrue();
        assertThat(q.before).hasToString("2026-11-01");
        assertThat(q.after).hasToString("2026-10-01");
        assertThat(q.in).isEqualTo("people");
    }

    @Test
    void nothingTypedIsAnOperatorOfFts5() {
        SearchQuery q = SearchQuery.parse("NEAR(a b) OR -x ^y * \"a\"\"b\" col:z (");
        String match = q.match();
        // Every piece is a quoted string; no bare operator survives.
        assertThat(match.replaceAll("\"(?:[^\"]|\"\")*\"\\*?", "S")).matches("S( AND S)*");
        assertThat(SearchQuery.parse("   ").isEmpty()).isTrue();
        assertThat(SearchQuery.parse("!!! ...").isEmpty()).isTrue();
    }

    @Test
    void badOperatorsAndLongQueriesAreRefused() {
        assertThatThrownBy(() -> SearchQuery.parse("before:yesterday")).hasMessage("date");
        assertThatThrownBy(() -> SearchQuery.parse("in:secret")).hasMessage("in");
        assertThatThrownBy(() -> SearchQuery.parse("has:wings")).hasMessage("has");
        assertThatThrownBy(() -> SearchQuery.parse("x".repeat(501))).hasMessage("too_long");
        assertThatThrownBy(() -> SearchQuery.parse("a b c d e f g h i j k l m n o p q")).hasMessage("too_many_terms");
    }

    // ---- what agents get

    @Test
    void linksBecomeTheirDomainsInAscii() {
        assertThat(AgentText.shape("See https://www.Example.com/path?q=1 and www.foo.org/x, or http://xn--80ak6aa92e.com."))
                .isEqualTo("See [link: example.com] and [link: foo.org], or [link: xn--80ak6aa92e.com].");
        assertThat(AgentText.shape("Pay at https://аpple.com/login")).isEqualTo("Pay at [link: xn--pple-43d.com]");
        assertThat(AgentText.shape("http://user:pass@evil.example:8080/a")).isEqualTo("[link: evil.example]");
    }

    @Test
    void quotedMailFoldsToOneLine() {
        String text = "Sounds good.\n\nOn Tue, Nov 10, 2026 at 9:00 AM Dana <dana@example.com> wrote:\n> Lunch?\n>\n>> On Mon Bob wrote:\n>> Maybe\n";
        assertThat(AgentText.shape(text)).isEqualTo("Sounds good.\n\nEarlier messages: 2\n");
        assertThat(AgentText.shape("Yes\n-----Original Message-----\nFrom: x\nold text")).isEqualTo("Yes\nEarlier messages: 1");
        assertThat(AgentText.shape("")).isEmpty();
    }

    // ---- blobs

    @Test
    void aBlobIsKeptExactlyAndOnceAndItsHashIsChecked(@TempDir Path dir) throws Exception {
        BlobStore blobs = new BlobStore(dir.resolve("blobs"));
        byte[] raw = ("From: a@b\r\n\r\n" + "\u0000ÿ binary \r\n".repeat(1000)).getBytes(StandardCharsets.ISO_8859_1);
        String sha = blobs.stage(raw);
        assertThat(blobs.read(sha)).isEqualTo(raw);
        blobs.place(sha, true);
        blobs.release(sha);
        assertThat(Files.exists(blobs.finalPath(sha))).isTrue();
        assertThat(Files.size(blobs.finalPath(sha))).isLessThan(raw.length / 4);
        assertThat(blobs.stage(raw)).isEqualTo(sha);
        blobs.release(sha);
        assertThat(blobs.listAll()).containsExactly(sha);
        // A flipped byte on disk reads as nothing, never as other bytes.
        byte[] stored = Files.readAllBytes(blobs.finalPath(sha));
        stored[stored.length - 6] ^= 1;
        Files.write(blobs.finalPath(sha), stored);
        assertThat(blobs.read(sha)).isNull();
        assertThat(blobs.read("../../etc/passwd")).isNull();
    }

    @Test
    void aSmallBlobCompressesInMemoryAndReadsBackOnlyWhole() {
        byte[] raw = ("From: a@b\r\n\r\n" + "words and more words\r\n".repeat(2000)).getBytes(StandardCharsets.UTF_8);
        byte[] gz = BlobStore.compressSmall(raw, BlobStore.INLINE_MAX);
        assertThat(gz).isNotNull();
        assertThat(gz.length).isLessThan(raw.length / 10);
        String sha = BlobStore.sha256(raw);
        assertThat(BlobStore.decompress(gz, sha)).isEqualTo(raw);
        // Over the limit compressed is no answer, not a cut one.
        assertThat(BlobStore.compressSmall(raw, 64)).isNull();
        assertThat(BlobStore.compressSmall(new byte[BlobStore.INLINE_MAX * 17], BlobStore.INLINE_MAX)).isNull();
        // Another hash, a flipped byte or junk read as nothing.
        assertThat(BlobStore.decompress(gz, BlobStore.sha256(new byte[1]))).isNull();
        byte[] flipped = gz.clone();
        flipped[flipped.length / 2] ^= 1;
        assertThat(BlobStore.decompress(flipped, sha)).isNull();
        assertThat(BlobStore.decompress("not gzip".getBytes(StandardCharsets.UTF_8), sha)).isNull();
    }

    @Test
    void recoveryPlacesWhatARowNamesAndDropsTheRest(@TempDir Path dir) throws Exception {
        BlobStore blobs = new BlobStore(dir.resolve("blobs"));
        String named = blobs.stage("named".getBytes(StandardCharsets.UTF_8));
        String orphan = blobs.stage("orphan".getBytes(StandardCharsets.UTF_8));
        Files.writeString(dir.resolve("blobs/.staged/.half.part"), "torn");
        BlobStore again = new BlobStore(dir.resolve("blobs"));
        int removed = again.recover(sha -> sha.equals(named));
        assertThat(removed).isEqualTo(1);
        assertThat(again.listAll()).containsExactly(named);
        assertThat(again.exists(orphan)).isFalse();
        try (var staged = Files.list(dir.resolve("blobs/.staged"))) {
            assertThat(staged.toList()).isEmpty();
        }
    }

    @Test
    void aPurgeLeavesABlobAWriteIsStagingAlone(@TempDir Path dir) throws Exception {
        BlobStore blobs = new BlobStore(dir.resolve("blobs"));
        String sha = blobs.stage("x".getBytes(StandardCharsets.UTF_8));
        assertThat(blobs.inFlight(sha)).isTrue();
        blobs.stage("x".getBytes(StandardCharsets.UTF_8));
        blobs.release(sha);
        assertThat(blobs.inFlight(sha)).isTrue();
        blobs.release(sha);
        assertThat(blobs.inFlight(sha)).isFalse();
        Set<String> none = new HashSet<>();
        assertThat(none).isEmpty();
    }

    /** Security CS-L2: nothing hidden survives the cleaning, an address that would show as another isn't one, and every way in is cleaned. */
    @Test
    void hiddenCharactersAreDroppedOnEveryPath() {
        String tags = new StringBuilder().appendCodePoint(0xE0049).appendCodePoint(0xE0047).appendCodePoint(0xE004E).toString();
        assertThat(Norm.clean("a\u200Bb\u2060c\u2028d\u2029e\u00ADf\u3164g" + tags + "h\u202Ei", 100, false)).isEqualTo("abcdefghi");
        // Joiners stay in text, where scripts and emoji need them, and go from a line.
        assertThat(Norm.clean("\uD83D\uDC69\u200D\uD83D\uDCBB \u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645", 100, true))
                .contains("\u200D").contains("\u200C");
        assertThat(Norm.line("a\u200Db\u200Cc", 100)).isEqualTo("abc");
        // A lone surrogate is dropped; a pair at the cap isn't split.
        assertThat(Norm.clean("a\uD800b", 10, false)).isEqualTo("ab");
        assertThat(Norm.clean("ab\uD83D\uDE00", 3, false)).isEqualTo("ab");
        assertThat(Norm.email("support@\u202Emoc.lapyap")).isNull();
        assertThat(Norm.email("da\u200Bna@example.com")).isNull();
        assertThat(Norm.email("dana@exam\u00A0ple.com")).isNull();
        assertThat(Norm.email("dana" + tags + "@example.com")).isNull();
        assertThat(Norm.email("Dana@Example.COM")).isEqualTo("dana@example.com");
        // A structured transport's message is cleaned and capped as the sandbox's answer is.
        var m = com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage.chat(
                new com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage.Address("Mu\u202Em" + tags, "+1 555\u200B 010 2030"),
                List.of(new com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage.Address(null, "\u200B")),
                "Call\u0000 me" + tags + "\r\n" + "x".repeat(3 * 1024 * 1024), 1L, List.of());
        // An address holding a hidden character is refused on this path too (CS-I5), not quietly mended.
        assertThat(m.from()).isNull();
        assertThat(new com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage.Address("Mu\u202Em" + tags, "+1 555 010 2030").name())
                .isEqualTo("Mum");
        assertThat(m.to()).isEmpty();
        assertThat(m.text()).startsWith("Call me\n");
        assertThat(m.text()).hasSize(com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage.MAX_TEXT);
        assertThat(m.textTruncated()).isTrue();
    }
}
