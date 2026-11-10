package com.minimalistalliance.desk.agent.store;

/** A key's metadata (design 9.5): never the key. {@code last4} is its last four characters, as Platform keeps. */
public record KeyRow(String keyId, String provider, String label, String last4, long createdAt, String createdByDesk) {}
