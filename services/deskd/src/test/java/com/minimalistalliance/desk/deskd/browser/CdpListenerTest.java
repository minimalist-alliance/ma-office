package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The kernel's table as it really looks, with these listeners in it. Port 9222 is 2406 in hex. */
class CdpListenerTest {

    private static final int KIOSK = 1102;
    private static final String HEADER =
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
    private static final String OTHER_LISTENER =
            "   0: 3500007F:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000   102        0 21354 1 0000 100 0 0 10 0\n";
    private static final String HEADER6 =
            "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
    private static final String IPV6_LOOPBACK = "00000000000000000000000001000000";

    @TempDir
    Path dir;

    private Path tcp;
    private Path tcp6;
    private CdpListener listener;

    @BeforeEach
    void setUp() throws IOException {
        tcp = dir.resolve("tcp");
        tcp6 = dir.resolve("tcp6");
        Files.writeString(tcp, HEADER + OTHER_LISTENER);
        Files.writeString(tcp6, HEADER6);
        listener = new CdpListener(tcp, tcp6, 9222, KIOSK);
    }

    private static String line(String local, String state, int uid) {
        return "   1: " + local + " 00000000:0000 " + state + " 00000000:00000000 00:00000000 00000000  " + uid
                + "        0 31337 1 0000 100 0 0 10 0\n";
    }

    private void addIpv4(String local, String state, int uid) throws IOException {
        Files.writeString(tcp, Files.readString(tcp) + line(local, state, uid));
    }

    private void addIpv6(String local, String state, int uid) throws IOException {
        Files.writeString(tcp6, Files.readString(tcp6) + line(local, state, uid));
    }

    @Test
    void chromiumOnLoopbackIsTrusted() throws IOException {
        addIpv4("0100007F:2406", "0A", KIOSK);
        assertThat(listener.get().kind()).isEqualTo(CdpListener.Kind.TRUSTED);
    }

