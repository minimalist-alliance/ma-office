package com.minimalistalliance.desk.agent.llm;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.key.KeyLease;
import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.limits.LimitPolicy;
import com.minimalistalliance.desk.agent.limits.LimitReachedException;
import com.minimalistalliance.desk.agent.limits.PriceTable;
import com.minimalistalliance.desk.agent.limits.Pricing;
import com.minimalistalliance.desk.agent.limits.UsageLedger;
import com.minimalistalliance.desk.agent.provider.ChatMessage;
import com.minimalistalliance.desk.agent.provider.ChatProvider;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ChatResult;
import com.minimalistalliance.desk.agent.provider.DeltaSink;
import com.minimalistalliance.desk.agent.provider.ProviderException;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.ProviderRegistry;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The one way to a model (design 9.9's "LLM gateway"): reserve against the limits, lend the key, call the provider,
 * settle what it reported, and write one audit row, whatever the outcome.
 *
 * <p>It fails closed: with the audit log or the ledger not open, nothing is sent. A refused call writes a
 * {@code limit.hit} row and sends nothing. What's settled is the table's price for the usage the provider reported, or
 * what the provider says it billed when it says and that's more (OpenRouter's {@code usage.cost}). Every call that
 * went out writes one {@code llm.call} row, which is also
 * the key's use (design 9.11's "key use"): its target names the key and the model, its payload hash covers the
 * model, the instructions and the thread, and its decision is {@code ok} or {@code error:<kind>}.
 */
public final class LlmGateway {

    private static final Logger log = LoggerFactory.getLogger(LlmGateway.class);
    /** The design's input estimate: UTF-8 bytes over 3, which is high for English, where a token is about 4. */
    private static final int BYTES_PER_TOKEN = 3;
    /**
     * xAI's {@code max_output_tokens} caps visible text only, so reasoning and call arguments run past it. Its calls
     * reserve this many times the cap: the cap and room for reasoning at the effort the adapter sends.
     */
    static final int XAI_RESERVE_FACTOR = 4;
    /**
     * Desk Maia's calls on Minimalist Alliance's service ({@code ma}) are the company's, never the member's money (the
     * owner, Nov 15): they reserve and settle no dollars, so no dollar limit of the member's (the desk's day and month,
     * a key's month, her agent's day, week and month, a run's) binds them or counts them, and the ledger keeps no dollar
     * figure of hers (deskd {@code API.md} §23). Her allowance is metered in credits by her service; the member's own cap on
     * her is in credits too ({@code MaiaMode}). A run's step count still binds her.
     */
    /** Desk Maia's agent id: the only agent whose calls go to Minimalist Alliance's service, and that only. */
    static final String MAIA = "maia";

    /** Who's calling and on what. */
    public record Call(String agentId, String runId, String keyId, ProviderId provider) {}

    /** A finished call, with its cost in µ$, null only with a price table that has no models. */
    public record Outcome(ChatResult result, Long costMicroUsd) {}

    private final ProviderRegistry providers;
    private final KeyRing keys;
    private final PriceTable prices;
    private final UsageLedger ledger;
    private final AuditLog audit;
    /** Told what each call on MA's credits drew, by agent, in hundredths of a credit (never money). */
    private volatile java.util.function.BiConsumer<String, Long> creditsSpent = (agent, centi) -> {};

    /** With a table that never changes. */
    public LlmGateway(ProviderRegistry providers, KeyRing keys, Pricing pricing, UsageLedger ledger, AuditLog audit) {
        this(providers, keys, new PriceTable(pricing), ledger, audit);
    }

    public LlmGateway(ProviderRegistry providers, KeyRing keys, PriceTable prices, UsageLedger ledger, AuditLog audit) {
        this.providers = providers;
        this.keys = keys;
        this.prices = prices;
        this.ledger = ledger;
        this.audit = audit;
    }

    /**
     * A call that passed every check and holds its reservation: the point after which a client's message is in the
     * thread. {@link #complete} makes it, exactly once.
     */
    public static final class Reserved {
        private final Call call;
        private final ChatRequest request;
        private final ChatProvider provider;
        private final Pricing.Price price;
        private final UsageLedger.Estimate estimate;
        private final UsageLedger.Reservation reservation;
        private final String actor;
        private final String target;
        private boolean completed;
        private volatile long keptMicroUsd;

