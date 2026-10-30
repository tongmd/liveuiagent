# API-backed domestic harnesses

The unified selector includes Qwen Code, Kimi Code and ZCode when their model family is present in `LIVEUIAGENT_MODEL_CHOICES`. Native LiveUIAgent, Codex and DSH retain their existing entries. All application actions and state remain host-owned.

## Install official runtimes

Use an isolated runtime directory. The versions verified for this integration are Qwen Code 0.26.4, Kimi Code 2.4.0 and ZCode CLI 0.17.0. Node.js must satisfy each vendor's supported version; the production verification used Node.js 22.22.2.

```sh
npm install --prefix /opt/liveui-harnesses --ignore-scripts --no-audit --no-fund @qwen-code/qwen-code@0.26.4 @moonshot-ai/kimi-code@2.4.0
```

ZCode's CLI is built from its official repository with the CLI workspace build. Copy its `apps/zcode-cli/packages/cli/dist` directory (including provider configuration assets and notices) into the runtime directory. Source maps are optional. Headless operation does not require the desktop application. The tested ZCode commit is `3c5b227649371507ddc4eb46ac5133afe6db1cab`; keep it pinned when upgrading.

```dotenv
LIVEUI_QWEN_COMMAND=/usr/bin/node
LIVEUI_QWEN_ARGS=["/opt/liveui-harnesses/node_modules/@qwen-code/qwen-code/cli-entry.js"]
LIVEUI_KIMI_COMMAND=/usr/bin/node
LIVEUI_KIMI_ARGS=["/opt/liveui-harnesses/node_modules/@moonshot-ai/kimi-code/dist/main.mjs"]
LIVEUI_ZCODE_COMMAND=/usr/bin/node
LIVEUI_ZCODE_ARGS=["/opt/liveui-harnesses/zcode/zcode.cjs"]
LIVEUI_DOMESTIC_MAX_CONCURRENT=2
LIVEUI_DOMESTIC_TIMEOUT_MS=180000
```

Provider credentials continue to use `OPENAI_API_*` and `LIVEUIAGENT_MODEL_ROUTES`; do not log them or pass them as CLI arguments. These adapters deliberately use fresh private runtime directories and do not import an operator's login, hooks or MCP configuration.

## Verify before enabling

```sh
LIVEUI_TEST_QWEN_CLI=/opt/liveui-harnesses/node_modules/@qwen-code/qwen-code/cli-entry.js \
LIVEUI_TEST_KIMI_CLI=/opt/liveui-harnesses/node_modules/@moonshot-ai/kimi-code/dist/main.mjs \
LIVEUI_TEST_ZCODE_CLI=/opt/liveui-harnesses/zcode/zcode.cjs \
node --import tsx --test tests/domestic-harness.test.ts
```

This starts the real CLIs against a local test provider and verifies exact model selection, ordered conversation, Unicode output, single-call dispatch and temporary-file cleanup. No paid model request is made. Separately test the configured real API, create and revise an application, reopen it and inspect the durable interaction outcome.

A missing runtime, invalid result, provider error or timeout produces an explicit failure. There is no fallback to another vendor or direct inference. CLI upgrades that expose new tools fail at the host relay until reviewed.

## Official upstreams

- https://github.com/QwenLM/qwen-code
- https://github.com/MoonshotAI/kimi-code
- https://github.com/zai-org/ZCode
