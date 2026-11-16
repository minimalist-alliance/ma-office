package com.minimalistalliance.desk.deskd.browser;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.core.read.ListAppender;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.slf4j.LoggerFactory;

/**
 * Every CDP command deskd sends while a real-Chromium test runs ({@link CdpClient.Tap}), on every path (the member's own
 * tabs, the view, the walker, the Agent's), and the Agent's paths' log lines, and what neither may ever hold (the draft
 * ADR's §17 Browser row, §5 and §7):
 * <ul>
 *   <li>no command on any path clears or writes storage, cookies, cache or history: in those domains only a {@code get}
 *       goes out (the member's own cookies are read for {@code data.browser.cookies}, never written);</li>
 *   <li>every command {@link AgentCdp} sent is on its list;</li>
 *   <li>no command that didn't go through {@link AgentCdp} names an Agent session, target or context, so nothing reaches
 *       the Agent's tabs past the allow-list (the ids are the ones the Agent's own commands named);</li>
 *   <li>no log line of the Browser's or the tools' packages, at any level, holds an address, so no page, path or query
 *       of what the Agent or the member browsed: a site is all the Agent's logs ever say, in its audit row (desk-agent's
 *       {@code browser.session.grant}).</li>
 * </ul>
 */
final class CdpRecorder implements CdpClient.Tap, AutoCloseable {

    record Sent(String sessionId, String method, Map<String, Object> params, boolean agent) {}

    /** The domains whose writes would clear or change what the member keeps; of them only a {@code get} may go out. */
    private static final Pattern STORAGE_DOMAIN =
            Pattern.compile("^(Storage|Network|DOMStorage|IndexedDB|CacheStorage|ServiceWorker|BackgroundService|FileSystem|Database|Cookies)\\.");

    /** Writers elsewhere: of cookies, history, caches or site data, and the browser's resets and grants. */
    private static final List<Pattern> WRITERS = List.of(
            Pattern.compile("(?i)\\.(set|delete|clear|remove|add|override|reset)[A-Za-z]*cookie"),
            Pattern.compile("(?i)(clear|delete|erase|wipe|purge|reset)[A-Za-z]*(data|cache|storage|cookie|history|quota)"),
            Pattern.compile("^Page\\.(resetNavigationHistory|clearCompilationCache)$"),
            Pattern.compile("^Browser\\.(reset|clear|grant|setPermission)"));

    /** The Browser's and the tools' loggers, whole packages, so shared code and new classes are watched too. */
    private static final List<String> AGENT_LOGGERS = List.of(
            "com.minimalistalliance.desk.deskd.browser", "com.minimalistalliance.desk.deskd.tools");

    private final List<Sent> sent = Collections.synchronizedList(new ArrayList<>());
    private final ListAppender<ILoggingEvent> logs = new ListAppender<>();
    private final List<Level> levels = new ArrayList<>();

    private CdpRecorder() {}

    /** Records from now until {@link #close}. One at a time: the tap is the JVM's. */
    static CdpRecorder start() {
        CdpRecorder recorder = new CdpRecorder();
        recorder.logs.start();
        for (String name : AGENT_LOGGERS) {
            Logger logger = (Logger) LoggerFactory.getLogger(name);
            recorder.levels.add(logger.getLevel());
            logger.setLevel(Level.DEBUG);
            logger.addAppender(recorder.logs);
        }
        CdpClient.tap = recorder;
        return recorder;
    }

    @Override
    public void sent(String sessionId, String method, Map<String, Object> params, boolean agent) {
        sent.add(new Sent(sessionId, method, params == null ? Map.of() : new LinkedHashMap<>(params), agent));
    }

    @Override
    public void close() {
        CdpClient.tap = null;
        for (int i = 0; i < AGENT_LOGGERS.size(); i++) {
            Logger logger = (Logger) LoggerFactory.getLogger(AGENT_LOGGERS.get(i));
            logger.detachAppender(logs);
            logger.setLevel(levels.get(i));
        }
        logs.stop();
    }

    List<Sent> sent() {
        synchronized (sent) {
            return List.copyOf(sent);
        }
    }

    /** What was wrong in what was recorded, one line each; empty when all of it holds. */
    List<String> broken() {
        List<Sent> all = sent();
        List<String> broken = new ArrayList<>();
        Set<String> sessions = new HashSet<>();
        Set<String> targets = new HashSet<>();
        Set<String> contexts = new HashSet<>();
        for (Sent s : all) {
            if (STORAGE_DOMAIN.matcher(s.method()).find() && !s.method().matches("^[A-Za-z]+\\.get[A-Z][A-Za-z]*$")) {
                broken.add("a storage domain's non-read: " + s.method() + (s.agent() ? " (agent)" : ""));
            }
            for (Pattern writer : WRITERS) {
                if (writer.matcher(s.method()).find()) {
                    broken.add("a writer: " + s.method() + (s.agent() ? " (agent)" : ""));
                }
            }
            if (s.agent()) {
                if (!AgentCdp.ALLOWED.contains(s.method())) {
                    broken.add("an agent command off the list: " + s.method());
                }
                if (s.sessionId() != null) {
                    sessions.add(s.sessionId());
                }
                if (s.params().get("sessionId") instanceof String child) {
                    sessions.add(child);
                }
                if (s.params().get("targetId") instanceof String target) {
                    targets.add(target);
                }
                if (s.params().get("browserContextId") instanceof String context) {
                    contexts.add(context);
                }
            }
        }
        for (Sent s : all) {
            if (s.agent()) {
                continue;
            }
            if (s.sessionId() != null && sessions.contains(s.sessionId())
                    || s.params().get("sessionId") instanceof String child && sessions.contains(child)) {
                broken.add("past the allow-list, to an agent session: " + s.method());
            }
            if (s.params().get("targetId") instanceof String target && targets.contains(target)) {
                broken.add("past the allow-list, naming an agent target: " + s.method());
            }
            if (s.params().get("browserContextId") instanceof String context && contexts.contains(context)) {
                broken.add("past the allow-list, naming an agent context: " + s.method());
            }
        }
        List<ILoggingEvent> events;
        synchronized (logs) {
            events = List.copyOf(logs.list);
        }
        for (ILoggingEvent event : events) {
            StringBuilder line = new StringBuilder(String.valueOf(event.getFormattedMessage()));
            for (IThrowableProxy t = event.getThrowableProxy(); t != null; t = t.getCause()) {
                line.append(" | ").append(t.getMessage());
            }
            String text = line.toString();
            if (text.contains("://") || text.matches("(?s).*\\b[a-z0-9-]+\\.test\\b.*")) {
                broken.add("an address in the log: " + event.getLoggerName() + ": " + text);
            }
        }
        return broken;
    }

    long agentCommands() {
        return sent().stream().filter(Sent::agent).count();
    }
}
