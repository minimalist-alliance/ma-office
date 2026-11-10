package spike;

import com.sun.net.httpserver.HttpServer;
import java.lang.management.ManagementFactory;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;

/**
 * Boots a Spring context shaped like desk-agent's (no auto-configuration, one bean that is the chat client), points
 * it at a loopback stand-in for Anthropic's Messages API, and makes calls. Prints RSS, CPU ticks and loaded classes
 * at ready, after the first call and after 50 more. Args: {@code thin} or {@code spring-ai}.
 */
@SpringBootConfiguration(proxyBeanMethods = false)
public class Probe {

    /** One chat call: the prompt in, the reply's text out. */
    public interface Chat {
        String ask(String prompt) throws Exception;
    }

    static final String REPLY = """
            {"id":"msg_1","type":"message","role":"assistant","model":"fake-model",\
            "content":[{"type":"text","text":"Hello from the stand-in."}],"stop_reason":"end_turn",\
            "stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5}}""";

    static volatile String baseUrl;
    static volatile String variant;

    @Bean
    Chat chat() throws Exception {
        String className = variant.equals("thin") ? "spike.ThinChat" : "spike.SpringAiChat";
        return (Chat) Class.forName(className).getConstructor(String.class).newInstance(baseUrl);
    }

    public static void main(String[] args) throws Exception {
        variant = args[0];
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 16);
        server.createContext("/v1/messages", exchange -> {
            exchange.getRequestBody().readAllBytes();
            byte[] body = REPLY.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
        StringBuilder line = new StringBuilder("probe variant=" + variant);
        SpringApplication application = new SpringApplication(Probe.class);
        application.setMainApplicationClass(Probe.class);
        try (ConfigurableApplicationContext context = application.run("--spring.main.web-application-type=none",
                "--spring.main.banner-mode=off", "--spring.main.log-startup-info=false")) {
            line.append(" readyMs=").append(sinceStart()).append(sample("ready"));
            Chat chat = context.getBean(Chat.class);
            long started = System.nanoTime();
            check(chat.ask("Hello?"));
            line.append(" firstCallMs=").append((System.nanoTime() - started) / 1_000_000).append(sample("first"));
            for (int i = 0; i < 50; i++) {
                check(chat.ask("Hello again?"));
            }
            line.append(sample("after50"));
        }
        server.stop(0);
        System.out.println(line);
        System.exit(0);
    }

    private static void check(String text) {
        if (!"Hello from the stand-in.".equals(text)) {
            throw new IllegalStateException("unexpected reply");
        }
    }

    private static long sinceStart() throws Exception {
        String stat = Files.readString(Path.of("/proc/self/stat"));
        long start = Long.parseLong(stat.substring(stat.lastIndexOf(')') + 2).split(" ")[19]);
        double uptime = Double.parseDouble(Files.readString(Path.of("/proc/uptime")).split(" ")[0]);
        return Math.round(uptime * 1000) - start * 10;
    }

    private static String sample(String label) throws Exception {
        long rss = 0;
        for (String status : Files.readAllLines(Path.of("/proc/self/status"))) {
            if (status.startsWith("VmRSS:")) {
                rss = Long.parseLong(status.replaceAll("[^0-9]", ""));
            }
        }
        String stat = Files.readString(Path.of("/proc/self/stat"));
        String[] fields = stat.substring(stat.lastIndexOf(')') + 2).split(" ");
        long ticks = Long.parseLong(fields[11]) + Long.parseLong(fields[12]);
        int classes = ManagementFactory.getClassLoadingMXBean().getLoadedClassCount();
        return " " + label + "RssMiB=" + rss / 1024 + " " + label + "Ticks=" + ticks + " " + label + "Classes=" + classes;
    }

}
