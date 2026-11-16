package com.minimalistalliance.desk.deskd.sqlite;

import java.io.IOException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.sqlite.SQLiteConfig;

/**
 * One SQLite file, the one platform thread that writes it, and a few platform threads that only read it. sqlite-jdbc is
 * JNI, and a native call pins a virtual thread's carrier for its whole length (services/CLAUDE.md, Footprint rules), so
 * every statement runs on these threads and callers park on the result instead. Ported from desk-agent's
 * {@code sqlite/SqliteDatabase}, with readers added: in WAL a reader sees the last commit and never waits for the writer,
 * so a long ingest doesn't hold up a member opening a thread.
 *
 * <p>WAL, {@code synchronous=FULL} (a commit is on disk when it returns: a transport acknowledges a message to its source
 * only after that), {@code secure_delete} so a deleted row's bytes don't stay in the file, temporary tables in memory so
 * nothing goes to {@code /tmp}, foreign keys on, and the schema version in {@code user_version}: migrate forward at open,
 * refuse a newer one (ADR 0040).
 */
public final class SqliteDatabase implements AutoCloseable {

    /** Work on one of the database's threads. */
    @FunctionalInterface
    public interface Work<T> {
        T run(Connection connection) throws SQLException;
    }

    /** Schema version n is reached by running {@code steps.get(n - 1)}, in one transaction with the version bump. */
    @FunctionalInterface
    public interface Step {
        void apply(Connection connection) throws SQLException;
    }

    /** The file's schema is newer than this build knows: a rollback onto migrated data. */
    public static final class SchemaTooNewException extends SQLException {
        private static final long serialVersionUID = 1L;

        SchemaTooNewException(String name, int found, int known) {
            super(name + " has schema " + found + ", newer than " + known);
        }
    }

    /**
     * @param readers how many read-only connections, each on its own platform thread; 0 sends reads to the writer
     * @param writerCacheKib the writer's page cache, in KiB
     * @param readerCacheKib each reader's page cache, in KiB
     */
    public record Options(int readers, int writerCacheKib, int readerCacheKib) {
        public static final Options DEFAULT = new Options(0, 2048, 2048);
    }

    private final String name;
    private final ExecutorService writer;
    private final Connection connection;
    private final ExecutorService readers;
    private final BlockingQueue<Connection> readConnections;
    private final List<Connection> allReaders;

    private SqliteDatabase(String name, ExecutorService writer, Connection connection, ExecutorService readers,
            List<Connection> allReaders) {
        this.name = name;
        this.writer = writer;
        this.connection = connection;
        this.readers = readers;
        this.allReaders = allReaders;
        this.readConnections = allReaders.isEmpty() ? null : new ArrayBlockingQueue<>(allReaders.size(), false, allReaders);
    }

    /** Opens or creates the file, owner-only, and brings its schema up to {@code steps.size()}. */
    public static SqliteDatabase open(String name, Path file, List<Step> steps) throws SQLException {
        return open(name, file, steps, Options.DEFAULT);
    }

    /**
     * Opens or creates the file, owner-only, and brings its schema up to {@code steps.size()}, then opens the readers.
     *
     * @throws SQLException if it can't be opened or migrated, or its schema is newer
     */
    public static SqliteDatabase open(String name, Path file, List<Step> steps, Options options) throws SQLException {
        ExecutorService thread = Executors.newSingleThreadExecutor(
                Thread.ofPlatform().name("sqlite-" + name).daemon().factory());
        Connection connection;
        try {
            connection = waitFor(thread.submit(() -> connect(name, file, steps, options.writerCacheKib())));
        } catch (SQLException | RuntimeException | Error e) {
            thread.shutdownNow();
            throw e;
        }
        if (options.readers() <= 0) {
            return new SqliteDatabase(name, thread, connection, null, List.of());
        }
        ExecutorService pool = Executors.newFixedThreadPool(options.readers(),
                Thread.ofPlatform().name("sqlite-" + name + "-read-", 0).daemon().factory());
        List<Connection> opened = new ArrayList<>();
        try {
            for (int i = 0; i < options.readers(); i++) {
                opened.add(waitFor(pool.submit(() -> connectReader(file, options.readerCacheKib()))));
            }
        } catch (SQLException | RuntimeException | Error e) {
            for (Connection c : opened) {
                try {
                    c.close();
                } catch (SQLException ignored) {
                    // Closing what was opened.
                }
            }
            pool.shutdownNow();
            closeOn(thread, connection);
            throw e;
        }
        return new SqliteDatabase(name, thread, connection, pool, List.copyOf(opened));
    }

    private static Connection connect(String name, Path file, List<Step> steps, int cacheKib) throws SQLException {
        createOwnerOnly(file);
        SQLiteConfig config = new SQLiteConfig();
        config.setJournalMode(SQLiteConfig.JournalMode.WAL);
        config.setSynchronous(SQLiteConfig.SynchronousMode.FULL);
        config.setTempStore(SQLiteConfig.TempStore.MEMORY);
        config.setBusyTimeout(5000);
        config.enforceForeignKeys(true);
        Connection connection = config.createConnection("jdbc:sqlite:" + file);
        try {
            try (Statement statement = connection.createStatement()) {
                // A deleted row's bytes are zeroed, in its page and in pages freed, so a purge leaves nothing to read back.
                statement.execute("PRAGMA secure_delete = ON");
                statement.execute("PRAGMA cache_size = -" + Math.max(64, cacheKib));
                // The WAL is truncated back to this after a checkpoint, so a burst doesn't leave a large file.
                statement.execute("PRAGMA journal_size_limit = 16777216");
            }
            migrate(name, connection, steps);
            return connection;
        } catch (SQLException | RuntimeException e) {
            connection.close();
            throw e;
        }
    }

