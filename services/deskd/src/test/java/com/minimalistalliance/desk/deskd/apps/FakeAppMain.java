package com.minimalistalliance.desk.deskd.apps;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.TreeMap;

/**
 * {@link FakeApp} as a process of its own, for {@link BundledAppHostTest}: the contract's app as {@link BundledAppHost}
 * starts one. It writes what it was told (its environment and working directory) into {@code $MA_APP_DATA/told.json} for
 * the test to read, listens on {@code $MA_APP_SOCKET}, and runs until a signal ends it.
 */
public final class FakeAppMain {

    private FakeAppMain() {}

    public static void main(String[] args) throws Exception {
        Path data = Path.of(System.getenv("MA_APP_DATA"));
        Map<String, Object> told = new TreeMap<>();
        told.put("env", new TreeMap<>(System.getenv()));
        told.put("cwd", Path.of("").toAbsolutePath().toString());
        Files.write(data.resolve("told.json"), Json.bytes(told));
        try (FakeApp app = new FakeApp(Path.of(System.getenv("MA_APP_SOCKET")), FakeApp.Hello.ANSWER)) {
            Thread.currentThread().join();
        }
    }
}
