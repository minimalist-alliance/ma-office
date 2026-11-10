package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.testing.FakeDoh;
import com.minimalistalliance.desk.deskd.testing.FakeDoh.Record;
import java.io.IOException;
import java.net.http.HttpTimeoutException;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** The family resolver's question and answer: the wire format, what an answer means, and a resolver that misbehaves. */
class FamilyDnsTest {

    private FakeDoh doh;
    private PlatformHttp http;

    @BeforeEach
    void setUp() throws IOException {
        doh = new FakeDoh();
        http = new PlatformHttp();
    }

    @AfterEach
    void tearDown() {
        doh.close();
        http.close();
    }

    private FamilyDns dns(Duration timeout) {
        return new FamilyDns(http, doh.endpoint(), timeout);
    }

    private static byte[] answer(String name, int type, int rcode, Record... records) {
        return FakeDoh.response(FakeDoh.question(name, type), rcode, List.of(records));
    }

    @Test
    void theQueryIsOneQuestionPaddedTo128Bytes() {
        byte[] query = FamilyDns.query("filtered.example.com", FamilyDns.TYPE_A);
        ByteBuffer in = ByteBuffer.wrap(query);
        assertThat(query.length % 128).isZero();
        assertThat(query.length).isEqualTo(128);
        assertThat(in.getShort(0)).as("id 0, RFC 8484 4.1").isZero();
        assertThat(in.getShort(2)).as("RD only").isEqualTo((short) 0x0100);
        assertThat(in.getShort(4)).isEqualTo((short) 1);
        assertThat(in.getShort(6)).isZero();
        assertThat(in.getShort(8)).isZero();
        assertThat(in.getShort(10)).as("the OPT record").isEqualTo((short) 1);
        byte[] question = FakeDoh.question("filtered.example.com", FamilyDns.TYPE_A);
        assertThat(Arrays.copyOfRange(query, 12, 12 + question.length)).isEqualTo(question);
        int opt = 12 + question.length;
        assertThat(query[opt]).as("root name").isZero();
        assertThat(in.getShort(opt + 1)).as("OPT").isEqualTo((short) 41);
        int rdLength = in.getShort(opt + 9);
        assertThat(in.getShort(opt + 11)).as("padding option").isEqualTo((short) 12);
        assertThat(in.getShort(opt + 13)).isEqualTo((short) (rdLength - 4));
        assertThat(opt + 11 + rdLength).isEqualTo(query.length);
        for (int i = opt + 15; i < query.length; i++) {
            assertThat(query[i]).isZero();
        }
    }

    @Test
    void aLongNameIsPaddedToTheNextBlock() {
        String name = "a".repeat(63) + "." + "b".repeat(63) + ".example";
        byte[] query = FamilyDns.query(name, FamilyDns.TYPE_AAAA);
        assertThat(query.length).isEqualTo(256);
    }

    @Test
    void onlyUnspecifiedAddressesAreFiltered() throws IOException {
        assertThat(FamilyDns.addresses(answer("x.example", 1, 0, Record.a(0, 0, 0, 0))))
                .isEqualTo(FamilyDns.Addresses.UNSPECIFIED);
        assertThat(FamilyDns.addresses(answer("x.example", 28, 0, Record.aaaa(true))))
                .isEqualTo(FamilyDns.Addresses.UNSPECIFIED);
        assertThat(FamilyDns.addresses(answer("x.example", 1, 0, Record.a(93, 184, 215, 14))))
                .isEqualTo(FamilyDns.Addresses.REAL);
        assertThat(FamilyDns.addresses(answer("x.example", 1, 0, Record.a(0, 0, 0, 0), Record.a(1, 1, 1, 1))))
                .as("one real address is a real site")
                .isEqualTo(FamilyDns.Addresses.REAL);
        assertThat(FamilyDns.addresses(answer("x.example", 1, 0, Record.cname("cdn.example"), Record.a(0, 0, 0, 0))))
                .as("through a CNAME")
                .isEqualTo(FamilyDns.Addresses.UNSPECIFIED);
        assertThat(FamilyDns.addresses(answer("x.example", 1, 0, Record.cname("cdn.example"))))
                .isEqualTo(FamilyDns.Addresses.NONE);
        assertThat(FamilyDns.addresses(answer("x.example", 1, 0))).isEqualTo(FamilyDns.Addresses.NONE);
        assertThat(FamilyDns.addresses(answer("x.example", 1, 3))).as("NXDOMAIN").isEqualTo(FamilyDns.Addresses.NONE);
    }

    @Test
    void aMessageThatIsntAWholeAnswerIsAFailure() {
        byte[] good = answer("x.example", 1, 0, Record.a(0, 0, 0, 0));
        assertThatThrownBy(() -> FamilyDns.addresses(answer("x.example", 1, 2))).as("SERVFAIL").isInstanceOf(IOException.class);
        assertThatThrownBy(() -> FamilyDns.addresses(new byte[11])).isInstanceOf(IOException.class);
        byte[] query = good.clone();
        query[2] &= 0x7F;
        assertThatThrownBy(() -> FamilyDns.addresses(query)).as("not a response").isInstanceOf(IOException.class);
        byte[] truncated = good.clone();
        truncated[2] |= 0x02;
        assertThatThrownBy(() -> FamilyDns.addresses(truncated)).as("TC").isInstanceOf(IOException.class);
        for (int cut = 12; cut < good.length; cut++) {
            byte[] shorter = Arrays.copyOf(good, cut);
            assertThatThrownBy(() -> FamilyDns.addresses(shorter)).as("cut at %d", cut).isInstanceOf(IOException.class);
        }
        byte[] badLabel = good.clone();
        badLabel[12] = (byte) 0x80;
        assertThatThrownBy(() -> FamilyDns.addresses(badLabel)).isInstanceOf(IOException.class);
    }

