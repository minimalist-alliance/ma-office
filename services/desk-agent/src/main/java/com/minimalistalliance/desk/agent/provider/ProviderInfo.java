package com.minimalistalliance.desk.agent.provider;

import java.util.List;

/**
 * What a client shows for a provider before a key exists: its name, where a member makes a key and sets a spend
 * limit, and what its keys start with, for a check before anything goes to the desk (task 07's {@code
 * agent.providers}).
 *
 * @param console a host name, shown as text and never fetched
 * @param ownPrefixes longer prefixes only this provider's keys have, which the key-prefix check also reads (not sent to
 *     clients): OpenAI's {@code sk-proj-}, {@code sk-svcacct-} and {@code sk-admin-}, so such a key picked as Moonshot
 *     AI's, which shares {@code sk-}, never leaves the desk
 */
public record ProviderInfo(ProviderId id, String console, String keyPrefix, List<String> ownPrefixes) {

    public ProviderInfo {
        ownPrefixes = ownPrefixes == null ? List.of() : List.copyOf(ownPrefixes);
    }

    public ProviderInfo(ProviderId id, String console, String keyPrefix) {
        this(id, console, keyPrefix, List.of());
    }

    /** {@link #keyPrefix} and {@link #ownPrefixes}, the empty ones left out. */
    public List<String> prefixes() {
        java.util.ArrayList<String> all = new java.util.ArrayList<>();
        if (keyPrefix != null && !keyPrefix.isEmpty()) {
            all.add(keyPrefix);
        }
        for (String prefix : ownPrefixes) {
            if (prefix != null && !prefix.isEmpty()) {
                all.add(prefix);
            }
        }
        return all;
    }
}
