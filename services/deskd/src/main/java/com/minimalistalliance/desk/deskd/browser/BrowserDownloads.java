package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.Topic;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.LongSupplier;

/**
 * The member's Browser downloads as Chromium tells of them, for the topic {@value #TOPIC} (LS-31, ADR 0092), so the
 * Browser window can say a download started and finished.
 *
 * <p><b>Where it comes from.</b> {@link BrowserTabs} asks Chromium for {@code Browser.downloadWillBegin} and
 * {@code Browser.downloadProgress} on each connection, with the behavior left at {@code default}: Chromium still saves
 * where the desk's policy says, and deskd only hears about it. So a download is seen only while deskd is connected,
 * which it is while anyone views the Browser, and one under way when the connection goes is dropped from the list, as
 * nothing more will be heard of it.
 *
 * <p><b>What's kept.</b> In memory only, the newest {@value #KEEP}: an id, the file's name, its state and its bytes.
 * The name comes from web content, so it's cleaned as titles are ({@link TabText}), never logged, and goes only to
 * sessions that may see the screen. The address it came from isn't kept at all. {@code filesPath} is there only when
 * the finished file is in the Files app's tree ({@value #FILES_ROOT}), which on today's images it never is.
 *
 * <p><b>Pace.</b> A start or an end publishes at once; progress alone at most once per {@link #PROGRESS_EVERY}. Events
 * go only while someone is subscribed, and every SUB gets the whole list first.
 */
final class BrowserDownloads implements Topic {

    static final String TOPIC = "browser.downloads";
    static final int KEEP = 5;
    static final int NAME_CHARS = 128;
    static final Duration PROGRESS_EVERY = Duration.ofMillis(500);
    /** Where the Files app's tree is on the desk, as Chromium (outside deskd's container) names the path. */
    static final String FILES_ROOT = "/data/files/";
    static final String IN_PROGRESS = "inProgress";
    static final String COMPLETED = "completed";
    static final String CANCELED = "canceled";
    private static final int MAX_ID_CHARS = 64;
    private static final int MAX_PATH_CHARS = 4096;

    private static final class Download {
        final String id;
        String name;
        String state = IN_PROGRESS;
        long receivedBytes;
        long totalBytes;
        String filesPath;

        Download(String id, String name) {
            this.id = id;
            this.name = name;
        }
    }

    private final EventHub hub;
    private final LongSupplier nanos;
    /** The list. Never held while publishing. */
    private final ReentrantLock lock = new ReentrantLock();
    /** Keeps events in the order they were made, so a slower publish can't land after a newer one. Only publishing takes it. */
    private final ReentrantLock publishing = new ReentrantLock();
    /** Oldest first. */
    private final LinkedHashMap<String, Download> downloads = new LinkedHashMap<>();
    /** When the list last went out, so progress alone waits its turn. */
    private long lastPublishNanos;

    BrowserDownloads(EventHub hub, LongSupplier nanos) {
        this.hub = hub;
        this.nanos = nanos;
        this.lastPublishNanos = nanos.getAsLong() - PROGRESS_EVERY.toNanos();
    }

    /** One of Chromium's {@code Browser.download*} events, on the CDP reader's thread. Anything malformed is dropped. */
    void onEvent(String method, Map<String, Object> params) {
        Boolean urgent;
        lock.lock();
        try {
            urgent = switch (method) {
                case "Browser.downloadWillBegin" -> begin(params);
                case "Browser.downloadProgress" -> progress(params);
                default -> null;
            };
        } finally {
            lock.unlock();
        }
        if (urgent != null) {
            publishIfDue(urgent);
        }
    }

    /** The connection to Chromium went: nothing more will be heard of a download under way, so it isn't shown. */
    void connectionLost() {
        boolean changed;
        lock.lock();
        try {
            changed = downloads.values().removeIf(d -> IN_PROGRESS.equals(d.state));
        } finally {
            lock.unlock();
        }
        if (changed) {
            publishIfDue(true);
        }
    }

    /** @return true to publish now, false for progress that can wait, null for nothing to say */
    private Boolean begin(Map<String, Object> params) {
        String id = Json.string(params, "guid");
        if (!isId(id) || downloads.containsKey(id)) {
            return null;
        }
        String name = TabText.clean(Json.string(params, "suggestedFilename"), NAME_CHARS);
        downloads.put(id, new Download(id, name.isBlank() ? "download" : name));
        while (downloads.size() > KEEP) {
            downloads.remove(downloads.keySet().iterator().next());
        }
        return true;
    }