    @Test
    void anythingElseOnLoopbackIsNotAndItsUidIsSaid() throws IOException {
        addIpv4("0100007F:2406", "0A", 1103);
        assertThat(listener.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103));
    }

    @Test
    void rootIsntKioskEither() throws IOException {
        addIpv4("0100007F:2406", "0A", 0);
        assertThat(listener.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 0));
    }

    @Test
    void theWildcardAnswersLoopbackToo() throws IOException {
        addIpv4("00000000:2406", "0A", 1103);
        assertThat(listener.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103));
    }

    @Test
    void theIpv6WildcardCountsAsTheTableCantSayItsV6Only() throws IOException {
        addIpv6("00000000000000000000000000000000:2406", "0A", 1103);
        assertThat(listener.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103));
    }

    @Test
    void theMappedIpv4FormsCount() throws IOException {
        addIpv6("0000000000000000FFFF00000100007F:2406", "0A", 1103);
        assertThat(listener.get().kind()).isEqualTo(CdpListener.Kind.FOREIGN);
        Files.writeString(tcp6, HEADER6 + line("0000000000000000FFFF000000000000:2406", "0A", 1104));
        assertThat(listener.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1104));
    }

    @Test
    void chromiumOnTheIpv6SideIsTrustedThere() throws IOException {
        addIpv6("0000000000000000FFFF00000100007F:2406", "0A", KIOSK);
        assertThat(listener.get().kind()).isEqualTo(CdpListener.Kind.TRUSTED);
    }

    /** Which Chromium does if 127.0.0.1 is taken. deskd connects only to 127.0.0.1, so these can't answer it. */
    @Test
    void addressesThatCantAnswerDontCount() throws IOException {
        addIpv6("00000000000000000000000001000000:2406", "0A", 1103);
        addIpv4("0200007F:2406", "0A", 1103);
        assertThat(listener.get()).isEqualTo(CdpListener.Verdict.NONE);
    }

    /** Chromium, which found 127.0.0.1 taken as it started and stays where it fell back to. */
    @Test
    void theExpectedUidOnIpv6LoopbackAloneIsDisplaced() throws IOException {
        addIpv6(IPV6_LOOPBACK + ":2406", "0A", KIOSK);
        assertThat(listener.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.DISPLACED, KIOSK));
    }

    @Test
    void whoeverHoldsLoopbackOutranksThat() throws IOException {
        addIpv6(IPV6_LOOPBACK + ":2406", "0A", KIOSK);
        addIpv4("0100007F:2406", "0A", 1103);
        assertThat(listener.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103));
        Files.writeString(tcp, HEADER + line("0100007F:2406", "0A", KIOSK));
        assertThat(listener.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.TRUSTED, KIOSK));
    }

    @Test
    void anotherPortAndAStateThatCantAnswerDontCount() throws IOException {
        addIpv4("0100007F:2407", "0A", 1103);
        addIpv4("0100007F:2407", "01", 1103);
        // TIME_WAIT, FIN_WAIT1 and CLOSE_WAIT: on their way out, whoever they're from.
        addIpv4("0100007F:2406", "06", 1103);
        addIpv4("0100007F:2406", "04", 1103);
        addIpv4("0100007F:2406", "08", 1103);
        assertThat(listener.get()).isEqualTo(CdpListener.Verdict.NONE);
    }

    /** Someone who held the port for a moment and kept what they accepted, with Chromium listening again. */
    @Test
    void aConnectionSomeoneElseAcceptedOnThePortCounts() throws IOException {
        addIpv4("0100007F:2406", "0A", KIOSK);
        addIpv4("0100007F:2406", "01", 1103);
        assertThat(listener.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103));
    }

    @Test
    void aConnectionSomeoneElseAcceptedOnTheIpv6SideCountsToo() throws IOException {
        addIpv4("0100007F:2406", "0A", KIOSK);
        addIpv6("0000000000000000FFFF00000100007F:2406", "01", 1103);
        assertThat(listener.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103));
    }

    /** Chromium's own, as there are while deskd is connected. They say nothing about who's listening now. */
    @Test
    void chromiumsConnectionsDontMakeAListener() throws IOException {
        addIpv4("0100007F:2406", "01", KIOSK);
        assertThat(listener.get()).isEqualTo(CdpListener.Verdict.NONE);
        addIpv4("0100007F:2406", "0A", KIOSK);
        assertThat(listener.get().kind()).isEqualTo(CdpListener.Kind.TRUSTED);
    }

    /** The kernel says root for a connection nobody has accepted yet, on any listener, such as one of deskd's own. */
    @Test
    void aConnectionNobodyHasAcceptedYetIsNobodys() throws IOException {
        addIpv4("0100007F:2406", "0A", KIOSK);
        addIpv4("0100007F:2406", "01", 0);
        assertThat(listener.get().kind()).isEqualTo(CdpListener.Kind.TRUSTED);
    }

    /** deskd's own end of a connection to the port, and anyone else's: the port is on the far side of it. */
    @Test
    void theClientSideOfAConnectionToThePortDoesntCount() throws IOException {
        addIpv4("0100007F:2406", "0A", KIOSK);
        Files.writeString(tcp, Files.readString(tcp)
                + "   2: 0100007F:9C40 0100007F:2406 01 00000000:00000000 00:00000000 00000000  1100        0 31338 1 0000 100 0 0 10 0\n");
        assertThat(listener.get().kind()).isEqualTo(CdpListener.Kind.TRUSTED);
    }

    @Test
    void anyOtherListenerSpoilsItWhicheverComesFirst() throws IOException {
        addIpv4("0100007F:2406", "0A", KIOSK);
        addIpv6("00000000000000000000000000000000:2406", "0A", 1103);
        assertThat(listener.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103));

        Files.writeString(tcp, HEADER + line("00000000:2406", "0A", 1103) + line("0100007F:2406", "0A", KIOSK));
        Files.writeString(tcp6, HEADER6);
        assertThat(listener.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103));
    }

    @Test
    void nobodyListeningSaysSo() {
        assertThat(listener.get()).isEqualTo(CdpListener.Verdict.NONE);
    }

    @Test
    void itFailsClosedIfTheTableCantBeRead() throws IOException {
        Files.delete(tcp);
        assertThat(listener.get()).isEqualTo(CdpListener.Verdict.UNREADABLE);
    }

    @Test
    void itFailsClosedOnAnEmptyTable() throws IOException {
        Files.writeString(tcp, "");
        assertThat(listener.get()).isEqualTo(CdpListener.Verdict.UNREADABLE);
    }

    @Test
    void itFailsClosedOnALineItCantUnderstand() throws IOException {
        Files.writeString(tcp, HEADER + "   1: 0100007F:2406 00000000:0000 0A 00000000:00000000\n");
        assertThat(listener.get()).isEqualTo(CdpListener.Verdict.UNREADABLE);
        Files.writeString(tcp, HEADER + line("0100007F:2406", "0A", 1).replace(" 1 ", " x "));
        assertThat(listener.get().kind()).isNotEqualTo(CdpListener.Kind.TRUSTED);
        Files.writeString(tcp, HEADER + "   1: 0100007F:2406 00000000:0000 0A 00000000:00000000 00:00000000 00000000  notauid        0 3\n");
        assertThat(listener.get()).isEqualTo(CdpListener.Verdict.UNREADABLE);
    }

    @Test
    void aKernelWithoutIpv6HasNoSuchTable() throws IOException {
        addIpv4("0100007F:2406", "0A", KIOSK);
        Files.delete(tcp6);
        assertThat(listener.get().kind()).isEqualTo(CdpListener.Kind.TRUSTED);
    }

    @Test
    void anIpv6TableThatsThereAndUnreadableFailsClosed() throws IOException {
        addIpv4("0100007F:2406", "0A", KIOSK);
        Files.delete(tcp6);
        Files.createDirectory(tcp6);
        assertThat(listener.get()).isEqualTo(CdpListener.Verdict.UNREADABLE);
    }

    @Test
    void itFailsClosedOnMoreSocketsThanItWillRead() throws IOException {
        addIpv4("0100007F:2406", "0A", KIOSK);
        Files.write(tcp, new byte[CdpListener.MAX_TABLE_BYTES + 1], StandardOpenOption.APPEND);
        assertThat(listener.get()).isEqualTo(CdpListener.Verdict.UNREADABLE);
    }

    /** A client's cancel interrupts the call, and that mustn't read as a table that can't be read. */
    @Test
    void anInterruptDoesntStopALook() throws IOException {
        addIpv4("0100007F:2406", "0A", KIOSK);
        Thread.currentThread().interrupt();
        try {
            assertThat(listener.get().kind()).isEqualTo(CdpListener.Kind.TRUSTED);
        } finally {
            Thread.interrupted();
        }
    }

    /** The kernel's own, with a real listener, to prove the format above is what's there. */
    @Test
    void theRealTableAgreesAboutARealListener() throws IOException {
        int uid = BrowserRig.ownUid();
        try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            int port = socket.getLocalPort();
            CdpListener real = new CdpListener(CdpListener.PROC_TCP, CdpListener.PROC_TCP6, port, uid);
            assertThat(real.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.TRUSTED, uid));
            CdpListener wrong = new CdpListener(CdpListener.PROC_TCP, CdpListener.PROC_TCP6, port, uid + 1);
            assertThat(wrong.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, uid));
        }
    }

    /** The kernel's own form of ::1, on a machine that has it. */
    @Test
    void theRealTableSaysWhoIsOnIpv6Loopback() throws IOException {
        int uid = BrowserRig.ownUid();
        ServerSocket socket = new ServerSocket();
        try (socket) {
            try {
                socket.bind(new InetSocketAddress(InetAddress.getByName("::1"), 0), 1);
            } catch (IOException e) {
                Assumptions.abort("no ::1 here");
            }
            int port = socket.getLocalPort();
            CdpListener real = new CdpListener(CdpListener.PROC_TCP, CdpListener.PROC_TCP6, port, uid);
            assertThat(real.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.DISPLACED, uid));
            CdpListener wrong = new CdpListener(CdpListener.PROC_TCP, CdpListener.PROC_TCP6, port, uid + 1);
            assertThat(wrong.get()).isEqualTo(CdpListener.Verdict.NONE);
        }
    }

    /** The kernel's own, with the listener gone and the accepted socket kept, as a forger would. */
    @Test
    void theRealTableShowsWhoKeptAnAcceptedConnection() throws IOException {
        int uid = BrowserRig.ownUid();
        try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            int port = socket.getLocalPort();
            try (Socket client = new Socket(InetAddress.getLoopbackAddress(), port); Socket accepted = socket.accept()) {
                socket.close();
                CdpListener real = new CdpListener(CdpListener.PROC_TCP, CdpListener.PROC_TCP6, port, uid + 1);
                assertThat(real.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, uid));
                assertThat(accepted.isConnected()).isTrue();
                CdpListener expected = new CdpListener(CdpListener.PROC_TCP, CdpListener.PROC_TCP6, port, uid);
                assertThat(expected.get()).isEqualTo(CdpListener.Verdict.NONE);
            }
        }
    }

    /** What this machine's kernel says of a connection still waiting in the queue, which may be deskd's own. */
    @Test
    void theRealTableDoesntHoldAConnectionWaitingToBeAcceptedAgainstTheListener() throws IOException {
        int uid = BrowserRig.ownUid();
        try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
                Socket waiting = new Socket(InetAddress.getLoopbackAddress(), socket.getLocalPort())) {
            CdpListener real = new CdpListener(CdpListener.PROC_TCP, CdpListener.PROC_TCP6, socket.getLocalPort(), uid);
            assertThat(real.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.TRUSTED, uid));
            assertThat(waiting.isConnected()).isTrue();
        }
    }
}