        private Reserved(Call call, ChatRequest request, ChatProvider provider, Pricing.Price price,
                UsageLedger.Estimate estimate, UsageLedger.Reservation reservation, String actor, String target) {
            this.call = call;
            this.request = request;
            this.provider = provider;
            this.price = price;
            this.estimate = estimate;
            this.reservation = reservation;
            this.actor = actor;
            this.target = target;
        }

        public Call call() {
            return call;
        }

        /**
         * What a failed call left spent: its reservation's estimate, when the provider may have billed it, else 0.
         * Known once {@link #complete} has thrown.
         */
        public long keptMicroUsd() {
            return keptMicroUsd;
        }
    }

    /**
     * Told what each call on MA's credits drew (Desk Maia's, and any agent's on the member's credits), by agent id, in
     * hundredths of a credit: the team view's usage per source. Never money.
     */
    public void creditsSpent(java.util.function.BiConsumer<String, Long> sink) {
        this.creditsSpent = sink == null ? (agent, centi) -> {} : sink;
    }

    /** {@link #reserve} then {@link #complete}, on the caller's thread. */
    public Outcome call(Call call, ChatRequest request, LimitPolicy policy, DeltaSink sink)
            throws GatewayException, LimitReachedException, ProviderException, SQLException {
        return complete(reserve(call, request, policy), sink);
    }

    /**
     * Every check before a call, then its reservation against the limits. Nothing is sent. A limit's refusal writes
     * a {@code limit.hit} row.
     *
     * @throws GatewayException if desk-agent can't record the call, or has no adapter or key for it
     * @throws LimitReachedException if the call's worst case would pass a limit
     */
    public Reserved reserve(Call call, ChatRequest request, LimitPolicy policy)
            throws GatewayException, LimitReachedException, SQLException {
        if (!audit.isOpen() || !ledger.isOpen()) {
            throw new GatewayException(GatewayException.Reason.NOT_READY);
        }
        ProviderId keyProvider = keys.providerOf(call.keyId());
        if (keyProvider == null) {
            throw new GatewayException(GatewayException.Reason.NO_KEY);
        }
        ChatProvider provider = providers.get(call.provider());
        if (provider == null) {
            throw new GatewayException(GatewayException.Reason.NO_PROVIDER);
        }
        if (!keyProvider.equals(call.provider())) {
            throw new GatewayException(GatewayException.Reason.KEY_PROVIDER_MISMATCH);
        }
        // Minimalist Alliance's service is Desk Maia's alone, and she uses nothing else (the owner, Nov 14): any other
        // pairing is a binding that should never exist, refused here too, before anything is reserved.
        boolean company = ProviderId.MA.equals(call.provider());
        if (company != MAIA.equals(call.agentId())) {
            throw new GatewayException(GatewayException.Reason.KEY_PROVIDER_MISMATCH);
        }
        // The member's MA credits (ma-platform desk-helpers.md): any of the member's own agents, on the credits "key" only,
        // and never Desk Maia (the line above already keeps her on her own service alone).
        boolean credits = ProviderId.MA_CREDITS.equals(call.provider());
        if (credits != KeyRing.CREDITS.equals(call.keyId())) {
            throw new GatewayException(GatewayException.Reason.KEY_PROVIDER_MISMATCH);
        }

        String actor = "agent:" + call.agentId();
        String target = "key:" + call.keyId() + " model:" + call.provider().id() + "/" + request.model();
        // Taken once, here: what's settled later is at this price, whatever table is in use by then (ADR 0043). Her
        // service's calls have none: they reserve and settle no dollars (the company's, never the member's money). A helper on
        // the member's MA credits reserves none either: the Platform meters it in credits on the member's balance (the owner,
        // Nov 15: credits, never dollars, for MA's provider), so only the desk's token limits bind it here.
        Pricing.Price price = company || credits ? null : prices.current().chargedPrice(call.provider(), request.model());
        long inputTokens = Math.ceilDiv(request.inputBytes(), BYTES_PER_TOKEN) + request.extraInputTokens();
        long outputTokens = call.provider() == ProviderId.XAI
                ? (long) request.maxOutputTokens() * XAI_RESERVE_FACTOR : request.maxOutputTokens();
        UsageLedger.Estimate estimate = new UsageLedger.Estimate(
                inputTokens + outputTokens,
                price == null ? null : Pricing.estimateMicroUsd(price, inputTokens, outputTokens));
        UsageLedger.Call entry = new UsageLedger.Call(
                call.agentId(), call.runId(), call.keyId(), call.provider(), request.model());
        try {
            UsageLedger.Reservation reservation = ledger.reserve(entry, estimate, policy);
            return new Reserved(call, request, provider, price, estimate, reservation, actor, target);
        } catch (LimitReachedException e) {
            audit.append(AuditLog.Entry.of(actor, "limit.hit", "scope:" + e.scope().wireName() + " " + target,
                    "refused:" + e.unit()));
            throw e;
        }
    }

