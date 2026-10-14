# Cost display verification

Six Claude recordings and four Codex recordings were opened on sandbox-av on 2026-10-14. The original service used port 7790. Branch verification uses port 7791 and copies of the exact recordings captured at inspection time, so later live appends cannot change the comparison. The copies retain the original session IDs, timestamps and usage records. Only summary and token areas are included in screenshots.

All costs below are USD API-price estimates, not subscription charges.

## Bugs found

- Claude content fragments repeat an API message’s complete usage. Summing each fragment duplicated input, output and cache tokens. Usage is now counted once per `(requestId, message.id)` while every content fragment and tool call remains visible.
- The rate lookup applied historical Opus rates to Opus 5.5, and Sonnet rates to Codex. The three models in the inspected recordings now use their published rates.
- Cache creation was billed at the ordinary input rate. Recorded five-minute and one-hour cache writes now keep their own prices. All inspected Claude cache writes were one-hour writes.
- GPT-6.1 Sol requests above 272,000 input tokens need a long-context premium before aggregation. Applying one rate to a session total loses that premium. The largest inspected Codex run has 24 such requests.

## Raw accounting

Claude: group assistant rows by `(requestId, message.id)` and take the maximum of each cumulative usage category. Sum the groups. `B = input_tokens`, `R = cache_read_input_tokens`, `W = cache_creation_input_tokens`, `H = usage.cache_creation.ephemeral_1h_input_tokens`, `O = output_tokens`. Total tokens are `B + R + W + O`. Opus 5.5 cost is `(4B + 0.2R + 5(W-H) + 8H + 20O) / 1,000,000`.

Codex: take the growth of `payload.info.total_token_usage` at each `token_count`, ignoring repeated totals. Cached input is already inside `input_tokens`. Output includes reasoning output, which must not be added a second time. Use `(input - cached) × input_rate + cached × cache_rate + output × output_rate` for each request. Requests above 272,000 input tokens double input/cache rates and multiply output rates by 1.5. Final total tokens are final cumulative input plus output.

Rates verified on 2026-10-14:

| Model | Input | Cache read | Cache write, 5m | Cache write, 1h | Output |
|---|---:|---:|---:|---:|---:|
| Opus 5.5 | $4 | $0.20 | $5 | $8 | $20 |
| GPT-6.1 Sol | $2 | $0.10 | $2.50 | — | $10 |
| GPT-5.6 Sol | $4 | $0.40 | $5 | — | $20 |

