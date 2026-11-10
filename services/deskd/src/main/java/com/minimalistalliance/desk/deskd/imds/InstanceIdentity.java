package com.minimalistalliance.desk.deskd.imds;

/**
 * What IMDS says about this instance (desk-endpoint.md 5.2). All present, or deskd refuses sessions.
 *
 * @param deskKind personal, work, guild, custom or test
 * @param env prod or staging
 * @param amiId may be null: hello carries it for Platform's records only
 */
public record InstanceIdentity(
        String deskId,
        String userId,
        String deskKind,
        String env,
        String instanceId,
        String publicIpv4,
        String instanceType,
        String amiId) {}
