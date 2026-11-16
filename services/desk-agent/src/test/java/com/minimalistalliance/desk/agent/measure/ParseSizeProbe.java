package com.minimalistalliance.desk.agent.measure;

import com.minimalistalliance.desk.agent.attach.SizedFixtures;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Not a test: writes the files {@code scripts/measure-attach.sh --sizes} feeds the worker, one per kind and size
 * ({@link SizedFixtures}), as {@code <dir>/<kind>-<MiB>.bin}.
 *
 * <p>Args: {@code <dir> <MiB>...}. Prints one {@code parse-size-file} line per file: its bytes and, for the zips, what its
 * entries inflate to (the readers stop at 120 MiB a pass).
 */
public final class ParseSizeProbe {

    private ParseSizeProbe() {}

    public static void main(String[] args) throws IOException {
        Path dir = Files.createDirectories(Path.of(args[0]));
        for (int i = 1; i < args.length; i++) {
            int mib = Integer.parseInt(args[i]);
            for (Map.Entry<String, byte[]> file : SizedFixtures.all(mib << 20).entrySet()) {
                Files.write(dir.resolve(file.getKey() + "-" + mib + ".bin"), file.getValue());
                System.out.printf("parse-size-file kind=%s mib=%d bytes=%d inflated=%s%n", file.getKey(), mib,
                        file.getValue().length, inflated(file.getValue()));
            }
        }
    }

    private static String inflated(byte[] bytes) throws IOException {
        if (bytes.length < 2 || bytes[0] != 'P' || bytes[1] != 'K') {
            return "-";
        }
        long total = 0;
        byte[] sink = new byte[1 << 16];
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(bytes))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                int n;
                while ((n = zip.read(sink)) > 0) {
                    total += n;
                }
            }
        }
        return Long.toString(total);
    }
}
