package com.minimalistalliance.desk.agent.provider;

/**
 * One model a key can use, as the provider's model list names it.
 *
 * @param tools whether the model takes tools. One that doesn't still chats: its adapter sends it no tools and tells it
 *     it has none (OpenRouter's free models, some of which take none)
 */
public record ModelInfo(String id, String label, boolean tools) {

    /** A model that takes tools, as every Anthropic, OpenAI and xAI model listed does. */
    public ModelInfo(String id, String label) {
        this(id, label, true);
    }
}
