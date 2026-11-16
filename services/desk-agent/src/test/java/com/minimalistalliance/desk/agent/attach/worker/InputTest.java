package com.minimalistalliance.desk.agent.attach.worker;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Arrays;
import java.util.SplittableRandom;
import org.apache.pdfbox.io.RandomAccessRead;
import org.apache.pdfbox.io.RandomAccessReadBuffer;
import org.junit.jupiter.api.Test;

/** The worker's chunked input: the bytes it read, by stream and by PDFBox's reads, against PDFBox's own buffer. */
class InputTest {

    private static byte[] random(int length, long seed) {
        byte[] bytes = new byte[length];
        new SplittableRandom(seed).nextBytes(bytes);
        return bytes;
    }

    /** A stream that hands out at most {@code most} bytes a read, as a pipe or a socket can. */
    private static InputStream trickle(byte[] bytes, int most) {
        return new ByteArrayInputStream(bytes) {
            @Override
            public synchronized int read(byte[] b, int off, int len) {
                return super.read(b, off, Math.min(len, most));
            }
        };
    }

    @Test
    void itHoldsWhatWasReadAtEverySizeAroundAChunk() throws IOException {
        for (int length : new int[] {0, 1, Input.CHUNK - 1, Input.CHUNK, Input.CHUNK + 1, 3 * Input.CHUNK + 17}) {
            byte[] bytes = random(length, length);
            Input input = Input.read(trickle(bytes, 1000), Long.MAX_VALUE);
            assertThat(input.length()).isEqualTo(length);
            assertThat(input.stream().readAllBytes()).isEqualTo(bytes);
            // A second stream starts again from the first byte (xlsx reads twice).
            assertThat(input.stream().readAllBytes()).isEqualTo(bytes);
            byte[] all = new byte[length];
            int n = length == 0 ? 0 : input.read(all, 0, length);
            assertThat(n).isEqualTo(length);
            assertThat(all).isEqualTo(bytes);
            assertThat(input.isEOF()).isTrue();
            assertThat(input.read()).isEqualTo(-1);
        }
    }

    @Test
    void theCapRefusesOneByteOverAndTakesExactlyIt() throws IOException {
        byte[] bytes = random(2 * Input.CHUNK + 5, 7);
        assertThat(Input.read(new ByteArrayInputStream(bytes), bytes.length).length()).isEqualTo(bytes.length);
        assertThatThrownBy(() -> Input.read(new ByteArrayInputStream(bytes), bytes.length - 1L))
                .isInstanceOf(IOException.class).hasMessage("input");
    }

    @Test
    void limitedCountsWhatItSkipsAndDrains() throws IOException {
        byte[] bytes = random(100_000, 3);
        Input.Limited exact = new Input.Limited(new ByteArrayInputStream(bytes), bytes.length);
        assertThat(exact.read()).isGreaterThanOrEqualTo(0);
        assertThat(exact.skip(50_000)).isEqualTo(50_000);
        exact.drain();
        assertThat(exact.read()).isEqualTo(-1);
        Input.Limited over = new Input.Limited(new ByteArrayInputStream(bytes), bytes.length - 1L);
        assertThat(over.skip(1000)).isEqualTo(1000);
        assertThatThrownBy(over::drain).isInstanceOf(IOException.class).hasMessage("input");
    }

    /**
     * The same random walk of reads, seeks, peeks, rewinds, skips and views on {@link Input} and on PDFBox's
     * {@link RandomAccessReadBuffer} over the same bytes gives the same answers: PDFBox sees no difference.
     */
    @Test
    void randomAccessAnswersAsPdfBoxsOwnBufferDoes() throws IOException {
        byte[] bytes = random(5 * Input.CHUNK + 123, 11);
        SplittableRandom walk = new SplittableRandom(5);
        try (Input input = Input.read(new ByteArrayInputStream(bytes), Long.MAX_VALUE);
                RandomAccessReadBuffer reference = new RandomAccessReadBuffer(bytes)) {
            compare(input, reference, walk, bytes.length, 4000);
            for (int v = 0; v < 20; v++) {
                long start = walk.nextInt(bytes.length);
                long length = walk.nextInt((int) (bytes.length - start) + 1);
                try (RandomAccessRead a = input.createView(start, length);
                        RandomAccessRead b = reference.createView(start, length)) {
                    compare(a, b, walk, (int) length, 300);
                }
            }
        }
    }

    private static void compare(RandomAccessRead a, RandomAccessRead b, SplittableRandom walk, int length, int steps)
            throws IOException {
        for (int step = 0; step < steps; step++) {
            String what;
            switch (walk.nextInt(8)) {
                case 0 -> {
                    what = "read";
                    assertThat(a.read()).as(what).isEqualTo(b.read());
                }
                case 1 -> {
                    int count = walk.nextInt(3 * Input.CHUNK);
                    int offset = walk.nextInt(8);
                    byte[] x = new byte[offset + count];
                    byte[] y = new byte[offset + count];
                    what = "read " + count;
                    assertThat(a.read(x, offset, count)).as(what).isEqualTo(b.read(y, offset, count));
                    assertThat(Arrays.equals(x, y)).as(what).isTrue();
                }
                case 2 -> {
                    long to = walk.nextInt(length + 50);
                    what = "seek " + to;
                    a.seek(to);
                    b.seek(to);
                }
                case 3 -> {
                    what = "peek";
                    assertThat(a.peek()).as(what).isEqualTo(b.peek());
                }
                case 4 -> {
                    int back = (int) Math.min(walk.nextInt(100), b.getPosition());
                    what = "rewind " + back;
                    a.rewind(back);
                    b.rewind(back);
                }
                case 5 -> {
                    int ahead = walk.nextInt(Input.CHUNK);
                    what = "skip " + ahead;
                    a.skip(ahead);
                    b.skip(ahead);
                }
                case 6 -> {
                    what = "available";
                    assertThat(a.available()).as(what).isEqualTo(b.available());
                }
                default -> {
                    what = "eof";
                    assertThat(a.isEOF()).as(what).isEqualTo(b.isEOF());
                }
            }
            assertThat(a.getPosition()).as("position after " + what).isEqualTo(b.getPosition());
            assertThat(a.length()).isEqualTo(b.length());
        }
        assertThatThrownBy(() -> a.seek(-1)).isInstanceOf(IOException.class);
    }

    @Test
    void closingLetsGoOfTheBytes() throws IOException {
        Input input = Input.read(new ByteArrayInputStream(random(1000, 1)), Long.MAX_VALUE);
        input.close();
        assertThat(input.isClosed()).isTrue();
        assertThatThrownBy(input::read).isInstanceOf(IOException.class);
        assertThatThrownBy(input::stream).isInstanceOf(IOException.class);
    }
}
