package spike;

import com.anthropic.client.AnthropicClient;
import com.anthropic.models.messages.Model;
import java.time.Duration;
import java.util.Map;
import org.springframework.ai.anthropic.AnthropicChatModel;
import org.springframework.ai.anthropic.AnthropicChatOptions;
import org.springframework.ai.anthropic.AnthropicSetup;
import org.springframework.ai.chat.prompt.Prompt;

/** Spring AI 2.0's Anthropic chat model, built by hand: no auto-configuration, no observation registry. */
public final class SpringAiChat implements Probe.Chat {

    private final AnthropicChatModel model;

    public SpringAiChat(String baseUrl) {
        AnthropicClient client = AnthropicSetup.setupSyncClient(
                baseUrl, "sk-fake-key-for-the-stand-in", Duration.ofSeconds(30), 0, null, Map.of());
        model = AnthropicChatModel.builder()
                .anthropicClient(client)
                .options(AnthropicChatOptions.builder().model(Model.of("fake-model")).maxTokens(256).build())
                .build();
    }

    @Override
    public String ask(String prompt) {
        return model.call(new Prompt(prompt)).getResult().getOutput().getText();
    }
}
