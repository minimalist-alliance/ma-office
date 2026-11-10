package spike;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import tools.jackson.jr.ob.JSON;

/** What desk-agent would write itself: the JDK's HttpClient and jackson-jr on maps, as deskd does. */
public final class ThinChat implements Probe.Chat {

    private final HttpClient client = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    private final URI uri;

    public ThinChat(String baseUrl) {
        this.uri = URI.create(baseUrl + "/v1/messages");
    }

    @Override
    @SuppressWarnings("unchecked")
    public String ask(String prompt) throws Exception {
        byte[] body = JSON.std.asBytes(Map.of(
                "model", "fake-model",
                "max_tokens", 256,
                "messages", List.of(Map.of("role", "user", "content", prompt))));
        HttpRequest request = HttpRequest.newBuilder(uri)
                .header("x-api-key", "sk-fake-key-for-the-stand-in")
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build();
        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());
        Map<String, Object> reply = JSON.std.mapFrom(response.body());
        List<Map<String, Object>> content = (List<Map<String, Object>>) reply.get("content");
        return (String) content.get(0).get("text");
    }
}
