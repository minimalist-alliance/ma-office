package com.minimalistalliance.desk.agent.testing;

import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

/** GET /health over the admin socket, as the release's health script does with curl. */
public final class Health {

    private Health() {}

    public static String get(Path socket) throws IOException {
        return request(socket, "GET /health HTTP/1.1\r\n\r\n");
    }

    public static String request(Path socket, String raw) throws IOException {
        try (SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            channel.connect(UnixDomainSocketAddress.of(socket));
            channel.write(ByteBuffer.wrap(raw.getBytes(StandardCharsets.ISO_8859_1)));
            ByteBuffer buffer = ByteBuffer.allocate(8192);
            while (buffer.hasRemaining() && channel.read(buffer) >= 0) {
                // Until the server closes.
            }
            return new String(buffer.array(), 0, buffer.position(), StandardCharsets.ISO_8859_1);
        }
    }
}
