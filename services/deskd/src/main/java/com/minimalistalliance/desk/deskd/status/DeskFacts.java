package com.minimalistalliance.desk.deskd.status;

/** What desk.status.get and HELLO need about the machine deskd is on. Null until IMDS has been read. */
public interface DeskFacts {

    /** The DeskId tag. */
    String deskId();

    /** The machine's boot id, the same value hello and the heartbeat carry. */
    String bootId();

    String instanceType();

    /** The address desk-rtc advertises. It changes every start. */
    String publicIpv4();

    /** The DeskKind tag says {@code guild}: the desk serves a guild's members, not an owner (API.md section 14). */
    default boolean guildDesk() {
        return false;
    }
}
