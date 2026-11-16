package com.minimalistalliance.desk.deskd.courier.imsg.connector;

/** The connector's package-private pieces, for the tests in other packages. */
public final class ConnectorLinksAccess {
    private ConnectorLinksAccess() {}

    public static String check(byte[] desk, byte[] device) {
        return ConnectorLinks.checkNumber(desk, device);
    }
}
