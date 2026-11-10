package com.minimalistalliance.desk.agent.provider;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ChatRequestTest {

    @Test
    void inputBytesCountsTheTools() {
        List<ChatMessage> thread = List.of(ChatMessage.user("Hi"));
        ChatRequest bare = new ChatRequest("m", "", thread, 10);
        ChatRequest tooled = new ChatRequest("m", "", thread, 10, List.of(new ToolSpec("read_file", "Reads.",
                Map.of("type", "object"))));
        assertThat(tooled.inputBytes()).isGreaterThan(bare.inputBytes() + "read_file".length() + "Reads.".length());
    }
}