    @Test
    void itPostsTheWireFormatAndReadsTheAnswer() throws Exception {
        doh.filter("filtered.example");
        doh.allow("open.example");
        FamilyDns dns = dns(Duration.ofSeconds(5));

        assertThat(dns.filtered("filtered.example")).isTrue();
        assertThat(dns.filtered("open.example")).isFalse();

        assertThat(doh.questions()).hasSize(2).allSatisfy(question -> {
            assertThat(question.method()).isEqualTo("POST");
            assertThat(question.contentType()).isEqualTo("application/dns-message");
            assertThat(question.accept()).isEqualTo("application/dns-message");
            assertThat(question.type()).isEqualTo(FakeDoh.A);
            assertThat(question.bytes() % 128).isZero();
        });
        assertThat(doh.questions()).extracting(FakeDoh.Question::name).containsExactly("filtered.example", "open.example");
    }

    @Test
    void aaaaIsAskedOnlyWhenAHasNoAddress() throws Exception {
        doh.answer("v6only.example", List.of(), List.of(Record.aaaa(true)));
        doh.answer("v6real.example", List.of(), List.of(Record.aaaa(false)));
        FamilyDns dns = dns(Duration.ofSeconds(5));

        assertThat(dns.filtered("v6only.example")).isTrue();
        assertThat(dns.filtered("v6real.example")).isFalse();
        assertThat(dns.filtered("nothing.example")).isFalse();

        assertThat(doh.questions()).extracting(FakeDoh.Question::type)
                .containsExactly(FakeDoh.A, FakeDoh.AAAA, FakeDoh.A, FakeDoh.AAAA, FakeDoh.A, FakeDoh.AAAA);
    }

    @Test
    void aResolverThatDoesntAnswerInTimeIsAFailureInTime() {
        doh.hold();
        FamilyDns dns = dns(Duration.ofMillis(300));
        long start = System.nanoTime();
        assertThatThrownBy(() -> dns.filtered("slow.example")).isInstanceOf(HttpTimeoutException.class);
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(3));
    }

    @Test
    void anErrorStatusOrAnOversizedBodyIsAFailure() {
        FamilyDns dns = dns(Duration.ofSeconds(5));
        doh.status(500);
        assertThatThrownBy(() -> dns.filtered("x.example")).isInstanceOf(IOException.class);
        doh.status(200);
        doh.filter("x.example");
        doh.oversize(FamilyDns.MAX_RESPONSE_BYTES);
        assertThatThrownBy(() -> dns.filtered("x.example")).isInstanceOf(IOException.class);
    }

    @Test
    void noFailureSaysWhatWasAsked() {
        FamilyDns dns = dns(Duration.ofMillis(300));
        doh.status(503);
        assertThatThrownBy(() -> dns.filtered("secret-name.example")).satisfies(error -> assertThat(String.valueOf(error.getMessage()))
                .doesNotContain("secret-name"));
        doh.status(200);
        doh.hold();
        assertThatThrownBy(() -> dns.filtered("secret-name.example")).satisfies(error -> assertThat(String.valueOf(error.getMessage()))
                .doesNotContain("secret-name"));
    }

    @Test
    void hostsAreOnlyNamesChromiumWouldHaveAskedTheResolver() {
        assertThat(FilteredSites.hostOf("https://Filtered.Example.com/a?b#c")).isEqualTo("filtered.example.com");
        assertThat(FilteredSites.hostOf("http://user:pw@filtered.example:8080/x")).isEqualTo("filtered.example");
        assertThat(FilteredSites.hostOf("https://filtered.example./")).isEqualTo("filtered.example");
        assertThat(FilteredSites.hostOf("https://xn--bcher-kva.example/")).isEqualTo("xn--bcher-kva.example");
        assertThat(FilteredSites.hostOf("https://a_b.example")).isEqualTo("a_b.example");
        for (String url : List.of(
                "https://127.0.0.1/",
                "https://10.0.0.1:443/",
                "http://[::1]/",
                "https://localhost/",
                "https://desk.localhost/",
                "http://printer.local/",
                "http://ip-10-0-0-1.ec2.internal/",
                "http://1.0.0.127.in-addr.arpa/",
                "https://intranet/",
                "https://example.123/",
                "ftp://filtered.example/",
                "chrome-error://chromewebdata/",
                "data:text/html,x",
                "https:///nohost",
                "https://bad..example/",
                "https://sp ace.example/",
                "https://" + "a".repeat(64) + ".example/",
                "")) {
            assertThat(FilteredSites.hostOf(url)).as(url).isNull();
        }
        assertThat(FilteredSites.hostOf(null)).isNull();
    }
}
