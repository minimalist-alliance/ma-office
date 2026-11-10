package com.minimalistalliance.desk.agent.provider;

/**
 * What a client shows for a provider before a key exists: its name, where a member makes a key and sets a spend
 * limit, and what its keys start with, for a check before anything goes to the desk (task 07's {@code
 * agent.providers}).
 *
 * @param console a host name, shown as text and never fetched
 */
public record ProviderInfo(ProviderId id, String console, String keyPrefix) {}
