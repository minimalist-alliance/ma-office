package com.minimalistalliance.desk.agent.socket;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import jdk.net.UnixDomainPrincipal;

/**
 * Who may use the agent socket: one uid, deskd's (1100, {@code desk}, desk-runtime.md section 1). The JDK names the
 * peer's user from {@code SO_PEERCRED}: by its {@code /etc/passwd} name where the container has one, and by its
 * number where it hasn't, which is the case for 1100 in desk-agent's image. Both are accepted, nothing else.
 */
public final class PeerCheck {

    private final int uid;
    private final String name;

    public PeerCheck(int uid) {
        this(uid, Path.of("/etc/passwd"));
    }

    PeerCheck(int uid, Path passwd) {
        this.uid = uid;
        this.name = nameOf(uid, passwd);
    }

    public boolean allowed(UnixDomainPrincipal peer) {
        String user = peer.user().getName();
        return user.equals(Integer.toString(uid)) || (name != null && user.equals(name));
    }

    public int uid() {
        return uid;
    }

    /** This process's own uid, from {@code /proc}, for tests and the training. */
    public static int ownUid() {
        try {
            for (String line : Files.readAllLines(Path.of("/proc/self/status"))) {
                if (line.startsWith("Uid:")) {
                    return Integer.parseInt(line.split("\\s+")[1]);
                }
            }
        } catch (IOException | RuntimeException e) {
            // Below.
        }
        throw new IllegalStateException("can't read this process's uid");
    }

    private static String nameOf(int uid, Path passwd) {
        try {
            List<String> lines = Files.readAllLines(passwd);
            for (String line : lines) {
                String[] fields = line.split(":");
                if (fields.length > 2 && fields[2].equals(Integer.toString(uid))) {
                    return fields[0];
                }
            }
        } catch (IOException | RuntimeException e) {
            // No file: only the number is accepted.
        }
        return null;
    }
}
