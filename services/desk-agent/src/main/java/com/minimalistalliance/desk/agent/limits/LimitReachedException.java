package com.minimalistalliance.desk.agent.limits;

/**
 * A call refused before it was made, because its worst case would pass a limit. Nothing was sent and nothing was
 * spent. {@code unit} is {@code usd}, {@code tokens} or {@code steps}; the amounts are in that unit, dollars as µ$.
 */
public final class LimitReachedException extends Exception {

    private static final long serialVersionUID = 1L;

    private final Scope scope;
    private final String unit;
    private final long limit;
    private final long spent;
    private final long needed;

    public LimitReachedException(Scope scope, String unit, long limit, long spent, long needed) {
        super(scope.wireName() + " " + unit + " limit", null, false, false);
        this.scope = scope;
        this.unit = unit;
        this.limit = limit;
        this.spent = spent;
        this.needed = needed;
    }

    public Scope scope() {
        return scope;
    }

    public String unit() {
        return unit;
    }

    public long limit() {
        return limit;
    }

    public long spent() {
        return spent;
    }

    public long needed() {
        return needed;
    }
}
