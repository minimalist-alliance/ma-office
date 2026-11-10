# Spring AI against a thin client: footprint

TD-66 asked whether `desk-agent` should use Spring AI. This measures what Spring AI 2.0.2's Anthropic chat model adds
to a JVM shaped like `desk-agent`'s, against the thin client `desk-agent` would write itself: the JDK's `HttpClient`
and jackson-jr on maps, as `deskd` does. It's a measurement, not a module, and nothing builds it but this README's
commands.

**Default: thin clients, no Spring AI.** The numbers are below, and they aren't close.

## Method
- Spring Boot 4.1.2, as the services use. A context with no auto-configuration and one bean, the chat client.
- `thin`: `ThinChat`, about 40 lines. `spring-ai`: `SpringAiChat`, Spring AI's `AnthropicChatModel` built by hand on
  `AnthropicSetup.setupSyncClient`, with no auto-configuration, observation registry or retries. Spring AI 2.0's
  Anthropic module is the official `anthropic-java` SDK on OkHttp.
- Both call a loopback stand-in for the Messages API (the JDK's `HttpServer`, a fixed reply) once, then 50 more
  times. Each variant's classpath holds only its own dependencies.
- `jvm.options`' sizing (SerialGC, `-Xmx96m`, C1 only, 512k stacks), with a larger metaspace cap so Spring AI fits,
  and no app CDS archive for either. RSS from `/proc/self/status`, CPU in 10 ms ticks from `/proc/self/stat`.
- This machine: x86_64, 6 vCPUs, Temurin 21.0.13, under the build lock, load average 1.2 to 1.7. Five runs of each,
  interleaved. All runs agreed to within 1 MiB, so medians:

| | `thin` | `spring-ai` | Spring AI adds |
|---|---|---|---|
| Runtime jars, on disk | 20, 8.9 MB | 62, 68.6 MB | 42 jars, 60 MB |
| Ready, from the process start | 430 ms | 630 ms | 200 ms |
| RSS at ready | 78 MiB | 102 MiB | 24 MiB |
| First call | 47 ms | 398 ms | 350 ms |
| RSS after the first call | 84 MiB | 133 MiB | 49 MiB |
| RSS after 50 more | 85 MiB | 137 MiB | 52 MiB |
| CPU ticks to the first call's end | 73 | 147 | 2x |
| Classes loaded after the calls | 5,018 | 7,976 | 2,958 |

The Anthropic module alone. With OpenAI's and Google's as well (`-Pspring-ai-all`), the runtime is 91 jars and
153 MB on disk.

## What it brings in
`anthropic-java-core` (39 MB), Kotlin's standard library and `kotlin-reflect`, OkHttp and Okio, two Jackson databinds
(2.x and 3.x, both reflection-heavy), Reactor, Micrometer core, the OpenTelemetry API, ANTLR and StringTemplate, the
`jtokkit` tokenizer (3.2 MB), a JSON schema generator, and Swagger's annotations. `services/CLAUDE.md`'s footprint
rules say no reflection-heavy libraries and to check what a dependency pulls in.

## Beyond the bytes
- **Keys:** `AnthropicChatOptions.apiKey(String)` and `setupSyncClient(baseUrl, apiKey, ...)` keep the key as a
  `String` in the client for as long as it lives. A thin client builds the header from a `KeyLease` per call
  (README.md, Keys), so the key is a `String` only for one request.
- **xAI:** Spring AI 2.0.2 and 2.1.0-RC2 have no xAI module on Maven Central. xAI's API is OpenAI-compatible, so it
  would go through `spring-ai-openai` with another base URL, and so would a thin client: one OpenAI-compatible
  adapter covers xAI and design 9.3's "Later" row.
- **Limits:** design 9.9 reserves before each call and settles from the provider's usage. Spring AI's `ChatModel`
  would need wrapping the same way, so it saves the HTTP and JSON of each provider and none of the gateway.
- **Release cadence:** Spring AI moved Anthropic from its own `RestClient` code to the vendor SDK between 1.x and
  2.0. Pinning a vendor SDK that changes shape is the risk ADR 0018 named for AI SDK.

## Run it
From `services/`, under the build lock:
```sh
S=desk-agent/spikes/spring-ai-footprint
./mvnw -q -f $S/pom.xml -P spring-ai -DskipTests package dependency:build-classpath \
  -Dmdep.outputFile=target/cp-ai.txt -DincludeScope=runtime
./mvnw -q -f $S/pom.xml dependency:build-classpath -Dmdep.outputFile=target/cp-thin.txt -DincludeScope=runtime
java -XX:+UseSerialGC -Xms16m -Xmx96m -XX:MaxMetaspaceSize=128m -XX:ReservedCodeCacheSize=32m -Xss512k \
  -XX:TieredStopAtLevel=1 -XX:-UsePerfData -cp "$S/target/classes:$(cat $S/target/cp-thin.txt)" spike.Probe thin
# Then the same with cp-ai.txt and spring-ai, alternating.
```
