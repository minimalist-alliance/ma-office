package com.minimalistalliance.desk.agent.store;

/**
 * One agent as stored. {@code keyId}, {@code provider} and {@code model} are its binding, all null while it has
 * none. {@code limits} is its own limit scopes as JSON, or null for the defaults.
 */
public record AgentRow(
        String id,
        String name,
        String role,
        long createdAt,
        String keyId,
        String provider,
        String model,
        boolean badgeHidden,
        boolean badgeNotice,
        int unseen,
        String limits) {}