    /**
     * Makes the reserved call: lends the key, streams into {@code sink}, settles what the provider reported and
     * writes one {@code llm.call} row, whatever the outcome. An interrupt of this thread stops the call.
     *
     * @throws ProviderException if the provider failed or the call was stopped
     * @throws GatewayException if the key was dropped since the reservation; nothing was sent
     */
    public Outcome complete(Reserved reserved, DeltaSink sink)
            throws ProviderException, GatewayException, SQLException {
        if (reserved.completed) {
            throw new IllegalStateException("a reserved call is made once");
        }
        reserved.completed = true;
        UsageLedger.Reservation reservation = reserved.reservation;
        byte[] payloadHash = AuditLog.sha256(Json.bytes(payload(reserved.request)));
        ChatResult result;
        try (KeyLease key = keys.lend(reserved.call.keyId())) {
            if (key == null) {
                ledger.release(reservation);
                throw new GatewayException(GatewayException.Reason.NO_KEY);
            }
            result = reserved.provider.chat(reserved.request, key, sink);
        } catch (ProviderException e) {
            Long kept = null;
            if (e.mayHaveBilled()) {
                ledger.keep(reservation);
                kept = reserved.estimate.microUsd();
                reserved.keptMicroUsd = kept == null ? 0 : kept;
            } else {
                ledger.release(reservation);
            }
            appendQuietly(new AuditLog.Entry(reserved.actor, "llm.call", reserved.target, payloadHash,
                    "error:" + e.kind().name().toLowerCase(java.util.Locale.ROOT), kept));
            throw e;
        } catch (RuntimeException e) {
            // An adapter bug: what was sent is unknown, so it counts as spent.
            ledger.keep(reservation);
            reserved.keptMicroUsd = reserved.estimate.microUsd() == null ? 0 : reserved.estimate.microUsd();
            appendQuietly(new AuditLog.Entry(reserved.actor, "llm.call", reserved.target, payloadHash,
                    "error:internal", reserved.estimate.microUsd()));
            throw e;
        }

        Long cost = reserved.price == null ? null : Pricing.costMicroUsd(reserved.price, result.usage());
        // What the provider says it billed counts when it's more: a free model that cost something is charged it.
        Long billed = result.providerMicroUsd();
        if (ProviderId.MA.equals(reserved.call.provider()) || ProviderId.MA_CREDITS.equals(reserved.call.provider())) {
            // Her calls are the company's, and a helper's on credits are paid in credits on the Platform: no dollar figure
            // on the member's ledger, whatever the answer said.
            cost = null;
        } else if (billed != null && (cost == null || billed > cost)) {
            cost = billed;
        }
        ledger.settle(reservation, result.usage(), cost);
        appendQuietly(new AuditLog.Entry(reserved.actor, "llm.call", reserved.target, payloadHash, "ok", cost));
        Long drew = result.centiCredits();
        if (drew != null && (ProviderId.MA.equals(reserved.call.provider())
                || ProviderId.MA_CREDITS.equals(reserved.call.provider()))) {
            try {
                creditsSpent.accept(reserved.call.agentId(), drew);
            } catch (RuntimeException e) {
                log.warn("a call's credits weren't counted: {}", e.getClass().getSimpleName());
            }
        }
        return new Outcome(result, cost);
    }

    /**
     * After a call has gone out, a failed append can't undo it, so it's logged rather than thrown. The log was open
     * just before the call, so this is a full disk or a closing service.
     */
    private void appendQuietly(AuditLog.Entry entry) {
        try {
            audit.append(entry);
        } catch (SQLException | RuntimeException e) {
            log.error("audit append failed after an llm call: {}", e.getClass().getSimpleName());
        }
    }

    private static Map<String, Object> payload(ChatRequest request) {
        List<Map<String, Object>> messages = new ArrayList<>();
        for (ChatMessage message : request.messages()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("role", message.role().name().toLowerCase(java.util.Locale.ROOT));
            m.put("text", message.text());
            messages.add(m);
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("model", request.model());
        payload.put("system", request.system());
        payload.put("messages", messages);
        payload.put("maxOutputTokens", request.maxOutputTokens());
        if (!request.note().isEmpty()) {
            payload.put("note", request.note());
        }
        return payload;
    }
}
