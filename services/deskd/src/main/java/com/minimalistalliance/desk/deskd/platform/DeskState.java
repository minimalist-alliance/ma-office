package com.minimalistalliance.desk.deskd.platform;

import com.minimalistalliance.desk.deskd.auth.DeskTokenVerifier;
import com.minimalistalliance.desk.deskd.imds.InstanceIdentity;
import com.minimalistalliance.desk.deskd.status.DeskFacts;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;

/**
 * What deskd has learned about this desk so far. It starts empty and fills in during boot, and until
 * it does, the token verifier refuses everything.
 */
public final class DeskState implements DeskFacts, DeskTokenVerifier.Trust {

    private static final String PROD_API = "https://api.minimalistalliance.com";
    private static final String STAGING_API = "https://api.staging.minimalistalliance.com";

    private final String bootId;
    private final String apiOverride;
    private final String jwksOverride;
    private final StreamingPause streamingPause = new StreamingPause(Clock.systemUTC());
    private final AccountDefaults accountDefaults = new AccountDefaults();
    private final TierLimits tierLimits = new TierLimits();
    private volatile InstanceIdentity identity;
    private volatile PlatformConfig config;
    private final java.util.List<java.util.function.Consumer<PlatformConfig>> configListeners =
            new java.util.concurrent.CopyOnWriteArrayList<>();

    /**
     * @param apiOverride API base from deskd.env, or null to go by the Env tag
     * @param jwksOverride JWKS URL from deskd.env, or null to go by config
     */
    public DeskState(String bootId, String apiOverride, String jwksOverride) {
        this.bootId = bootId;
        this.apiOverride = blankToNull(apiOverride);
        this.jwksOverride = blankToNull(jwksOverride);
    }

    public void setIdentity(InstanceIdentity value) {
        identity = value;
    }

    public void setConfig(PlatformConfig value) {
        config = value;
        for (java.util.function.Consumer<PlatformConfig> listener : configListeners) {
            listener.accept(value);
        }
    }

    /** Hears each config as it's applied, on the boot thread. Must not block. */
    public void onConfig(java.util.function.Consumer<PlatformConfig> listener) {
        configListeners.add(listener);
    }

    public InstanceIdentity identity() {
        return identity;
    }

    public PlatformConfig config() {
        return config;
    }

    /** The Platform's bandwidth pause, as heartbeat replies and the config last said (ADR 0095). */
    public StreamingPause streamingPause() {
        return streamingPause;
    }

    /** The account's values for the desk's spending limits, as the config last said (ADR 0043). */
    public AccountDefaults accountDefaults() {
        return accountDefaults;
    }

    /** The free tier's limits on this desk, as the config last said: null for none (ADR 0090). */
    public TierLimits tierLimits() {
        return tierLimits;
    }

    /** @return null if the Env tag isn't one deskd knows, which fails closed: no hello, no sessions */
    public String apiBase() {
        if (apiOverride != null) {
            return apiOverride;
        }
        InstanceIdentity current = identity;
        if (current == null) {
            return null;
        }
        return switch (current.env()) {
            case "prod" -> PROD_API;
            case "staging" -> STAGING_API;
            default -> null;
        };
    }

    /** @return null until there's an override or config */
    public String jwksUrl() {
        if (jwksOverride != null) {
            return jwksOverride;
        }
        PlatformConfig current = config;
        if (current == null) {
            return null;
        }
        if (current.jwksUrl() != null) {
            return current.jwksUrl();
        }
        String api = apiBase();
        return api == null ? null : api + "/.well-known/jwks.json";
    }

    @Override
    public String deskId() {
        InstanceIdentity current = identity;
        return current == null ? null : current.deskId();
    }

    @Override
    public String userId() {
        InstanceIdentity current = identity;
        return current == null ? null : current.userId();
    }

    @Override
    public String issuer() {
        PlatformConfig current = config;
        return current == null ? null : current.issuer();
    }

    @Override
    public boolean guildDesk() {
        InstanceIdentity current = identity;
        return current != null && "guild".equals(current.deskKind());
    }

    @Override
    public String guildId() {
        PlatformConfig current = config;
        return current == null ? null : current.guildId();
    }

    @Override
    public String bootId() {
        return bootId;
    }

    @Override
    public String instanceType() {
        InstanceIdentity current = identity;
        return current == null ? null : current.instanceType();
    }

    @Override
    public String publicIpv4() {
        InstanceIdentity current = identity;
        return current == null ? null : current.publicIpv4();
    }

    /** /proc/sys/kernel/random/boot_id. Null means hello can't succeed, and boot keeps retrying. */
    public static String readBootId() {
        try {
            return Files.readString(Path.of("/proc/sys/kernel/random/boot_id"), StandardCharsets.US_ASCII).trim();
        } catch (IOException e) {
            return null;
        }
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }
}
