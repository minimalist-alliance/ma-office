package com.minimalistalliance.desk.agent.limits;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.Usage;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Prices per model: one immutable table, the Platform's as deskd hands it on, or the bundled {@code pricing.json} until
 * one comes ({@link PriceTable}, ADR 0043). Amounts are whole micro-dollars (µ$), so sums are exact, and every rounding
 * goes up, so an estimate is never low by a fraction.
 *
 * <p>The format is {@code {"version": 1, "checked": "2026-11-06", "models": {"<provider>/<model>": {"input": "3.00",
 * "output": "15.00", "cachedInput": "0.30", "cacheWrite": "3.75"}}}}, in US dollars per million tokens, as decimal
 * strings, with {@code checked} the date the prices were read from the providers. A missing
 * {@code cachedInput} or {@code cacheWrite} is charged at {@code input}. A model priced by prompt length adds
 * {@code "above": {"inputTokens": 100000, "input": ..., "output": ...}}: a call whose prompt (input, cached and
 * written) is over that many tokens pays those prices for all of its tokens, as Anthropic and xAI bill it.
 *
 * <p>A model at {@code input} 0 and {@code output} 0, in either tier, has no price, as if it weren't listed: a table never
 * makes a model free. A table with nothing else lists nothing, and {@link PriceTable} won't take it.
 *
 * <p>A model id with a date after it, such as {@code claude-haiku-4-5-20251001} or {@code gpt-5-mini-2025-08-07},
 * takes its undated entry's price. Nothing else is matched loosely: {@code gpt-5-codex} isn't {@code gpt-5}.
 *
 * <p>The design wants the file signed per release; this one isn't yet (STATUS.md).
 */
public final class Pricing {

    /**
     * µ$ per million tokens. {@code above} is the price for a prompt over {@code aboveInputTokens}, or null when the
     * price doesn't depend on length.
     */
    public record Price(
            long input, long cachedInput, long cacheWrite, long output, long aboveInputTokens, Price above) {

        public Price(long input, long cachedInput, long cacheWrite, long output) {
            this(input, cachedInput, cacheWrite, output, 0, null);
        }

        public Price {
            if (input < 0 || cachedInput < 0 || cacheWrite < 0 || output < 0 || aboveInputTokens < 0) {
                throw new IllegalArgumentException("negative price");
            }
            if (above != null && above.above() != null) {
                throw new IllegalArgumentException("one length tier only");
            }
        }

        /** The price a prompt of this many tokens pays. */
        public Price forPrompt(long promptTokens) {
            return above != null && promptTokens > aboveInputTokens ? above : this;
        }
    }

    private static final long MILLION = 1_000_000;
    private static final Pattern DATE_SUFFIX = Pattern.compile("-(\\d{8}|\\d{4}-\\d{2}-\\d{2})$");
    /** $100,000 a million tokens: far above any real price, and low enough that a sum of tokens can't overflow. */
    private static final long MAX_PRICE = 100_000 * MILLION;
    private static final int MAX_PRICE_CHARS = 32;
    /** Dearest by output, and then by the rest, so a tie always comes out the same. */
    private static final Comparator<Price> BY_OUTPUT = Comparator.comparingLong(Price::output)
            .thenComparingLong(Price::input)
            .thenComparingLong(Price::cacheWrite)
            .thenComparingLong(Price::cachedInput);

    private final Map<String, Price> models;
    private final String checked;
    private final Map<String, Price> dearestByProvider;
    private final Price dearest;

    private Pricing(Map<String, Price> models, String checked) {
        Map<String, Price> priced = new HashMap<>();
        models.forEach((model, price) -> {
            if (hasPrice(price)) {
                priced.put(model, price);
            }
        });
        this.models = Map.copyOf(priced);
        this.checked = checked;
        Map<String, Price> byProvider = new HashMap<>();
        Price highest = null;
        for (Map.Entry<String, Price> model : this.models.entrySet()) {
            highest = dearer(highest, model.getValue());
            int slash = model.getKey().indexOf('/');
            if (slash > 0) {
                byProvider.merge(model.getKey().substring(0, slash), model.getValue(), Pricing::dearer);
            }
        }
        dearestByProvider = Map.copyOf(byProvider);
        dearest = highest;
    }

    /**
     * 0 in and 0 out, in either tier, is no price: a table that said so would make the model free, and switch a dollar
     * limit off for it. Such a model is unlisted, so it counts at {@link #chargedPrice}'s highest, as one the table doesn't
     * know does.
     */
    private static boolean hasPrice(Price price) {
        boolean base = price.input() != 0 || price.output() != 0;
        Price above = price.above();
        return base && (above == null || above.input() != 0 || above.output() != 0);
    }

    private static Price dearer(Price a, Price b) {
        return a == null || BY_OUTPUT.compare(b, a) > 0 ? b : a;
    }

    public static Pricing of(Map<String, Price> models) {
        return new Pricing(models, null);
    }

