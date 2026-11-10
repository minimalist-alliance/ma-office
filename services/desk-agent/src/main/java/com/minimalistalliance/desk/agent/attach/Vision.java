package com.minimalistalliance.desk.agent.attach;

import com.minimalistalliance.desk.agent.provider.ProviderId;
import java.util.regex.Pattern;

/**
 * Which models take pictures, by provider and model id (ADR 0049). A model that isn't listed is treated as text only,
 * and the member is told so plainly, rather than the provider refusing the call.
 */
public final class Vision {

    private static final Pattern ANTHROPIC = Pattern.compile("^claude-(?!2|instant).*");
    private static final Pattern OPENAI = Pattern.compile(
            "^(?!.*(?:audio|realtime|transcribe|tts|embedding|search-preview))(?:gpt-4o|gpt-4\\.1|gpt-4\\.5|gpt-5|gpt-6"
                    + "|chatgpt-4o|o[134](?!-mini)).*");
    private static final Pattern XAI = Pattern.compile("^grok-[4-9](?:[.-].*)?$");

    private Vision() {}

    public static boolean supports(ProviderId provider, String model) {
        if (model == null) {
            return false;
        }
        String id = model.toLowerCase(java.util.Locale.ROOT);
        if (provider.equals(ProviderId.ANTHROPIC)) {
            return ANTHROPIC.matcher(id).matches();
        }
        if (provider.equals(ProviderId.OPENAI)) {
            return OPENAI.matcher(id).matches();
        }
        if (provider.equals(ProviderId.XAI)) {
            return XAI.matcher(id).matches() && !id.contains("code");
        }
        return false;
    }

    /**
     * Tokens to reserve for one picture. Anthropic scales a picture to at most 1568 px on a side and counts about
     * width x height / 750, to about 1600; OpenAI and xAI count tiles or patches, to under 2000 for a large one. The
     * reserve is a worst case: the call settles on the tokens the provider reports.
     */
    public static long reserveTokens(ProviderId provider, int width, int height) {
        if (provider.equals(ProviderId.ANTHROPIC)) {
            double scale = Math.min(1.0, 1568.0 / Math.max(width, height));
            long pixels = (long) Math.ceil(width * scale * height * scale);
            return Math.min(1_700, pixels / 750 + 50);
        }
        return 2_000;
    }
}
