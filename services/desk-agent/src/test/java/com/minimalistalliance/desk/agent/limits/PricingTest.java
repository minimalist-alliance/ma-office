package com.minimalistalliance.desk.agent.limits;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.Usage;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class PricingTest {

    private static final String FILE = """
            {"version": 1, "models": {
              "anthropic/some-model": {"input": "3.00", "output": "15.00", "cachedInput": "0.30", "cacheWrite": "3.75"},
              "openai/other": {"input": "0.075", "output": "0.30"}}}""";

    @Test
    void parsesDollarsPerMillionIntoMicroDollars() {
        Pricing pricing = Pricing.parse(FILE.getBytes(StandardCharsets.UTF_8));
        assertThat(pricing.price(ProviderId.ANTHROPIC, "some-model"))
                .isEqualTo(new Pricing.Price(3_000_000, 300_000, 3_750_000, 15_000_000));
        // Missing cache prices fall back to the input price.
        assertThat(pricing.price(ProviderId.OPENAI, "other")).isEqualTo(new Pricing.Price(75_000, 75_000, 75_000, 300_000));
        assertThat(pricing.price(ProviderId.OPENAI, "unknown")).isNull();
        assertThat(pricing.price(ProviderId.XAI, "some-model")).isNull();
    }

    @Test
    void costsRoundUpToTheMicroDollar() {
        Pricing.Price price = new Pricing.Price(3_000_000, 300_000, 3_750_000, 15_000_000);
        // 1 input token at $3/M is 3 µ$; 1 cached at $0.30/M is 0.3 µ$, rounded up to 1.
        assertThat(Pricing.costMicroUsd(price, new Usage(1, 0, 0, 0, 0))).isEqualTo(3);
        assertThat(Pricing.costMicroUsd(price, new Usage(0, 1, 0, 0, 0))).isEqualTo(1);
        // 1000 in, 2000 cached, 100 written, 500 out (200 of it reasoning, already in the output):
        // 3000 + 600 + 375 + 7500 µ$.
        assertThat(Pricing.costMicroUsd(price, new Usage(1000, 2000, 100, 500, 200))).isEqualTo(11_475);
        // 1001 cached is 300.3 µ$, rounded up.
        assertThat(Pricing.costMicroUsd(price, new Usage(0, 1001, 0, 0, 0))).isEqualTo(301);
        assertThat(Pricing.estimateMicroUsd(price, 1_000_000, 1_000_000)).isEqualTo(18_000_000);
    }

    @Test
    void theBundledFileHasThePhaseOneProviders() {
        Pricing bundled = Pricing.bundled();
        assertThat(bundled.price(ProviderId.ANTHROPIC, "claude-sonnet-5-5"))
                .isEqualTo(new Pricing.Price(2_000_000, 100_000, 2_500_000, 10_000_000));
        assertThat(bundled.price(ProviderId.OPENAI, "gpt-5.4-mini").output()).isEqualTo(4_500_000);
        assertThat(bundled.price(ProviderId.XAI, "grok-4.3").input()).isEqualTo(1_250_000);
        assertThat(bundled.price(ProviderId.ANTHROPIC, "anything")).isNull();
    }

    /** A dated id is its undated model; nothing else is matched loosely. */
    @Test
    void aDatedIdTakesItsModelsPriceAndNothingElseIsGuessed() {
        Pricing bundled = Pricing.bundled();
        assertThat(bundled.price(ProviderId.ANTHROPIC, "claude-haiku-4-5-20251001"))
                .isEqualTo(bundled.price(ProviderId.ANTHROPIC, "claude-haiku-4-5"));
        assertThat(bundled.price(ProviderId.OPENAI, "gpt-5-mini-2025-08-07"))
                .isEqualTo(bundled.price(ProviderId.OPENAI, "gpt-5-mini"));
        assertThat(bundled.price(ProviderId.OPENAI, "gpt-5-codex")).isNull();
        assertThat(bundled.price(ProviderId.OPENAI, "gpt-5-mini-turbo")).isNull();
    }

    /** Haiku 5.5 and xAI price a call by its prompt's length, every token of it. */
    @Test
    void aLongPromptPaysTheHigherTierOnEveryToken() {
        Pricing.Price haiku = Pricing.bundled().price(ProviderId.ANTHROPIC, "claude-haiku-5-5");
        // 100,000 tokens is the edge: at it, $0.10 a million in; over it, $0.50.
        assertThat(Pricing.costMicroUsd(haiku, new Usage(100_000, 0, 0, 0, 0))).isEqualTo(10_000);
        assertThat(Pricing.costMicroUsd(haiku, new Usage(100_001, 0, 0, 1000, 0))).isEqualTo(50_001 + 2_500);
        // Cache reads count towards the length.
        assertThat(Pricing.costMicroUsd(haiku, new Usage(1, 100_000, 0, 0, 0))).isEqualTo(1 + 5_000);
        assertThat(Pricing.estimateMicroUsd(haiku, 200_000, 0)).isEqualTo(100_000);
        Pricing.Price grok = Pricing.bundled().price(ProviderId.XAI, "grok-4.7");
        assertThat(Pricing.costMicroUsd(grok, new Usage(200_000, 0, 0, 0, 0))).isEqualTo(800_000);
        assertThat(Pricing.costMicroUsd(grok, new Usage(199_999, 0, 0, 0, 0))).isEqualTo(399_998);
    }

    private static final String TABLE = """
            {"version": 1, "checked": "2027-01-02", "models": {
              "anthropic/cheap": {"input": "1", "output": "5"},
              "anthropic/dear-to-read": {"input": "90", "output": "6"},
              "anthropic/dear": {"input": "3", "output": "75"},
              "anthropic/priced": {"input": "2", "output": "10"},
              "openai/gpt": {"input": "4", "output": "20", "above": {"inputTokens": 1000, "input": "8", "output": "40"}},
              "xai/grok": {"input": "1", "output": "100"}}}""";

    private static Pricing table() {
        return Pricing.parse(TABLE.getBytes(StandardCharsets.UTF_8));
    }

    /** ADR 0043's order, first: a model with a price pays it, and a dated id is the model it dates. */
    @Test
    void aListedModelAndADatedIdPayTheirOwnPrice() {
        Pricing pricing = table();
        Pricing.Price priced = new Pricing.Price(2_000_000, 2_000_000, 2_000_000, 10_000_000);
        assertThat(pricing.chargedPrice(ProviderId.ANTHROPIC, "priced")).isEqualTo(priced);
        assertThat(pricing.chargedPrice(ProviderId.ANTHROPIC, "priced-20251001")).isEqualTo(priced);
        assertThat(pricing.chargedPrice(ProviderId.ANTHROPIC, "priced-2025-10-01")).isEqualTo(priced);
    }

    /** Then an unlisted model on a provider the table knows: that provider's highest, by output and not by input. */
    @Test
    void anUnlistedModelCountsAtItsProvidersHighestOutput() {
        Pricing pricing = table();
        assertThat(pricing.chargedPrice(ProviderId.ANTHROPIC, "newer-than-the-table").output()).isEqualTo(75_000_000);
        assertThat(pricing.chargedPrice(ProviderId.ANTHROPIC, "newer-than-the-table").input()).isEqualTo(3_000_000);
        // Its long-prompt tier comes with it.
        Pricing.Price openai = pricing.chargedPrice(ProviderId.OPENAI, "gpt-next");
        assertThat(openai.forPrompt(1001).output()).isEqualTo(40_000_000);
        // A dated id of an unlisted model is unlisted too.
        assertThat(pricing.chargedPrice(ProviderId.OPENAI, "gpt-next-20270101")).isEqualTo(openai);
        // What a client sees stays null, so it can say there's no listed price.
        assertThat(pricing.price(ProviderId.ANTHROPIC, "newer-than-the-table")).isNull();
    }

    /** Then a provider the table lists nothing for: the highest in the whole table. */
    @Test
    void anUnknownProviderCountsAtTheWholeTablesHighest() {
        Pricing pricing = table();
        ProviderId unknown = new ProviderId("google", "Google");
        assertThat(pricing.chargedPrice(unknown, "gemini").output()).isEqualTo(100_000_000);
        assertThat(pricing.price(unknown, "gemini")).isNull();
    }

    /** 0 in and 0 out isn't a free model but one with no price, so a dollar limit still binds it (ADR 0043). */
    @Test
    void aModelPricedAtNothingCountsAsUnlisted() {
        String file = """
                {"version": 1, "models": {
                  "openai/free": {"input": "0", "output": "0.00", "cachedInput": "0"},
                  "openai/paid": {"input": "1", "output": "10"},
                  "openai/half-free": {"input": "0", "output": "2"},
                  "openai/free-when-long": {"input": "1", "output": "3", "above": {"inputTokens": 1000, "input": "0", "output": "0"}},
                  "xai/free": {"input": "0", "output": "0"},
                  "anthropic/dear": {"input": "5", "output": "50"}}}""";
        Pricing pricing = Pricing.parse(file.getBytes(StandardCharsets.UTF_8));
        Pricing.Price paid = new Pricing.Price(1_000_000, 1_000_000, 1_000_000, 10_000_000);

        assertThat(pricing.price(ProviderId.OPENAI, "free")).isNull();
        assertThat(pricing.chargedPrice(ProviderId.OPENAI, "free")).isEqualTo(paid);
        assertThat(pricing.chargedPrice(ProviderId.OPENAI, "free-20270101")).isEqualTo(paid);
        assertThat(Pricing.costMicroUsd(pricing.chargedPrice(ProviderId.OPENAI, "free"), new Usage(1000, 0, 0, 1000, 0)))
                .isEqualTo(11_000);
        // One of the two at 0 is still a price.
        assertThat(pricing.price(ProviderId.OPENAI, "half-free").output()).isEqualTo(2_000_000);
        // A long prompt's tier at 0 would make the long calls free, so that model has no price either.
        assertThat(pricing.price(ProviderId.OPENAI, "free-when-long")).isNull();
        // A provider with nothing priced counts at the whole table's highest.
        assertThat(pricing.chargedPrice(ProviderId.XAI, "free").output()).isEqualTo(50_000_000);
        assertThat(Pricing.of(java.util.Map.of("a/b", new Pricing.Price(0, 0, 0, 0))).isEmpty()).isTrue();
    }

    @Test
    void aTieComesOutTheSameEveryTime() {
        Pricing.Price a = new Pricing.Price(1, 1, 1, 5);
        Pricing.Price b = new Pricing.Price(2, 2, 2, 5);
        for (int i = 0; i < 20; i++) {
            Pricing pricing = Pricing.of(java.util.Map.of("acme/a" + i, a, "acme/b" + i, b));
            assertThat(pricing.chargedPrice(new ProviderId("acme", "Acme"), "other")).isEqualTo(b);
        }
    }

    @Test
    void withNoModelsThereIsNoPriceToCharge() {
        assertThat(Pricing.of(java.util.Map.of()).chargedPrice(ProviderId.ANTHROPIC, "any")).isNull();
        assertThat(Pricing.of(java.util.Map.of()).isEmpty()).isTrue();
    }

    @Test
    void theBundledFilesHighestBindsAnUnlistedModel() {
        Pricing bundled = Pricing.bundled();
        assertThat(bundled.checked()).isEqualTo("2026-11-06");
        assertThat(bundled.chargedPrice(ProviderId.ANTHROPIC, "claude-next").output())
                .isGreaterThanOrEqualTo(bundled.price(ProviderId.ANTHROPIC, "claude-opus-5-5").output());
    }

    @Test
    void theDateIsKeptOnlyIfItIsADate() {
        assertThat(table().checked()).isEqualTo("2027-01-02");
        String body = "\"models\": {\"a/b\": {\"input\": \"1\", \"output\": \"1\"}}";
        assertThat(Pricing.parse(("{\"version\": 1, " + body + "}").getBytes(StandardCharsets.UTF_8)).checked()).isNull();
        assertThat(Pricing.parse(("{\"version\": 1, \"checked\": \"tomorrow\", " + body + "}").getBytes(StandardCharsets.UTF_8)).checked())
                .isNull();
    }

    /** A sum of tokens at a price past this could overflow, and a price table must never stop an agent. */
    @Test
    void aPricePastAnyRealOneIsRefused() {
        for (String price : new String[] {"100000.000001", "9000000000000", "1" + "0".repeat(40)}) {
            String file = "{\"version\": 1, \"models\": {\"a/b\": {\"input\": \"" + price + "\", \"output\": \"1\"}}}";
            assertThatThrownBy(() -> Pricing.parse(file.getBytes(StandardCharsets.UTF_8)))
                    .as(price)
                    .isInstanceOf(IllegalArgumentException.class);
        }
        String most = "{\"version\": 1, \"models\": {\"a/b\": {\"input\": \"100000\", \"output\": \"1\"}}}";
        assertThat(Pricing.parse(most.getBytes(StandardCharsets.UTF_8)).isEmpty()).isFalse();
    }

    @Test
    void refusesWhatIsntAPriceList() {
        for (String bad : new String[] {
            "[]", "{\"version\": 2, \"models\": {}}", "{\"version\": 1}",
            "{\"version\": 1, \"models\": {\"a/b\": {\"input\": \"1\"}}}",
            "{\"version\": 1, \"models\": {\"a/b\": {\"input\": \"0.0000001\", \"output\": \"1\"}}}",
            "{\"version\": 1, \"models\": {\"a/b\": {\"input\": \"-1\", \"output\": \"1\"}}}",
        }) {
            assertThatThrownBy(() -> Pricing.parse(bad.getBytes(StandardCharsets.UTF_8)))
                    .as(bad)
                    .isInstanceOf(IllegalArgumentException.class);
        }
    }
}
