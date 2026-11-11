package com.minimalistalliance.desk.deskd.apps;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ClosedByInterruptException;
import java.nio.channels.SocketChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

/**
 * deskd's side of {@code /run/desk/apps.sock}, the System Engineer's {@code desk-apps} (root, socket-activated, one request
 * per connection, {@code 0600} owner {@code desk}, as {@code units.sock} and {@code data.sock} are). The wire, which the
 * helper is to meet:
 *
 * <pre>
 * request  one line of JSON:  {"op": "prepare", "id": "org.example.tally", "uid": 2001, "diskMaxBytes": 16777216}
 *                             {"op": "start", "id": …, "uid": …}   {"op": "stop", "id": …}   {"op": "status", "id": …}
 *                             {"op": "remove", "id": …, "uid": …, "deleteData": false}
 * reply    one line of JSON:  {"ok": true} | {"ok": true, "state": "running|stopped|failed", "result": "oom-kill|exit-code|signal|timeout|null"}
 *                             {"ok": false, "code": "bad_request|forbidden|no_quota|not_found|failed", "message": "…"}
 * </pre>
 *
 * Both at most 4 KiB. The helper refuses a uid outside 2000 to 2999 and an id that isn't a manifest's id, and takes the
 * peer's {@code SO_PEERCRED} uid 1100 only, as {@code desk-units} does.
 */
public final class HelperAppHost implements AppHost {

    public static final String DEFAULT_SOCKET = "/run/desk/apps.sock";
    public static final String DEFAULT_APPS_RUN = "/run/ma-apps";
    static final int MAX_LINE = 4096;
    private static final Pattern ID = Pattern.compile("[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*){2,}");

    private final Path helper;
    private final Path runRoot;

    public HelperAppHost(Path helper, Path runRoot) {
        this.helper = helper;
        this.runRoot = runRoot;
    }

    @Override
    public String unavailable() {
        return Files.exists(helper) ? null : "no_sandbox";
    }

    @Override
    public void prepare(String id, int uid, long diskMaxBytes) throws AppHostException, InterruptedException {
        Map<String, Object> request = request("prepare", id);
        request.put("uid", uid);
        request.put("diskMaxBytes", diskMaxBytes);
        call(request, Duration.ofSeconds(30));
    }

    @Override
    public void start(String id, int uid) throws AppHostException, InterruptedException {
        Map<String, Object> request = request("start", id);
        request.put("uid", uid);
        call(request, Duration.ofSeconds(30));
    }

    @Override
    public void stop(String id) throws AppHostException, InterruptedException {
        call(request("stop", id), Duration.ofSeconds(30));
    }

    @Override
    public Status status(String id) throws AppHostException, InterruptedException {
        Map<String, Object> reply = call(request("status", id), Duration.ofSeconds(5));
        return new Status(Json.string(reply, "state"), Json.string(reply, "result"));
    }

    @Override
    public void remove(String id, int uid, boolean deleteData) throws AppHostException, InterruptedException {
        Map<String, Object> request = request("remove", id);
        request.put("uid", uid);
        request.put("deleteData", deleteData);
        call(request, Duration.ofSeconds(120));
    }

    @Override
    public Path socket(String id) {
        return runRoot.resolve(id).resolve("app.sock");
    }

    @Override
    public int peerUid(int appUid) {
        return appUid;
    }

    private static Map<String, Object> request(String op, String id) {
        if (!ID.matcher(id).matches()) {
            throw new IllegalArgumentException("not an app id");
        }
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("op", op);
        request.put("id", id);
        return request;
    }

    private Map<String, Object> call(Map<String, Object> request, Duration timeout) throws AppHostException, InterruptedException {
        byte[] json0 = Json.bytes(request);
        byte[] line = Arrays.copyOf(json0, json0.length + 1);
        line[line.length - 1] = '\n';
        SocketChannel channel;
        try {
            channel = SocketChannel.open(StandardProtocolFamily.UNIX);
        } catch (IOException e) {
            throw new AppHostException("no_sandbox");
        }
        AtomicBoolean timedOut = new AtomicBoolean();
        // Closing the channel is what ends a connect or a read that takes too long.
        Thread watchdog = Thread.ofVirtual().name("apps-helper-timeout").start(() -> {
            try {
                Thread.sleep(timeout);
                timedOut.set(true);
                try {
                    channel.close();
                } catch (IOException e) {
                    // Closed either way.
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        try (channel) {
            try {
                channel.connect(UnixDomainSocketAddress.of(helper));
            } catch (ClosedByInterruptException e) {
                throw e;
            } catch (IOException | RuntimeException e) {
                throw new AppHostException(timedOut.get() ? "timeout" : "no_sandbox");
            }
            ByteBuffer out = ByteBuffer.wrap(line);
            while (out.hasRemaining()) {
                channel.write(out);
            }
            byte[] reply = readLine(channel);
            if (reply == null) {
                throw new AppHostException(timedOut.get() ? "timeout" : "bad_reply");
            }
            Map<String, Object> json;
            try {
                json = Json.parseObject(reply);
            } catch (JsonFormatException e) {
                throw new AppHostException("bad_reply");
            }
            if (!Boolean.TRUE.equals(json.get("ok"))) {
                String code = Json.string(json, "code");
                throw new AppHostException(code == null || code.length() > 32 ? "failed" : code);
            }
            return json;
        } catch (ClosedByInterruptException e) {
            Thread.interrupted();
            throw new InterruptedException();
        } catch (IOException e) {
            throw new AppHostException(timedOut.get() ? "timeout" : "bad_reply");
        } finally {
            watchdog.interrupt();
        }
    }

    private static byte[] readLine(SocketChannel channel) throws IOException {
        ByteBuffer in = ByteBuffer.allocate(MAX_LINE);
        while (in.hasRemaining()) {
            int start = in.position();
            if (channel.read(in) < 0) {
                return null;
            }
            for (int i = start; i < in.position(); i++) {
                if (in.get(i) == '\n') {
                    return Arrays.copyOf(in.array(), i);
                }
            }
        }
        return null;
    }
}