    private static Connection connectReader(Path file, int cacheKib) throws SQLException {
        SQLiteConfig config = new SQLiteConfig();
        config.setReadOnly(true);
        config.setTempStore(SQLiteConfig.TempStore.MEMORY);
        config.setBusyTimeout(5000);
        Connection connection = config.createConnection("jdbc:sqlite:" + file);
        try (Statement statement = connection.createStatement()) {
            statement.execute("PRAGMA query_only = ON");
            statement.execute("PRAGMA cache_size = -" + Math.max(64, cacheKib));
            return connection;
        } catch (SQLException | RuntimeException e) {
            connection.close();
            throw e;
        }
    }

    /** SQLite gives its -wal and -shm files the database file's mode, so they're owner-only too. */
    private static void createOwnerOnly(Path file) throws SQLException {
        try {
            Files.createFile(file, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        } catch (FileAlreadyExistsException e) {
            // Opened as it is.
        } catch (IOException e) {
            throw new SQLException("can't create " + file.getFileName(), e);
        }
    }

    private static void migrate(String name, Connection connection, List<Step> steps) throws SQLException {
        int found;
        try (Statement statement = connection.createStatement();
                ResultSet result = statement.executeQuery("PRAGMA user_version")) {
            found = result.getInt(1);
        }
        if (found > steps.size()) {
            throw new SchemaTooNewException(name, found, steps.size());
        }
        for (int version = found + 1; version <= steps.size(); version++) {
            Step step = steps.get(version - 1);
            int target = version;
            inTransaction(connection, c -> {
                step.apply(c);
                try (Statement statement = c.createStatement()) {
                    statement.execute("PRAGMA user_version = " + target);
                }
                return null;
            });
        }
    }

    /** Runs the work on the writer's thread, outside a transaction, so each statement commits on its own. */
    public <T> T call(Work<T> work) throws SQLException {
        return waitFor(writer.submit(() -> work.run(connection)));
    }

    /** Runs the work in one {@code BEGIN IMMEDIATE} transaction on the writer's thread, rolled back if it throws. */
    public <T> T transaction(Work<T> work) throws SQLException {
        return waitFor(writer.submit(() -> inTransaction(connection, work)));
    }

    /**
     * Runs read-only work on a reader, in one read transaction so every statement sees the same commit. With no readers it
     * runs on the writer's thread.
     */
    public <T> T read(Work<T> work) throws SQLException {
        if (readConnections == null) {
            return waitFor(writer.submit(() -> inReadTransaction(connection, work)));
        }
        return waitFor(readers.submit(() -> {
            Connection c = readConnections.take();
            try {
                return inReadTransaction(c, work);
            } finally {
                readConnections.put(c);
            }
        }));
    }

    private static <T> T inReadTransaction(Connection connection, Work<T> work) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute("BEGIN DEFERRED");
        }
        try {
            return work.run(connection);
        } finally {
            try (Statement statement = connection.createStatement()) {
                statement.execute("COMMIT");
            }
        }
    }

    private static <T> T inTransaction(Connection connection, Work<T> work) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute("BEGIN IMMEDIATE");
        }
        try {
            T result = work.run(connection);
            try (Statement statement = connection.createStatement()) {
                statement.execute("COMMIT");
            }
            return result;
        } catch (SQLException | RuntimeException | Error e) {
            try (Statement statement = connection.createStatement()) {
                statement.execute("ROLLBACK");
            } catch (SQLException rollback) {
                e.addSuppressed(rollback);
            }
            throw e;
        }
    }

    /**
     * Waits without giving up on an interrupt: the statement can't be stopped once it's on the database's thread, and a
     * caller that left early wouldn't know whether its write happened. The interrupt stays set.
     */
    private static <T> T waitFor(Future<T> future) throws SQLException {
        boolean interrupted = false;
        try {
            while (true) {
                try {
                    return future.get();
                } catch (InterruptedException e) {
                    interrupted = true;
                } catch (ExecutionException e) {
                    Throwable cause = e.getCause();
                    if (cause instanceof SQLException sql) {
                        throw sql;
                    }
                    if (cause instanceof RuntimeException runtime) {
                        throw runtime;
                    }
                    if (cause instanceof Error error) {
                        throw error;
                    }
                    throw new SQLException(cause);
                }
            }
        } finally {
            if (interrupted) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /**
     * Copies the WAL into the file and truncates it to nothing, so a page a purge zeroed has no older copy left in it.
     *
     * @return false if a reader kept part of the WAL, which is then still there
     */
    public boolean checkpoint() throws SQLException {
        return call(c -> {
            try (Statement statement = c.createStatement();
                    ResultSet result = statement.executeQuery("PRAGMA wal_checkpoint(TRUNCATE)")) {
                return result.next() && result.getInt(1) == 0;
            }
        });
    }

    public String name() {
        return name;
    }

    @Override
    public void close() {
        if (readers != null) {
            for (Connection c : allReaders) {
                Future<?> closing = readers.submit(() -> {
                    c.close();
                    return null;
                });
                try {
                    waitFor(closing);
                } catch (SQLException e) {
                    // Nothing more to do with it.
                }
            }
            readers.shutdown();
        }
        closeOn(writer, connection);
    }

    private static void closeOn(ExecutorService thread, Connection connection) {
        Future<?> closing = thread.submit(() -> {
            connection.close();
            return null;
        });
        thread.shutdown();
        try {
            waitFor(closing);
            thread.awaitTermination(5, TimeUnit.SECONDS);
        } catch (SQLException e) {
            // Nothing more to do with it.
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
