package com.minimalistalliance.desk.agent.limits;

/**
 * A cap in estimated micro-dollars, in tokens, or both. Null means no cap in that unit. A dollar cap binds every model:
 * one the price table doesn't list counts at the highest listed price (ADR 0043, {@link Pricing#chargedPrice}).
 */
public record Limit(Long maxMicroUsd, Long maxTokens) {

    public static final Limit NONE = new Limit(null, null);

    public Limit {
        if ((maxMicroUsd != null && maxMicroUsd < 0) || (maxTokens != null && maxTokens < 0)) {
            throw new IllegalArgumentException("negative limit");
        }
    }

    public static Limit usd(String dollars) {
        return new Limit(new java.math.BigDecimal(dollars).movePointRight(6).longValueExact(), null);
    }

    public static Limit tokens(long tokens) {
        return new Limit(null, tokens);
    }

    public boolean isNone() {
        return maxMicroUsd == null && maxTokens == null;
    }
}
