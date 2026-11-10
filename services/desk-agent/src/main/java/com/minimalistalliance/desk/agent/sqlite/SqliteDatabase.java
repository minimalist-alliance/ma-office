package com.minimalistalliance.desk.agent.sqlite;

import java.io.IOException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.sqlite.SQLiteConfig;

/**
 * One SQLite file and the one platform thread that touches it. sqlite-jdbc is JNI, and a native call pins a
 * virtual thread's carrier for its whole length (services/CLAUDE.md, Footprint rules), so every statement runs on
 * this thread and callers park on the result instead.
 *
 * <p>WAL, {@code synchronous=FULL} (a commit is on disk when it returns: these are a ledger and an audit log, and an
 * LLM call takes seconds anyway), temporary tables in memory so nothing goes to {@code /tmp}, and the schema
 * version in {@code user_version}: migrate forward at open, refuse a newer one (ADR 0040).
 */
public final class SqliteDatabase implements AutoCloseable {

    /** Work on the database's thread. */
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

    private final String name;
    private final ExecutorService thread;
    private final Connection connection;

    private SqliteDatabase(String name, ExecutorService thread, Connection connection) {
        this.name = name;
        this.thread = thread;
        this.connection = connection;
    }

    /**
     * Opens or creates the file, owner-only, and brings its schema up to {@code steps.size()}.
     *
     * @throws SQLException if it can't be opened or migrated, or its schema is newer
     */
    public static SqliteDatabase open(String name, Path file, List<Step> steps) throws SQLException {
        ExecutorService thread = Executors.newSingleThreadExecutor(
                Thread.ofPlatform().name("sqlite-" + name).daemon().factory());
        try {
            Connection connection = waitFor(thread.submit(() -> connect(name, file, steps)));
            return new SqliteDatabase(name, thread, connection);
        } catch (SQLException | RuntimeException | Error e) {
            thread.shutdownNow();
            throw e;
        }
    }

    private static Connection connect(String name, Path file, List<Step> steps) throws SQLException {
        createOwnerOnly(file);
        SQLiteConfig config = new SQLiteConfig();
        config.setJournalMode(SQLiteConfig.JournalMode.WAL);
        config.setSynchronous(SQLiteConfig.SynchronousMode.FULL);
        config.setTempStore(SQLiteConfig.TempStore.MEMORY);
        config.setBusyTimeout(5000);
        config.enforceForeignKeys(true);
        Connection connection = config.createConnection("jdbc:sqlite:" + file);
        try {
            migrate(name, connection, steps);
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

    /** Runs the work on the database's thread, outside a transaction, so each statement commits on its own. */
    public <T> T call(Work<T> work) throws SQLException {
        return waitFor(thread.submit(() -> work.run(connection)));
    }

    /** Runs the work in one {@code BEGIN IMMEDIATE} transaction, rolled back if it throws. */
    public <T> T transaction(Work<T> work) throws SQLException {
        return waitFor(thread.submit(() -> inTransaction(connection, work)));
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
     * Waits without giving up on an interrupt: the statement can't be stopped once it's on the database's thread,
     * and a caller that left early wouldn't know whether its write happened. The interrupt stays set.
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

    public String name() {
        return name;
    }

    @Override
    public void close() {
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