    /** The {@code pricing.json} on the classpath. */
    public static Pricing bundled() {
        try (InputStream in = Pricing.class.getResourceAsStream("/pricing.json")) {
            if (in == null) {
                throw new IllegalStateException("no pricing.json on the classpath");
            }
            return parse(in.readAllBytes());
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** @throws IllegalArgumentException if the file isn't the format above */
    public static Pricing parse(byte[] json) {
        Map<String, Object> root;
        try {
            root = Json.parseObject(json);
        } catch (JsonFormatException e) {
            throw new IllegalArgumentException("pricing.json isn't JSON");
        }
        if (!Integer.valueOf(1).equals(root.get("version"))) {
            throw new IllegalArgumentException("pricing.json version isn't 1");
        }
        Map<String, Object> listed = Json.object(root, "models");
        if (listed == null) {
            throw new IllegalArgumentException("pricing.json has no models object");
        }
        Map<String, Price> models = new HashMap<>();
        for (Map.Entry<String, Object> model : listed.entrySet()) {
            if (!(model.getValue() instanceof Map<?, ?>)) {
                throw new IllegalArgumentException("pricing.json: a model isn't an object");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> prices = (Map<String, Object>) model.getValue();
            Price base = price(prices);
            Map<String, Object> above = Json.object(prices, "above");
            if (above != null) {
                if (!(above.get("inputTokens") instanceof Number tokens) || tokens.longValue() < 1) {
                    throw new IllegalArgumentException("pricing.json: above.inputTokens is missing");
                }
                base = new Price(base.input(), base.cachedInput(), base.cacheWrite(), base.output(),
                        tokens.longValue(), price(above));
            }
            models.put(model.getKey(), base);
        }
        return new Pricing(models, checkedDate(root));
    }

    /** {@code checked}, if it's a date. It's only ever shown, so anything else just leaves it unknown. */
    private static String checkedDate(Map<String, Object> root) {
        String value = Json.string(root, "checked");
        if (value == null) {
            return null;
        }
        try {
            return LocalDate.parse(value).toString();
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private static Price price(Map<String, Object> prices) {
        long input = microUsd(prices, "input", null);
        return new Price(
                input,
                microUsd(prices, "cachedInput", input),
                microUsd(prices, "cacheWrite", input),
                microUsd(prices, "output", null));
    }

    private static long microUsd(Map<String, Object> prices, String field, Long fallback) {
        String value = Json.string(prices, field);
        if (value == null) {
            if (fallback == null) {
                throw new IllegalArgumentException("pricing.json: " + field + " is missing");
            }
            return fallback;
        }
        if (value.length() > MAX_PRICE_CHARS) {
            throw new IllegalArgumentException("pricing.json: " + field + " is too long");
        }
        long microUsd;
        try {
            microUsd = new BigDecimal(value).movePointRight(6).longValueExact();
        } catch (ArithmeticException | NumberFormatException e) {
            throw new IllegalArgumentException("pricing.json: " + field + " isn't a price in whole micro-dollars");
        }
        if (microUsd > MAX_PRICE) {
            throw new IllegalArgumentException("pricing.json: " + field + " is past any real price");
        }
        return microUsd;
    }

    /** The date this table's prices were read from the providers, {@code yyyy-MM-dd}, or null if it doesn't say. */
    public String checked() {
        return checked;
    }

    public boolean isEmpty() {
        return models.isEmpty();
    }

    /**
     * @return the listed price, or null for a model the table doesn't list, which is how a client can say it has no
     *     listed price. A dated id falls back to its undated entry. What a call on such a model counts at is
     *     {@link #chargedPrice}
     */
    public Price price(ProviderId provider, String model) {
        Price exact = models.get(provider.id() + "/" + model);
        if (exact != null) {
            return exact;
        }
        Matcher dated = DATE_SUFFIX.matcher(model);
        return dated.find() ? models.get(provider.id() + "/" + model.substring(0, dated.start())) : null;
    }

    /**
     * The price a call counts at, for its reservation and for what's settled, so a dollar limit binds every model
     * (ADR 0043). A model with a listed price pays it. Any other, a model listed at 0 in and 0 out included, counts at
     * the provider's highest listed price by {@code output}, or if the table lists nothing for that provider, at the
     * highest in the whole table.
     *
     * @return null only for a table with no models, which the bundled file isn't and {@link PriceTable} won't take
     */
    public Price chargedPrice(ProviderId provider, String model) {
        Price listed = price(provider, model);
        if (listed != null) {
            return listed;
        }
        Price highest = dearestByProvider.get(provider.id());
        return highest != null ? highest : dearest;
    }

    /** The most a call can cost before it's made: estimated input at the input price, the output cap at output's. */
    public static long estimateMicroUsd(Price price, long inputTokens, long maxOutputTokens) {
        Price tier = price.forPrompt(inputTokens);
        return perMillion(Math.addExact(
                Math.multiplyExact(inputTokens, tier.input()), Math.multiplyExact(maxOutputTokens, tier.output())));
    }

    /** What a finished call cost, from the provider's usage, at the tier its prompt's length falls in. */
    public static long costMicroUsd(Price base, Usage usage) {
        Price price = base.forPrompt(usage.inputTokens() + usage.cachedInputTokens() + usage.cacheWriteTokens());
        long sum = Math.multiplyExact(usage.inputTokens(), price.input());
        sum = Math.addExact(sum, Math.multiplyExact(usage.cachedInputTokens(), price.cachedInput()));
        sum = Math.addExact(sum, Math.multiplyExact(usage.cacheWriteTokens(), price.cacheWrite()));
        sum = Math.addExact(sum, Math.multiplyExact(usage.outputTokens(), price.output()));
        return perMillion(sum);
    }

    private static long perMillion(long microUsdTokens) {
        return Math.ceilDiv(microUsdTokens, MILLION);
    }
}
