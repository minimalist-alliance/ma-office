package com.minimalistalliance.desk.deskd.platform;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * {@code endpoints.maia} and {@code endpoints.maiaId} in {@code GET /v1/agent/config} (ma-platform contract 0.4.4,
 * {@code desk-maia.md}): additive, an https URL and the {@code maia.} audience, anything else read as absent, and a config
 * without them is no service.
 */
class PlatformConfigMaiaTest {

    private static PlatformConfig config(Object maia, Object maiaId) {
        Map<String, Object> endpoints = new HashMap<>();
        endpoints.put("issuer", "https://api.minimalistalliance.com");
        endpoints.put("gateway", "wss://gw.minimalistalliance.com/v1");
        if (maia != null) {
            endpoints.put("maia", maia);
        }
        if (maiaId != null) {
            endpoints.put("maiaId", maiaId);
        }
        return PlatformConfig.parse(Map.of("configVersion", 3, "endpoints", endpoints));
    }

    @Test
    void anHttpsEndpointAndAnAudienceMakeTheService() {
        PlatformConfig c = config("https://abc123.lambda-url.us-east-1.on.aws/", "maia.minimalistalliance.com");
        assertThat(c.maiaUrl()).isEqualTo("https://abc123.lambda-url.us-east-1.on.aws");
        assertThat(c.maiaId()).isEqualTo("maia.minimalistalliance.com");
        assertThat(c.maiaService()).isTrue();
        assertThat(config("https://maia.example.test/base", "maia.staging.minimalistalliance.com").maiaUrl())
                .isEqualTo("https://maia.example.test/base");
    }

    @Test
    void withoutThemThereIsNoServiceAndEverythingElseStillReads() {
        PlatformConfig none = config(null, null);
        assertThat(none.maiaUrl()).isNull();
        assertThat(none.maiaId()).isNull();
        assertThat(none.maiaService()).isFalse();
        assertThat(none.gatewayUrl()).isEqualTo("wss://gw.minimalistalliance.com/v1");
        // One without the other is no service.
        assertThat(config("https://maia.example.test", null).maiaService()).isFalse();
        assertThat(config(null, "maia.minimalistalliance.com").maiaService()).isFalse();
        // The old constructors still make a config with none.
        assertThat(new PlatformConfig(1, "i", null, "g", "gid").maiaService()).isFalse();
    }

    @Test
    void anythingButAnHttpsUrlIsReadAsAbsent() {
        for (Object bad : new Object[] {"http://maia.example.test", "ws://maia.example.test", "https://", "https:///x",
                "https://user@maia.example.test", "https://maia.example.test/?a=1", "https://maia.example.test/#f",
                "maia.example.test", "https://maia example.test", 42, true, Map.of("url", "https://x.test"),
                "https://" + "a".repeat(600) + ".test", ""}) {
            assertThat(config(bad, "maia.minimalistalliance.com").maiaUrl()).as(String.valueOf(bad)).isNull();
        }
    }

    @Test
    void theAudienceMustHaveItsShape() {
        for (Object bad : new Object[] {"gw.minimalistalliance.com", "maia.", "maia.ab", "MAIA.minimalistalliance.com",
                "maia.Minimalist.com", "maia.x_y.com", "maia." + "a".repeat(201), "xmaia.minimalistalliance.com", 7,
                " maia.minimalistalliance.com"}) {
            assertThat(config("https://maia.example.test", bad).maiaId()).as(String.valueOf(bad)).isNull();
        }
        assertThat(config("https://maia.example.test", "maia.abc").maiaId()).isEqualTo("maia.abc");
        assertThat(config("https://maia.example.test", "maia." + "a".repeat(200)).maiaId()).isNotNull();
    }
}
