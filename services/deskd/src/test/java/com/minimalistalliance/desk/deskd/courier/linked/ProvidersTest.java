package com.minimalistalliance.desk.deskd.courier.linked;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.courier.CourierMethodsAccess;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Which named provider an address is at, when the office sends neither a provider nor servers, and the words a refusal gets. */
class ProvidersTest {

    @Test
    void theAddresssDomainOrWhereItsMailGoes() {
        Map<String, List<String>> dns = Map.of(
                "work.example", List.of("aspmx.l.google.com.", "alt1.aspmx.l.google.com."),
                "family.example", List.of("in1-smtp.messagingengine.com", "in2-smtp.messagingengine.com"),
                "apple.example", List.of("mx01.mail.icloud.com."),
                "corp.example", List.of("corp-example.mail.protection.outlook.com."),
                "filtered.example", List.of("mx1.filter.example.net.", "aspmx.l.google.com."),
                "self.example", List.of("mail.self.example."),
                "lookalike.example", List.of("google.com.evil.example.", "notgoogle.com."));
        java.util.function.Function<String, List<String>> mx = d -> dns.getOrDefault(d, List.of());
        assertThat(Providers.forAddress("dana@gmail.com", mx)).isEqualTo("gmail");
        assertThat(Providers.forAddress("dana@GoogleMail.com", mx)).isEqualTo("gmail");
        assertThat(Providers.forAddress("dana@me.com", mx)).isEqualTo("icloud");
        assertThat(Providers.forAddress("dana@fastmail.fm", mx)).isEqualTo("fastmail");
        assertThat(Providers.forAddress("dana@ymail.com", mx)).isEqualTo("yahoo");
        assertThat(Providers.forAddress("dana@hotmail.com", mx)).isEqualTo("outlook");
        assertThat(Providers.forAddress("dana@work.example", mx)).isEqualTo("gmail");
        assertThat(Providers.forAddress("dana@family.example", mx)).isEqualTo("fastmail");
        assertThat(Providers.forAddress("dana@apple.example", mx)).isEqualTo("icloud");
        assertThat(Providers.forAddress("dana@corp.example", mx)).isEqualTo("outlook");
        // Mail that goes through anything else first, a host of its own, a name that only looks like one: the member's servers.
        assertThat(Providers.forAddress("dana@filtered.example", mx)).isNull();
        assertThat(Providers.forAddress("dana@self.example", mx)).isNull();
        assertThat(Providers.forAddress("dana@lookalike.example", mx)).isNull();
        assertThat(Providers.forAddress("dana@nowhere.example", mx)).isNull();
        assertThat(Providers.forAddress("dana@localhost", mx)).isNull();
        assertThat(Providers.forAddress("not-an-address", mx)).isNull();
    }

    @Test
    void aRefusalIsWordedForWhatTheMemberCanDo() {
        check("port", null, "bad_request", Map.of("reason", "server", "cause", "port"));
        check("address", null, "bad_request", Map.of("reason", "server", "cause", "address"));
        check("tls", null, "unavailable", Map.of("reason", "provider", "cause", "tls"));
        check("oauth", null, "unavailable", Map.of("reason", "oauth"));
        check("app_password", "Gmail", "forbidden", Map.of("reason", "sign_in", "cause", "app_password", "provider", "Gmail"));
        check("Weird Word!", null, "forbidden", Map.of("reason", "sign_in", "cause", "auth"));
    }

    private static void check(String word, String name, String code, Map<String, Object> details) {
        RpcException e = CourierMethodsAccess.rejected(word, name);
        assertThat(e.code()).as(word).isEqualTo(code);
        assertThat(e.details()).as(word).isEqualTo(details);
    }
}
