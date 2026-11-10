package com.minimalistalliance.desk.agent.attach.worker;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.FilePermission;
import java.net.SocketPermission;
import java.nio.file.Path;
import java.security.Permission;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * AGENT-PARSE-1, checked as configuration: the reader child's policy is asked what it would allow, and nothing is
 * attempted. Security checks here are a config review and the finding's case, never escape attempts (the team rule).
 */
class SandboxPolicyTest {

    @TempDir
    Path dir;

    private Sandbox policy() {
        return new Sandbox(List.of(dir.resolve("app").toString(), System.getProperty("java.home")));
    }

    private void refused(Permission permission) {
        assertThatThrownBy(() -> policy().checkPermission(permission)).isInstanceOf(SecurityException.class);
    }

    @Test
    void theAgentsDataIsNotReadable() {
        // The finding's case: sealed keys and agent.db live under the agent's /data mount.
        refused(new FilePermission(dir.resolve("data/agent/sealed.key").toString(), "read"));
        refused(new FilePermission(dir.resolve("data/agent/agent.db").toString(), "read"));
        refused(new FilePermission("<<ALL FILES>>", "read"));
    }

    @Test
    void onlyItsOwnJarsAndTheJdkAreReadable() {
        assertThatCode(() -> policy().checkPermission(new FilePermission(dir.resolve("app/lib/pdfbox.jar").toString(), "read")))
                .doesNotThrowAnyException();
        assertThatCode(() -> policy().checkPermission(
                new FilePermission(Path.of(System.getProperty("java.home"), "lib", "modules").toString(), "read")))
                .doesNotThrowAnyException();
        // A path that only starts like an allowed root is not inside it.
        refused(new FilePermission(dir.resolve("app-other/x.jar").toString(), "read"));
    }

    @Test
    void nothingIsWrittenConnectedStartedOrReplaced() {
        refused(new FilePermission(dir.resolve("app/planted").toString(), "write"));
        refused(new FilePermission(dir.resolve("app/planted").toString(), "delete"));
        refused(new FilePermission("/usr/bin/sh", "execute"));
        refused(new SocketPermission("localhost:1024-", "connect,resolve"));
        refused(new RuntimePermission("setSecurityManager"));
        refused(new RuntimePermission("createClassLoader"));
        refused(new java.util.PropertyPermission("java.class.path", "write"));
    }

    @Test
    void nativeCodeComesOnlyFromTheJdksOwnLib() {
        refused(new RuntimePermission("loadLibrary." + dir.resolve("app/evil.so")));
        assertThatCode(() -> policy().checkPermission(new RuntimePermission("loadLibrary.awt"))).doesNotThrowAnyException();
    }
}
