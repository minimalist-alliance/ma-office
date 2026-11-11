# 0018. Agent framework: AI SDK Core with thin custom orchestration

**Status:** Proposed, superseded 
in part by [0040](0040-desk-services-spring-boot-docker.md): the runtime is `desk-agent`, Java 21 and Spring Boot, with thin provider clients on the JDK's HTTP client, and the AI SDK is not used. Keys are sealed by [0042](0042-llm-keys-sealed-on-the-desk.md) and limits follow [0043](0043-agent-limits-local-time-and-platform-prices.md). The wish for thin custom orchestration (tool calling, streaming, approval, per-call budget hooks) stands. Pending the owner's approval of design v1
**Date:** 2026-11-04
**Amended:** 2026-11-05 by [0040](0040-desk-services-spring-boot-docker.md) (the AI SDK is replaced by thin provider clients in `desk-agent`, Java; noted 2026-11-09 from `services/desk-agent/README.md`)

## Context
- Members bring keys from Anthropic, OpenAI, Google or xAI and also want image generation. The runtime needs tool calling, streaming, human approval and per-call budget hooks, inside a small Node process on a 4 GiB desk.

## Decision
- Use Vercel's **AI SDK Core** (`ai` v7 plus `@ai-sdk/anthropic`, `openai`, `google`, `xai`; Apache-2.0) inside the Node 24 agent runtime, behind our own `ChatModel` / `ImageModel` interfaces and a capability registry.
- We write our own agent loop, run state machine, policy, persistence and LLM gateway (via `wrapLanguageModel` middleware). Telemetry off; exact versions pinned; our own message schema is persisted and mapped to SDK types at the boundary.

## Consequences
- One small dependency covers chat and image generation across all four providers, plus OpenAI-compatible endpoints later.
- We absorb AI SDK's fast release cadence (breaking majors); our own schema limits the blast radius.
- Alternatives rejected: Claude Agent SDK and OpenAI Agents SDK (vendor-centred, fail BYO-any-provider), LangGraph (heavy), LiteLLM proxy (a Python sidecar holding keys), Mastra (younger), raw provider clients (4× the adapter work).
