package com.minimalistalliance.desk.deskd.courier.linked;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.InetAddress;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Where a linked mailbox may connect (Security's condition on the vault's question 4): never the desk itself, IMDS, a
 * private network or the like, by any name or IPv6 form; only egress's ports; a host by name.
 */
class NetTest {

    private static InetAddress ip(String s) throws java.net.UnknownHostException {
        return InetAddress.getByName(s);
    }

    @Test
    void addressesThatAreNeverAProvider() throws Exception {
        for (String a : List.of("127.0.0.1", "127.8.9.10", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
                "169.254.169.254", "169.254.0.5", "100.64.0.1", "100.127.255.254", "224.0.0.1", "255.255.255.255", "240.0.0.1",
                "192.0.2.10", "198.51.100.3", "203.0.113.9", "198.18.0.1", "::1", "::", "fe80::1", "fd00:ec2::254", "fc00::5",
                "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1", "2002:0a00:0001::1",
                "2001:db8::1", "ff02::1", "::ffff:10.0.0.1")) {
            assertThat(Net.forbidden(ip(a))).as(a).isTrue();
        }
    }

    @Test
    void publicAddressesAreFine() throws Exception {
        for (String a : List.of("11.22.33.44", "44.55.66.77", "81.2.3.4", "2600:1f18::10", "2a05:d018::20",
                "64:ff9b::b16:212c", "2002:0b16:212c::1")) {
            assertThat(Net.forbidden(ip(a))).as(a).isFalse();
        }
    }

    @Test
    void aNameIsRefusedIfAnyOfItsAddressesIsForbidden() throws Exception {
        Net net = Net.strict(h -> new InetAddress[] {ip("11.22.33.44"), ip("169.254.169.254")});
        assertThatThrownBy(() -> net.addresses("imap.example.com", 993, Net.IMAP_PORTS)).isInstanceOfSatisfying(Net.Refused.class,
                e -> assertThat(e.reason()).isEqualTo("address"));
        Net ok = Net.strict(h -> new InetAddress[] {ip("11.22.33.44")});
        assertThat(ok.addresses("imap.example.com", 993, Net.IMAP_PORTS)).hasSize(1);
    }

    @Test
    void onlyEgresssPortsAndRealNames() throws Exception {
        Net net = Net.strict(h -> new InetAddress[] {ip("11.22.33.44")});
        assertThatThrownBy(() -> net.addresses("imap.example.com", 143, Net.IMAP_PORTS)).isInstanceOfSatisfying(Net.Refused.class,
                e -> assertThat(e.reason()).isEqualTo("port"));
        assertThatThrownBy(() -> net.addresses("smtp.example.com", 25, Net.SMTP_PORTS)).isInstanceOf(Net.Refused.class);
        for (String bad : List.of("127.0.0.1", "localhost", "a..b.com", "-x.example.com", "x.example.com/evil", "x example.com", "")) {
            assertThatThrownBy(() -> net.addresses(bad, 993, Net.IMAP_PORTS)).as(bad).isInstanceOf(Net.Refused.class);
        }
        assertThat(net.addresses("smtp.example.com", 587, Net.SMTP_PORTS)).hasSize(1);
    }
}