    private Boolean progress(Map<String, Object> params) {
        Download download = downloads.get(Json.string(params, "guid"));
        if (download == null || !IN_PROGRESS.equals(download.state)) {
            return null;
        }
        String state = Json.string(params, "state");
        download.receivedBytes = bytes(params.get("receivedBytes"));
        download.totalBytes = bytes(params.get("totalBytes"));
        if (COMPLETED.equals(state) || CANCELED.equals(state)) {
            download.state = state;
            if (COMPLETED.equals(state)) {
                finished(download, Json.string(params, "filePath"));
            }
            return true;
        }
        return false;
    }

    /** Chromium can rename a file as it saves it ({@code report (1).pdf}), and then says where it went. */
    private static void finished(Download download, String filePath) {
        if (filePath == null || filePath.isEmpty() || filePath.length() > MAX_PATH_CHARS) {
            return;
        }
        Path path;
        try {
            path = Path.of(filePath).normalize();
        } catch (InvalidPathException e) {
            return;
        }
        Path file = path.getFileName();
        if (file != null) {
            String name = TabText.clean(file.toString(), NAME_CHARS);
            if (!name.isBlank()) {
                download.name = name;
            }
        }
        Path root = Path.of(FILES_ROOT);
        if (path.isAbsolute() && path.startsWith(root) && !path.equals(root)) {
            download.filesPath = TabText.clean(root.relativize(path).toString(), MAX_PATH_CHARS);
        }
    }

    private void publishIfDue(boolean urgent) {
        publishing.lock();
        try {
            if (!hub.hasSubscribers(TOPIC)) {
                return;
            }
            Map<String, Object> data;
            lock.lock();
            try {
                long now = nanos.getAsLong();
                if (!urgent && now - lastPublishNanos < PROGRESS_EVERY.toNanos()) {
                    return;
                }
                lastPublishNanos = now;
                data = Map.of("downloads", list());
            } finally {
                lock.unlock();
            }
            hub.publish(TOPIC, "snapshot", data);
        } finally {
            publishing.unlock();
        }
    }

    /** With the lock held. Newest first. */
    private List<Map<String, Object>> list() {
        List<Map<String, Object>> list = new ArrayList<>(downloads.size());
        for (Download download : downloads.values()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("id", download.id);
            entry.put("name", download.name);
            entry.put("state", download.state);
            entry.put("receivedBytes", download.receivedBytes);
            entry.put("totalBytes", download.totalBytes);
            if (download.filesPath != null) {
                entry.put("filesPath", download.filesPath);
            }
            list.add(0, entry);
        }
        return list;
    }

    private static long bytes(Object value) {
        return value instanceof Number number && Double.isFinite(number.doubleValue()) ? Math.max(0, number.longValue()) : 0;
    }

    /** Chromium's guids are UUIDs. Anything else isn't one. */
    private static boolean isId(String id) {
        if (id == null || id.isEmpty() || id.length() > MAX_ID_CHARS) {
            return false;
        }
        for (int i = 0; i < id.length(); i++) {
            char c = id.charAt(i);
            if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') && !(c >= 'A' && c <= 'F') && c != '-') {
                return false;
            }
        }
        return true;
    }

    /** For /health: how many downloads deskd knows of, at most {@value #KEEP}. A count, never a name. */
    int count() {
        lock.lock();
        try {
            return downloads.size();
        } finally {
            lock.unlock();
        }
    }

    // ---- the topic

    @Override
    public boolean coalescible() {
        return true;
    }

    /** It only publishes while someone is subscribed, so a client coming back can't have seen it all. */
    @Override
    public boolean publishesWithNoSubscriber() {
        return false;
    }

    /** A file's name says what the member does, so it follows what lets a session see the screen, as the tabs do. */
    @Override
    public void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params) throws RpcException {
        if (!principal.video()) {
            throw BrowserMethods.forbidden();
        }
    }

    @Override
    public Object snapshot(String topicKey, Map<String, Object> params) {
        lock.lock();
        try {
            return Map.of("downloads", list());
        } finally {
            lock.unlock();
        }
    }
}
