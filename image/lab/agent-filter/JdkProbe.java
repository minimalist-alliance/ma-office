// One request with the JDK's HTTP client, HTTP/1.1, as desk-agent's HttpTransport makes them. No key: a 401 is the success.
//   java -cp . JdkProbe https://api.anthropic.com/v1/models ...
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

public class JdkProbe {
    public static void main(String[] args) {
        HttpClient client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(8)).build();
        for (String url : args) {
            try {
                long start = System.nanoTime();
                HttpRequest request = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(10)).GET().build();
                HttpResponse<Void> response = client.send(request, HttpResponse.BodyHandlers.discarding());
                System.out.printf("%s: %d in %d ms%n", url, response.statusCode(), (System.nanoTime() - start) / 1_000_000);
            } catch (Exception e) {
                System.out.printf("%s: refused: %s%n", url, e.getClass().getSimpleName());
            }
        }
    }
}
