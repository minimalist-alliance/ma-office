package com.minimalistalliance.desk.agent.attach;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** AGENT-PARSE-1, as configuration: the reader child is started with the security manager allowed (worker/Sandbox). */
class ParsersCommandTest {

    @Test
    void theChildIsStartedWithTheManagerAllowed() {
        assertThat(Parsers.command("text", 1000, 10)).contains("-Djava.security.manager=allow");
    }
}
