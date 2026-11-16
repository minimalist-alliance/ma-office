package com.minimalistalliance.desk.courier.envelope;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * A body to seal that may be too big to hold: read once to digest it, then again while the drop is written. Both reads
 * must give the same bytes, or the drop's writing fails ({@link Sealed#writeDrop}).
 */
public interface BodySource {

    long length() throws IOException;

    InputStream open() throws IOException;

    static BodySource of(byte[] bytes) {
        byte[] copy = bytes.clone();
        return new BodySource() {
            @Override
            public long length() {
                return copy.length;
            }

            @Override
            public InputStream open() {
                return new ByteArrayInputStream(copy);
            }
        };
    }

    static BodySource of(Path file) {
        return new BodySource() {
            @Override
            public long length() throws IOException {
                return Files.size(file);
            }

            @Override
            public InputStream open() throws IOException {
                return Files.newInputStream(file);
            }
        };
    }
}