Prices are per million tokens. [Opus 5.5 rates](https://www.anthropic.com/claude-opus-5-5), [cache-write durations](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5), [GPT-6.1 Sol rates and long-context rule](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [GPT-5.6 Sol rates](https://developers.openai.com/api/docs/models/gpt-5.6-sol).

## Inspected recordings

The list and detail costs agreed before the change, but both used the incorrect accounting. Each “after” cost is independently calculated from the captured raw file and checked against the branch list, detail, parse stats and chapter sum.

| Recording | Before tokens / cost | Correct tokens / cost | Raw derivation | Screenshots |
|---|---:|---:|---|---|
| Claude run `b7c6daca`<br>`3fdf332f-ed42-4ae2-9abf-aa7851e4f698.jsonl` | 118,667,020 / ~$234.39 | 43,373,594 / ~$16.60 (raw $16.6003878) | 195 unique messages: B=388, R=42,586,739, W=H=637,321, O=149,146 | [Before](cost-display/b7c6daca-before.jpg) · [After](cost-display/b7c6daca-after.jpg) |
| Claude run `9bda8a6d`<br>`f6bcc797-3259-48fb-a3c9-7d37a17b5f94.jsonl` | 894,738,011 / ~$1,645.52 | 307,188,141 / ~$105.65 (raw $105.6520664) | 698 unique messages: B=1,402, R=302,353,192, W=H=4,291,260, O=542,287 | [Before](cost-display/9bda8a6d-before.jpg) · [After](cost-display/9bda8a6d-after.jpg) |
| Claude run `521d5dc8`<br>`a7940ce1-3b9e-4c55-a5fa-28a301840f6b.jsonl` | 1,874,119 / ~$4.98 | 1,001,251 / ~$0.689 (raw $0.6890574) | 20 unique messages: B=44, R=947,347, W=H=48,149, O=5,711 | [Before](cost-display/521d5dc8-before.jpg) · [After](cost-display/521d5dc8-after.jpg) |
| Claude run `ed5af1e5`<br>`98257556-30e3-41da-8498-5e0ab89ab758.jsonl` | 14,648,692 / ~$37.91 | 4,133,604 / ~$2.61 (raw $2.6088848) | 38 unique messages: B=76, R=3,954,524, W=H=146,867, O=32,137 | [Before](cost-display/ed5af1e5-before.jpg) · [After](cost-display/ed5af1e5-after.jpg) |
| Claude run `bbd8f6c9`<br>`4bdc67cd-8b38-4056-b412-858fd180d4ac.jsonl` | 22,047 / ~$0.188 | 22,047 / ~$0.094 (raw $0.0939370) | 1 unique message: B=2, R=10,585, W=H=11,449, O=11 | [Before](cost-display/bbd8f6c9-before.jpg) · [After](cost-display/bbd8f6c9-after.jpg) |
| Claude run `f71a1eab`<br>`d7f76604-320e-4ebe-9ffe-382fe114b9e4.jsonl` | 899,664,608 / ~$1,609.98 | 363,003,219 / ~$111.40 (raw $111.4017264) | 684 unique messages: B=1,374, R=358,732,812, W=H=3,810,916, O=458,117 | [Before](cost-display/f71a1eab-before.jpg) · [After](cost-display/f71a1eab-after.jpg) |
| Codex run `8226b0aa`<br>`rollout-2026-10-13T08-20-46-01a13459-8df5-7163-bd17-c1040be071b9.jsonl` | 30,271,625 / ~$11.89 | 30,271,625 / ~$5.78 (raw $5.7758562) | Final input=30,175,842, cached=29,655,552, output=95,783; 24 long requests: uncached=27,935, cached=6,757,760, output=16,049 | [Before](cost-display/8226b0aa-before.jpg) · [After](cost-display/8226b0aa-after.jpg) |
| Codex run `32915d25`<br>`rollout-2026-10-13T08-55-39-01a13479-7d1c-77d3-8e6e-8468cfa5940b.jsonl` | 1,435,281 / ~$0.824 | 1,435,281 / ~$0.417 (raw $0.4168500) | Final input=1,427,963, cached=1,322,240, output=7,318 | [Before](cost-display/32915d25-before.jpg) · [After](cost-display/32915d25-after.jpg) |
| Codex run `3f2bd3d6`<br>`rollout-2026-10-13T08-25-40-01a1345e-0a2a-7ab2-b143-8321814f3328.jsonl` | 379,039 / ~$0.277 | 379,039 / ~$0.152 (raw $0.1516204) | Final input=376,019, cached=331,904, output=3,020 | [Before](cost-display/3f2bd3d6-before.jpg) · [After](cost-display/3f2bd3d6-after.jpg) |
| Codex run `0864bf41`<br>`rollout-2026-10-13T08-29-24-01a13461-7660-7243-9592-acf588c2b783.jsonl` | 2,389,817 / ~$1.30 | 2,389,817 / ~$1.74 (raw $1.7374792) | Final input=2,374,074, cached=2,242,688, output=15,743 | [Before](cost-display/0864bf41-before.jpg) · [After](cost-display/0864bf41-after.jpg) |

## Regression proof

The six new end-to-end checks all fail against the original main branch. On the fixed branch they pass with the JavaScript indexer and the native indexer. They run a real server, discover the sanitized recordings, open their detail API, compare list/summary/parse/chapter costs, and check the rendered browser cost.

- `claude-fragments.jsonl`: the first three API messages from Claude run `521d5dc8`, preserving every fragment and exact usage. Expected 104,707 tokens, 826 output tokens and three Bash calls.
- `claude-cache.jsonl`: the complete usage from Claude run `bbd8f6c9`, with its one-hour cache breakdown. Expected $0.093937.
- `claude-cache-five-minute.jsonl`: the same real-shaped recording with only the cache-duration split changed to five minutes. Expected $0.059590.
- `gpt-6.1-sol.jsonl`: every usage record from Codex run `8226b0aa`, including repeated totals and all 24 long requests. Expected $5.7758562.
- `gpt-5.6-sol.jsonl`: every usage record from Codex run `0864bf41`. Expected $1.7374792.

Text, working directories, tool inputs and identifiers in committed fixtures are sanitized. No full private transcript is committed.

Validation:

```sh
TRACEQUEST_SKIP_LR_WATCH=1 node --test test/bin/tracequest-cost-display.test.js
COST_TEST_SIDECAR=1 TRACEQUEST_SKIP_LR_WATCH=1 node --test test/bin/tracequest-cost-display.test.js
facts check --tags cost-display
npm test
cargo test --manifest-path sidecar/Cargo.toml --bin tracequest-sidecar -- --test-threads=1
```

Existing tests, facts, fixtures and CI configuration remain unchanged. No dependency was added. Cache format advances from 11 to 12 so old duplicated totals are not reused. No session-loading, indexing-performance or styling change is included.
