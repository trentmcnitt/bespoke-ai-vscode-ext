/**
 * Prose mid-document scenarios — full-window editing conditions.
 *
 * Each scenario simulates a cursor positioned in the middle of a large
 * document, with realistic prefix (text before cursor) and suffix (text
 * after cursor). The prefix/suffix are truncated fragments — they do NOT
 * start at the document beginning or end at the document end.
 *
 * Anchor documents:
 *   1. System design doc (~8500 chars) -> design-full, multi-topic
 *   2. Technical README (~8000 chars) -> readme-full, mixed-structure
 *   3. Blog post / essay (~7500 chars) -> blog-full
 *   4. Tutorial with code (~8000 chars) -> tutorial-full
 *   5. Technical report (~8000 chars) -> boundary-prefix, boundary-suffix
 */
import { TestScenario } from '../judge';

export const proseMidDocumentScenarios: TestScenario[] = [
  // ── Anchor 2: Technical README ──────────────────────────────────────
  {
    id: 'prose-mid-doc-readme-full',
    description: 'Technical README, cursor between sections',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'README.md',
    // prefix target: ~3800 chars
    prefix: `out of the box. If you need to customize the retry behavior, pass a \`RetryPolicy\` object:

\`\`\`yaml
retry:
  max_attempts: 5
  backoff_ms: 200
  backoff_multiplier: 2.0
\`\`\`

The backoff multiplier controls exponential delay growth — a value of 2.0 means each retry waits twice as long as the previous one. Set \`max_attempts: 0\` to disable retries entirely.

> **Note:** Retry applies only to transient errors (HTTP 429, 502, 503). Permanent failures (4xx other than 429) are never retried.

## Authentication

Strato supports three authentication methods, chosen via the \`auth.method\` field in \`strato.yaml\`:

| Method | Config key | When to use |
|--------|-----------|-------------|
| API key | \`api_key\` | Server-to-server, scripts, CI/CD |
| OAuth 2.0 | \`oauth\` | User-facing apps, web dashboards |
| mTLS | \`mtls\` | Service mesh, zero-trust environments |

### API Key Auth

The simplest method. Generate a key from the dashboard (Settings > API Keys) and add it to your config or environment:

\`\`\`bash
export STRATO_API_KEY="sk_live_..."
\`\`\`

Strato reads the key from \`STRATO_API_KEY\` automatically, or you can set it explicitly:

\`\`\`yaml
auth:
  method: api_key
  api_key: sk_live_abc123
\`\`\`

Keys have scoped permissions (read, write, admin). Rotate them from the dashboard — old keys are invalidated immediately upon rotation, so coordinate with running services before rotating a key that's in active use.

### OAuth 2.0

For user-facing apps, Strato implements the authorization code flow with PKCE. Register your app in the dashboard to get a \`client_id\`, then configure:

\`\`\`yaml
auth:
  method: oauth
  client_id: app_xxxxxxxx
  redirect_uri: http://localhost:3000/callback
  scopes:
    - read:data
    - write:data
\`\`\`

The SDK handles token refresh automatically. Tokens are cached in \`~/.strato/tokens.json\` (configurable via \`auth.token_store\`). The refresh window is 5 minutes before expiry — if a request arrives during this window, the SDK refreshes proactively rather than waiting for a 401.

### mTLS

For service mesh deployments where zero-trust networking is required. Requires a client certificate and CA bundle:

\`\`\`yaml
auth:
  method: mtls
  cert_path: /etc/strato/client.pem
  key_path: /etc/strato/client-key.pem
  ca_path: /etc/strato/ca-bundle.pem
\`\`\`

Certificate rotation is handled outside Strato — the SDK reloads certs on each new connection. If you're using short-lived certs (e.g., from Vault PKI), set \`auth.cert_reload: true\` to force a reload on every request instead of per-connection.

## Querying Data

Strato's query API uses a builder pattern. Every query starts with \`strato.from(collection)\` and chains filters, projections, and ordering:

\`\`\`python
results = (
    strato.from("events")
    .where("timestamp", ">=", "2025-01-01")
    .where("severity", "in", ["error", "critical"])
    .select("id", "timestamp", "message", "source")
    .order_by("timestamp", "desc")
    .limit(100)
    .execute()
)
\`\`\`

Queries are lazy — nothing executes until \`.execute()\` or iteration. This means you can build queries incrementally and pass them around before executing.

### Filtering

The \`.where()\` method accepts three arguments: field, operator, value. Supported operators:

- Comparison: \`=\`, \`!=\`, \`>\`, \`>=\`, \`<\`, \`<=\`
- Set membership: \`in\`, \`not_in\`
- Text: \`contains\`, \`starts_with\`, \`ends_with\`, \`matches\` (regex)
- Null checks: \`is_null\`, \`is_not_null\` (value argument ignored)

Multiple \`.where()\` calls are ANDed together. For OR logic, use \`.where_any()\`:

\`\`\`python
results = (
    strato.from("users")
    .where_any(
        ("role", "=", "admin"),
        ("department", "=", "engineering"),
    )
    .execute()
)
\`\`\`

### Pagination

For large result sets, use cursor-based pagination rather than offset-based. The cursor approach is`,
    // suffix target: ~3600 chars
    suffix: `

### Aggregations

Strato supports server-side aggregations to reduce data transfer:

\`\`\`python
stats = (
    strato.from("events")
    .where("timestamp", ">=", "2025-01-01")
    .group_by("severity")
    .aggregate(
        count=strato.count(),
        avg_response=strato.avg("response_time_ms"),
        p99_response=strato.percentile("response_time_ms", 99),
    )
    .execute()
)
\`\`\`

Available aggregation functions: \`count\`, \`sum\`, \`avg\`, \`min\`, \`max\`, \`percentile\`, \`distinct_count\`, \`array_agg\`. Percentile uses the t-digest algorithm for approximate results — accurate to within 1% for most distributions.

Aggregations can be combined with \`.having()\` for post-aggregation filtering:

\`\`\`python
high_traffic = (
    strato.from("endpoints")
    .group_by("path")
    .aggregate(
        req_count=strato.count(),
        avg_latency=strato.avg("latency_ms"),
    )
    .having("req_count", ">", 10000)
    .order_by("avg_latency", "desc")
    .execute()
)
\`\`\`

### Joins

Cross-collection queries use the \`.join()\` method. Only inner and left joins are supported (outer joins are on the roadmap). Joins require at least one indexed field on each side:

\`\`\`python
enriched = (
    strato.from("orders")
    .join("customers", on=("customer_id", "id"))
    .select(
        "orders.id",
        "orders.total",
        "customers.name",
        "customers.tier",
    )
    .where("orders.status", "=", "completed")
    .execute()
)
\`\`\`

**Performance note:** Joins across collections with >1M rows each may be slow without proper indexing. Check the query plan with \`.explain()\` before running large joins in production.

## Webhooks

Strato can push events to your endpoints via webhooks. Configure them in the dashboard or via the SDK:

\`\`\`python
strato.webhooks.create(
    url="https://example.com/hooks/strato",
    events=["record.created", "record.updated"],
    secret="whsec_...",
    collection="orders",
)
\`\`\`

Webhook payloads are signed with HMAC-SHA256 using the provided secret. The signature is included in the \`X-Strato-Signature\` header. Always verify signatures server-side — the SDK includes a \`verify_webhook(payload, signature, secret)\` helper for this.

Delivery guarantees: Strato retries failed webhook deliveries up to 5 times with exponential backoff (1s, 5s, 30s, 2min, 10min). After all retries are exhausted, the webhook is marked as failed and an event is emitted to the \`webhook.delivery_failed\` channel. You can subscribe to this channel for alerting.

## Rate Limiting

API requests are rate-limited per API key. The default limits are generous for most use cases:

| Tier | Reads/min | Writes/min | Queries/min |
|------|-----------|------------|-------------|
| Free | 60 | 30 | 20 |
| Pro | 1000 | 500 | 200 |
| Enterprise | Custom | Custom | Custom |

When you hit a rate limit, the API returns HTTP 429 with a \`Retry-After\` header. The SDK handles this automatically if retry is enabled (see [Retry Policy](#retry-policy)). Batch operations count as a single request regardless of the number of records, so always prefer batching when working with multiple items.

## Transactions

Strato supports multi-operation transactions within a single collection. Transactions provide atomicity — either all operations succeed or none do:

\`\`\`python
with strato.transaction("orders") as tx:
    tx.insert({"id": "ord-123", "status": "created", "total": 59.99})
    tx.update("inv-456", {"quantity": strato.decrement(1)})
    tx.insert_event({"type": "order.placed", "order_id": "ord-123"})
\`\`\`

Cross-collection transactions are not supported — use the saga pattern (see [Patterns](#patterns)) if you need cross-collection atomicity. Transaction isolation is snapshot-based by`,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Cursor is between Pagination and Aggregations sections. The preceding text discusses cursor-based pagination and the incomplete sentence says "The cursor approach is". The completion should continue explaining the benefits of cursor-based pagination (e.g., stable under concurrent writes, more efficient than OFFSET). Keep technical README tone. Should NOT start a new section or heading.',
    },
  },

  // ── Anchor 1: System design doc ─────────────────────────────────────
  {
    id: 'prose-mid-doc-design-full',
    description: 'Design doc, cursor mid-paragraph',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'design-doc.md',
    // prefix target: ~3700 chars
    prefix: `handled by a lightweight coordinator service that does NOT participate in the data path — it only manages partition assignments and rebalancing.

### Partition Assignment

Each partition is assigned to exactly one consumer at a time. The coordinator tracks assignments in a \`partition_assignments\` table (Postgres) and uses advisory locks to prevent double-assignment during rebalancing. When a consumer joins or leaves the group:

1. The coordinator detects the membership change (via heartbeat timeout or explicit leave)
2. It computes a new assignment using the configured strategy (range, round-robin, or sticky)
3. It revokes partitions from consumers that are losing them
4. It waits for revocation acknowledgment (with a configurable timeout, default 30s)
5. It assigns the freed partitions to their new owners

The sticky strategy minimizes partition movement during rebalancing — it tries to keep existing assignments stable and only moves the minimum number of partitions needed to achieve balance. This is the default and recommended strategy.

### Consumption Model

Consumers pull messages from their assigned partitions. Each pull request specifies a batch size (max messages) and a timeout. The broker returns up to \`batch_size\` messages starting from the consumer's committed offset for that partition.

The pull-based model means consumers control their own pace. A slow consumer doesn't create backpressure on the broker or other consumers. The tradeoff is latency — there's always at least one poll interval of delay between a message being published and a consumer seeing it. For most use cases this is fine (poll intervals of 100-500ms are typical), but if you need sub-100ms end-to-end latency, consider the push-based WebSocket API instead.

**Offset management** is the consumer's responsibility. After processing a batch, the consumer commits its offset back to the broker. Two commit modes:

- **Auto-commit** — the SDK commits offsets periodically (every 5s by default). Simple but risks reprocessing after a crash because the last committed offset may be behind the actually-processed position.
- **Manual commit** — the application calls \`commit()\` explicitly after processing. Provides exactly-once semantics when combined with idempotent processing, but requires more care in the application code.

We recommend manual commit for production workloads. Auto-commit is fine for development, monitoring, and cases where occasional reprocessing is acceptable.

### Dead Letter Queue

Messages that fail processing repeatedly get routed to a dead letter queue (DLQ). The consumer SDK handles this automatically:

1. If processing throws an exception, the SDK retries up to \`max_retries\` times (default 3)
2. Between retries, it applies exponential backoff (starting at 1s, capped at 30s)
3. After exhausting retries, it publishes the message to the DLQ topic (\`{original_topic}.dlq\`)
4. The original message offset is committed so the consumer moves on

DLQ messages include metadata about the failure — original topic, partition, offset, exception type, and all retry timestamps. You can inspect and replay DLQ messages from the dashboard or via the admin API.

### Exactly-Once Semantics

True exactly-once delivery is impossible in distributed systems (see the two generals problem), but we can achieve exactly-once *processing* through idempotent consumers. The recommended pattern:

1. Use manual offset commits
2. Wrap processing + offset commit in a transaction (if your datastore supports it)
3. Store a deduplication key (message ID or topic+partition+offset) alongside your processed data
4. On replay, check the dedup key and skip already-processed messages

For consumers writing to Postgres, the SDK provides a helper that wraps steps 2-4 in a single transaction. This covers the most common case and`,
    // suffix target: ~3500 chars
    suffix: `

### Monitoring

Consumer health is tracked through several metrics exposed on the \`/metrics\` endpoint (Prometheus format):

| Metric | Type | Description |
|--------|------|-------------|
| \`consumer_messages_processed_total\` | counter | Messages successfully processed |
| \`consumer_processing_errors_total\` | counter | Processing failures (before DLQ) |
| \`consumer_lag_messages\` | gauge | Per-partition lag (latest offset minus committed offset) |
| \`consumer_poll_duration_seconds\` | histogram | Time spent in each poll cycle |
| \`consumer_commit_duration_seconds\` | histogram | Time to commit offsets |
| \`consumer_rebalance_total\` | counter | Number of rebalance events |

The most important metric is \`consumer_lag_messages\`. A growing lag indicates the consumer can't keep up with the production rate. Common responses:

- **Add more consumers** to the group (up to the number of partitions)
- **Increase batch size** so each poll processes more messages
- **Optimize processing** — profile your handler for bottlenecks
- **Repartition** the topic to allow more parallelism (requires careful coordination)

The dashboard shows a real-time lag graph per consumer group and will alert if lag exceeds a configurable threshold (default: 10,000 messages sustained for 5 minutes).

### Backfill and Replay

Sometimes you need to reprocess historical data — after a bug fix, schema change, or when bootstrapping a new consumer. Strato supports controlled replay:

\`\`\`python
# Reset consumer group to a specific timestamp
admin.reset_offsets(
    group="analytics-pipeline",
    topic="events",
    to_timestamp="2025-06-01T00:00:00Z",
)
\`\`\`

This resets the committed offsets for all partitions of the specified topic to the earliest offset at or after the given timestamp. The next poll from any consumer in the group will start from the reset point.

**Caution:** Replay causes reprocessing of potentially millions of messages. Ensure your consumers are idempotent before triggering a replay. Consider running a separate consumer group for backfill to avoid disrupting the primary pipeline.

You can also reset to specific offsets per partition for surgical replays, or reset to "earliest" / "latest" for full reprocessing or fresh-start scenarios. The admin API exposes these operations programmatically, and the dashboard has a UI for manual resets with confirmation safeguards.

### Schema Evolution

Message schemas evolve over time. Strato supports schema versioning through a lightweight registry integrated with the broker. Producers register schemas on first publish, and consumers can request a specific schema version or opt into automatic migration. The registry supports JSON Schema and Protobuf formats. Schema compatibility checks (backward, forward, or full) run at registration time — the broker rejects incompatible schema updates before they reach consumers.

For breaking changes that can't be handled by automatic migration, the recommended approach is to create a new topic version (e.g., \`events-v2\`) and run both versions in parallel during a transition period. The admin dashboard tracks consumer group progress per-topic to help coordinate these transitions.

### Performance Tuning

Default configuration is optimized for a balance of throughput and latency, but production workloads often benefit from tuning. Key parameters include \`fetch.max.bytes\` (consumer, default 1MB), \`batch.size\` (producer, default 16KB), and \`linger.ms\` (producer, set to 0 for minimum latency or 10-50ms for better throughput). Monitor the \`producer_batch_size_avg\` metric to understand whether your`,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Cursor is mid-paragraph in the "Exactly-Once Semantics" section of a message queue design doc. The prefix ends with "wraps steps 2-4 in a single transaction. This covers the most common case and". The completion should continue that sentence — e.g., discussing limitations of the helper, cases it does NOT cover, or additional setup needed. Maintain the technical design doc voice. Should NOT introduce a heading or code block.',
    },
  },

  // ── Anchor 3: Blog post / essay ─────────────────────────────────────
  {
    id: 'prose-mid-doc-blog-full',
    description: 'Blog post, cursor extending a thought',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'blog-post.md',
    // prefix target: ~3600 chars
    prefix: `unless you're working on something performance-sensitive. But at some point, when your CI pipeline takes longer than your lunch break, you start looking at build times and wondering whether there's a fundamentally better approach.

For me that point came about three months ago. Our CI was averaging 6 minutes per push — not terrible, but annoying when you're iterating on a UI change and waiting for the green check before your PR can merge. The actual tests took about 90 seconds; the remaining 4.5 minutes were split between dependency installation (cached, but still slow), linting, type checking, and the production build. The build was the big one at roughly 4 minutes by itself.

## The bundler landscape in 2026

I should caveat: I'm not a build tools expert. I'm a product engineer who has to deal with build tooling, which means my perspective is shaped by "does this let me ship features faster" rather than "is the architecture theoretically elegant." Take this with a grain of salt.

That said, here's where I think things stand. Webpack is still everywhere — it's the COBOL of JavaScript bundlers. If your company has a frontend older than about 2023, it's almost certainly webpack. It works, it has a plugin for everything, and it's slow enough that you develop a personal relationship with your build output. ("Oh look, the asset optimization pass is taking 14 seconds again. Classic.")

Vite changed expectations. When I first tried it on a side project in 2024, the dev server startup felt broken — I kept checking the terminal because it couldn't possibly be ready that fast. The HMR (hot module replacement) was near-instant even on a project with ~400 modules. Going back to webpack after that felt physically painful, like switching from an SSD back to a spinning disk.

But Vite's production builds still use Rollup under the hood, and Rollup... let's just say it's showing its age. The Rollup team knows this — Rolldown (the Rust-based replacement) has been in development for over a year and it's getting close to production-ready. Once Rolldown lands in Vite, I think the "just use Vite" advice becomes basically universal for new projects.

Then there's Turbopack, which Vercel has been building as the Next.js bundler. It's fast — genuinely fast — but it's tied to the Next.js ecosystem in practice. You *can* use it standalone, but nobody does. If you're not on Next, it's not really an option.

esbuild remains the speed champion for straightforward builds. I use it for a VS Code extension (long story) and it compiles 15k lines of TypeScript in about 80ms. The limitations are real though — no HMR, limited code splitting, the CSS handling is basic. It's a compiler, not a dev server, and trying to make it into one is fighting the tool.

The new kid is Farm. Written in Rust, Vite-compatible, claims to be faster than everything else. I've been meaning to try it on a real project but haven't gotten around to it. The benchmarks look impressive but benchmarks always look impressive — the question is whether it handles the weird edge cases that real projects inevitably have (dynamic imports inside a try/catch that conditionally loads a CSS module that references a font file that's actually a symlink to a monorepo package... you know, normal stuff).

## What I actually did

So with all of that context, here's what happened. I had a Next.js app at work — medium-sized, maybe 200 routes, a decent amount of shared state, some server components. The full build was taking about 4 minutes in CI and`,
    // suffix target: ~3700 chars
    suffix: ` I started with the obvious stuff first. Tree shaking was already enabled (Next handles that), but I found a few barrel files that were importing entire libraries when we only needed one or two functions. The classic \`import { debounce } from 'lodash'\` situation — we were shipping the entire lodash bundle because nobody had bothered to switch to \`lodash/debounce\`. Three of those fixes shaved about 15 seconds off the build.

Then I looked at the TypeScript compilation. We were using \`tsc\` for type checking in CI *and* letting Next.js do its own TS compilation for the actual build. Double work. I split them: \`tsc --noEmit\` runs as a separate CI step, and Next.js uses \`transpileOnly\` mode (via the built-in SWC compiler). That saved another 20 seconds.

The big win came from an unexpected place: our test data fixtures. We had a \`__fixtures__\` directory with about 400MB of JSON files for integration tests. These were inside the \`src/\` tree (because the tests that used them were colocated), and Next.js was dutifully parsing every single one during the build. Moving them to a top-level \`test-fixtures/\` directory outside the source tree cut build time by nearly a full minute. I felt both triumphant and embarrassed.

After all the easy wins, the build was down to about 2:20. Not bad, but the PR review feedback was "can we get it under 2 minutes?" (because of course it was). The remaining time was split roughly equally between three phases: page compilation, route manifest generation, and static asset optimization.

For the asset optimization, I swapped the default image optimizer for a Rust-based alternative (\`@next/sharp\` — technically a Node addon, but the heavy lifting is native code). That got us to 2:05.

The last 5 seconds came from parallelizing the route manifest generation, which I did by writing a custom Next.js plugin that pre-computes route metadata during the compile phase instead of in a separate serial pass. Was it worth the effort for 5 seconds? In CI minutes across the team, probably. In my sanity, definitely not. But we hit the 2-minute target, the PR was approved, and I got to write a "how we cut our build time in half" blog post (this one) which is arguably the real deliverable.

## Lessons and caveats

A few things I learned that might save you time if you're in a similar situation.

First, profile before optimizing. I know that's the oldest advice in programming, but it's especially important with build tooling because your intuition about what's slow is almost always wrong. The actual bottleneck in our case was a directory full of test fixtures that nobody thought about. You can add \`--profile\` to most bundlers to get a timing breakdown — do that before touching anything.

Second, don't fight your bundler. If you're spending more time configuring the bundler than writing application code, that's a signal to switch bundlers, not to write more configuration. Life is too short for 400-line webpack configs.

Third, the 80/20 rule applies hard here. The first three fixes (barrel file imports, separating type checking, moving test fixtures) took maybe 2 hours total and saved nearly 2 minutes. The last two fixes (image optimizer swap, route manifest parallelization) took almost a full day and saved 20 seconds. Diminishing returns are real and they arrive faster than you expect.

Fourth, measure from CI, not from your laptop. My M2 MacBook Pro builds the project in 45 seconds. CI (GitHub Actions, medium runner) takes 4x longer. Optimizations that feel negligible locally can be significant in CI, and vice versa. The fixture directory move was invisible in local builds but massive in CI.

Finally, talk to your team before optimizing. I spent half a day investigating a custom chunk splitting strategy before my colleague mentioned she'd already tried it and abandoned it. A 5-minute conversation would have saved`,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Blog post about JavaScript build tooling. Cursor is at the end of "The full build was taking about 4 minutes in CI and" — the author is about to describe the pain point or motivation for optimization. The suffix starts with optimization steps. The completion should bridge: finish describing the problem (build time impact, developer frustration) and transition into "I started optimizing." Casual first-person blog voice with technical specifics. One to two sentences max.',
    },
  },

  // ── Anchor 4: Tutorial with code ────────────────────────────────────
  {
    id: 'prose-mid-doc-tutorial-full',
    description: 'Tutorial with mixed prose/code blocks, cursor in prose',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'tutorial.md',
    // prefix target: ~3800 chars
    prefix: `that the handler receives the raw event object, so you'll need to extract the fields yourself rather than relying on automatic deserialization.

## Setting up the database

We'll use SQLite for this tutorial because it requires zero setup — no server, no configuration, no Docker container. For production you'd swap in Postgres or MySQL, and the query interface stays almost identical (Drizzle's whole point is abstracting over the dialect differences).

Install the dependencies:

\`\`\`bash
npm install drizzle-orm better-sqlite3
npm install -D drizzle-kit @types/better-sqlite3
\`\`\`

Now create a schema file. Drizzle uses TypeScript to define your tables — no separate migration language, no YAML configs. The schema IS the migration, which sounds like it would cause problems but actually works well in practice.

Create \`src/db/schema.ts\`:

\`\`\`typescript
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const products = sqliteTable('products', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description'),
  price: real('price').notNull(),
  category: text('category').notNull(),
  inStock: integer('in_stock', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql\`CURRENT_TIMESTAMP\`),
});

export const orders = sqliteTable('orders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  customerEmail: text('customer_email').notNull(),
  status: text('status', { enum: ['pending', 'shipped', 'delivered', 'cancelled'] })
    .notNull()
    .default('pending'),
  total: real('total').notNull(),
  createdAt: text('created_at').notNull().default(sql\`CURRENT_TIMESTAMP\`),
});
\`\`\`

A few things to notice here. The \`mode: 'boolean'\` on \`inStock\` is a Drizzle-ism — SQLite doesn't have a native boolean type, so it stores 0/1 and Drizzle handles the conversion. The \`references\` calls set up foreign keys, which SQLite enforces by default since version 3.6.19 (though you need to run \`PRAGMA foreign_keys = ON\` at connection time — we'll handle that shortly).

Next, set up the database connection. Create \`src/db/index.ts\`:

\`\`\`typescript
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

const sqlite = new Database('app.db');
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
\`\`\`

The WAL (Write-Ahead Logging) pragma is important — without it, SQLite uses the default rollback journal which blocks readers during writes. WAL mode allows concurrent reads and writes, which matters even in a single-process app because your HTTP handler might be reading while a background job is writing.

## Writing queries

Here's where Drizzle really shines. The query API is type-safe end to end — if you reference a column that doesn't exist, TypeScript catches it at compile time. No more runtime "column not found" errors from typos in SQL strings.

Let's start with basic CRUD. Insert a product:

\`\`\`typescript
const newProduct = await db.insert(schema.products).values({
  name: 'Mechanical Keyboard',
  description: 'Cherry MX Brown switches, TKL layout',
  price: 149.99,
  category: 'electronics',
}).returning();
\`\`\`

The \`.returning()\` method gives you the inserted row back, including auto-generated fields like \`id\` and \`createdAt\`. Without it, you just get the row count.

Now you can query orders with their items and product details in a single call:

\`\`\`typescript
const ordersWithItems = await db.query.orders.findMany({
  with: {
    items: {
      with: {
        product: true,
      },
    },
  },
  where: eq(schema.orders.status, 'pending'),
});
\`\`\`

This generates an efficient query (or multiple queries with batching, depending on the dialect) and returns fully typed nested objects. The type of \`ordersWithItems\` is`,
    // suffix target: ~3500 chars
    suffix: ` which means you get autocomplete on every nested field. No \`any\` types leaking through, no manual type assertions.

### Transactions

For operations that need atomicity, wrap them in a transaction:

\`\`\`typescript
const order = await db.transaction(async (tx) => {
  const [newOrder] = await tx.insert(schema.orders).values({
    customerEmail: 'buyer@example.com',
    status: 'pending',
    total: 0,
  }).returning();

  let total = 0;
  for (const item of cartItems) {
    const [product] = await tx
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, item.productId));

    if (!product || !product.inStock) {
      throw new Error(\`Product \${item.productId} not available\`);
    }

    await tx.insert(schema.orderItems).values({
      orderId: newOrder.id,
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: product.price,
    });

    total += product.price * item.quantity;
  }

  await tx.update(schema.orders)
    .set({ total })
    .where(eq(schema.orders.id, newOrder.id));

  return newOrder;
});
\`\`\`

If any step throws, the whole transaction rolls back. SQLite transactions are serialized (one at a time), which simplifies reasoning about consistency — no need to worry about isolation levels or phantom reads. In Postgres you'd want to think more carefully about the isolation level, but for SQLite it's just correct by default.

### Migrations

Drizzle Kit generates SQL migration files by comparing your schema definition against the current database state:

\`\`\`bash
npx drizzle-kit generate
\`\`\`

This creates a migration file in \`drizzle/\` (e.g., \`0001_add_products.sql\`). Apply it with:

\`\`\`bash
npx drizzle-kit push
\`\`\`

For production, you'd typically run migrations as part of your deploy pipeline. Drizzle Kit tracks applied migrations in a \`__drizzle_migrations\` table, so it only runs new ones. The migration files are plain SQL — you can inspect, edit, or version-control them just like any other source file.

One thing I appreciate about Drizzle's approach: the migration files are derived FROM the schema code, not the other way around. This means the schema file is always the source of truth. If you need to see what the current schema looks like, you read \`schema.ts\`, not a pile of incremental migration files. This alone saves a lot of mental overhead compared to tools like Knex or TypeORM where the migrations ARE the schema, and understanding the current state means mentally replaying every migration file in order.

## Error handling

Database errors in Drizzle surface as standard JavaScript exceptions. The most common ones you'll encounter in development are constraint violations (unique, foreign key, not-null) and type mismatches.

\`\`\`typescript
try {
  await db.insert(schema.products).values({
    name: 'Duplicate Product',
    price: 29.99,
    category: 'electronics',
  });
} catch (err) {
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    // Handle duplicate — maybe update instead of insert
  } else {
    throw err;
  }
}
\`\`\`

For SQLite specifically, error codes are available on the \`code\` property of the thrown error. The codes follow the SQLite naming convention: \`SQLITE_CONSTRAINT_UNIQUE\`, \`SQLITE_CONSTRAINT_FOREIGNKEY\`, \`SQLITE_CONSTRAINT_NOTNULL\`, etc. If you're writing code that needs to work across dialects, Drizzle provides a \`DrizzleError\` base class you can catch, but the specific constraint codes differ between SQLite, Postgres, and MySQL — there's no universal abstraction for that yet (it's on the roadmap).

One tip: always set \`PRAGMA foreign_keys = ON\` when using SQLite. Without it, constraints are defined but not enforced — you can silently insert`,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Tutorial about Drizzle ORM with SQLite. Cursor is right after "The type of `ordersWithItems` is" — the author is about to describe the inferred TypeScript type. The suffix continues with "which means you get autocomplete on every nested field." The completion should provide a plausible TypeScript type annotation or informal type description that bridges into the suffix. Keep tutorial voice. Should be brief — a few words to a short clause.',
    },
  },

  // ── Anchor 5: Technical report ──────────────────────────────────────
  {
    id: 'prose-mid-doc-boundary-prefix',
    description: 'Prefix ~2600 chars (near truncation boundary), large suffix',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'incident-report.md',
    // prefix target: ~2600 chars
    prefix: `correlated with the deploy window, which narrowed the investigation to changes in the v2.14.0 release. The on-call engineer (Jamie) started bisecting the deploy diff at 03:47 UTC.

The initial suspicion was the new rate limiter middleware, which had been added in the same release. Jamie spent about 15 minutes investigating it before ruling it out — the middleware only affected response headers and didn't touch the query path at all. She also checked the connection pool settings and the Postgres replica lag, both of which were normal.

The search service logs were the key clue: every query was executing with \`Seq Scan\` instead of the expected \`Bitmap Index Scan\`, and the planner cost estimates had jumped by three orders of magnitude. Jamie connected to the production database read replica and ran \`\\di search_index*\` — the GIN index on the \`tokens\` column was missing entirely. That pointed directly at the migration.

### Timeline (UTC)

| Time | Event |
|------|-------|
| 02:15 | v2.14.0 deployed to canary (5% traffic) |
| 02:18 | Canary metrics normal, auto-promoted to 25% |
| 02:31 | Auto-promoted to 100% after passing health checks |
| 03:12 | PagerDuty alert: p99 latency > 2s on /api/search |
| 03:15 | On-call acknowledged, began investigation |
| 03:22 | Confirmed latency spike via Grafana — 95th percentile at 3.4s (baseline: 180ms) |
| 03:28 | Checked application logs — no errors, but query logs showed full table scans on \`search_index\` |
| 03:35 | Identified v2.14.0 migration as suspect — it added a \`metadata\` JSONB column to \`search_index\` |
| 03:47 | Began bisecting deploy diff |
| 04:02 | Root cause identified — migration dropped and recreated the GIN index on \`search_index.tokens\` |
| 04:08 | Initiated rollback to v2.13.2 |
| 04:14 | Rollback complete, latency returning to normal |
| 04:22 | p99 latency back to 210ms, incident marked as mitigated |
| 04:45 | All-clear posted to #incidents Slack channel |
| 05:10 | Post-incident review meeting scheduled for 10:00 UTC |

### Root Cause

The migration in v2.14.0 (\`20250601_add_search_metadata.sql\`) added a \`metadata\` JSONB column to the \`search_index\` table. The migration script included an \`ALTER TABLE ... ADD COLUMN\` followed by a \`DROP INDEX\` and \`CREATE INDEX\` to rebuild the GIN index with the new column included.

The problem: the \`search_index\` table has 47 million rows. The \`CREATE INDEX\` ran without \`CONCURRENTLY\`, which meant it`,
    // suffix target: ~3500 chars
    suffix: `

### Impact

- **Duration:** 1 hour 7 minutes (03:15 to 04:22 UTC)
- **Users affected:** Approximately 12,000 unique users attempted searches during the incident window
- **Error rate:** No errors — searches completed, just slowly (p50 moved from 45ms to 1.2s, p99 from 180ms to 3.4s)
- **Revenue impact:** Estimated $8,200 in lost conversions based on the correlation between search latency and checkout completion rate
- **SLA impact:** Breached the 99.9% availability SLO for the search service (effective availability was 94.2% when measured against the 500ms latency threshold)

### Contributing Factors

1. **No index build time estimation.** The migration review process does not check estimated index build time for large tables. The reviewer approved the migration without realizing the GIN index rebuild would take ~18 minutes on a 47M-row table.

2. **Canary metrics insufficient.** The canary health checks measure error rate and mean latency, not tail latency. The p99 spike was invisible during the canary phase because the 5% traffic sample was too small to trigger the percentile-based alert.

3. **Migration ran inline with deploy.** The migration executed as part of the deploy pipeline rather than as a separate, pre-deploy step. This meant the slow index build blocked the deploy and left the table without a usable index during the build window.

4. **No circuit breaker on search.** The search service does not have a degraded-mode fallback. When the index was unavailable, queries fell back to sequential scans rather than returning cached or approximate results.

### Remediation

| Action | Owner | Deadline | Status |
|--------|-------|----------|--------|
| Add \`CONCURRENTLY\` requirement to migration lint rules | Platform team | 2025-06-15 | In progress |
| Separate migration step in CI/CD pipeline | Platform team | 2025-06-30 | Planned |
| Add p99 latency to canary health checks | SRE | 2025-06-10 | In progress |
| Implement search degraded-mode fallback | Search team | 2025-07-15 | Planned |
| Add index build time estimation to migration review checklist | DB team | 2025-06-20 | Not started |

### Lessons Learned

The core lesson is that our migration review process treats all tables equally regardless of size. A migration that's perfectly safe on a 10,000-row table can be catastrophic on a 47-million-row table, and our review checklist doesn't account for this. The fix is straightforward — add a size-check step to the linting pipeline, and flag any DDL (Data Definition Language) operation that targets a table with more than 1 million rows for mandatory senior review.

The broader organizational takeaway is about staging environment fidelity. Our staging database has roughly 0.1% of production's data volume, which means performance characteristics are fundamentally different. We've discussed data sampling strategies before (see RFC-0042) but never implemented them. This incident might finally provide the momentum to prioritize that work.

### Appendix: Query Plans

For reference, here are the EXPLAIN ANALYZE outputs from both the degraded and normal states.

**During incident (no GIN index):**

Sequential Scan on search_index (cost=0.00..1847293.00 rows=47182934 width=284)
  Filter: (tokens @@ to_tsquery('english', 'search term'))
  Rows Removed by Filter: 47182521
  Planning Time: 0.8ms
  Execution Time: 3412.6ms

**After rollback (GIN index restored):**

Bitmap Heap Scan on search_index (cost=412.00..28493.00`,
    saturation: { prefix: 'unsaturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Incident report with smaller prefix (~2600 chars, near context truncation boundary). The prefix ends mid-sentence in the Root Cause section: "which meant it" — should describe the consequence (e.g., held an exclusive lock on the table, blocked all reads during the index build). The suffix starts with the Impact section. Technical incident report tone. Brief continuation — one or two clauses finishing the sentence.',
    },
  },

  {
    id: 'prose-mid-doc-boundary-suffix',
    description: 'Large prefix, suffix ~2100 chars (near truncation boundary)',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'incident-report.md',
    // prefix target: ~3500 chars
    prefix: `the alerts in isolation — nobody connected the latency increase on /api/search with the deploy that had completed 40 minutes earlier. The monitoring dashboard shows deploy events as vertical markers on the latency graph, but the default time range (1 hour) meant the deploy marker had already scrolled off the left edge by the time the on-call engineer opened Grafana.

This is a recurring theme in our incidents: the time gap between deploy and symptom is long enough that the correlation isn't obvious. We've discussed adding a "recent deploys" widget to the on-call dashboard, but it keeps getting deprioritized.

### Timeline (UTC)

| Time | Event |
|------|-------|
| 02:15 | v2.14.0 deployed to canary (5% traffic) |
| 02:18 | Canary metrics normal, auto-promoted to 25% |
| 02:31 | Auto-promoted to 100% after passing health checks |
| 03:12 | PagerDuty alert: p99 latency > 2s on /api/search |
| 03:15 | On-call acknowledged, began investigation |
| 03:22 | Confirmed latency spike via Grafana — 95th percentile at 3.4s (baseline: 180ms) |
| 03:28 | Checked application logs — no errors, but query logs showed full table scans on \`search_index\` |
| 03:35 | Identified v2.14.0 migration as suspect — it added a \`metadata\` JSONB column to \`search_index\` |
| 03:47 | Began bisecting deploy diff |
| 04:02 | Root cause identified — migration dropped and recreated the GIN index on \`search_index.tokens\` |
| 04:08 | Initiated rollback to v2.13.2 |
| 04:14 | Rollback complete, latency returning to normal |
| 04:22 | p99 latency back to 210ms, incident marked as mitigated |

### Root Cause

The migration in v2.14.0 (\`20250601_add_search_metadata.sql\`) added a \`metadata\` JSONB column to the \`search_index\` table. The migration script included an \`ALTER TABLE ... ADD COLUMN\` followed by a \`DROP INDEX\` and \`CREATE INDEX\` to rebuild the GIN index with the new column included.

The problem: the \`search_index\` table has 47 million rows. The \`CREATE INDEX\` ran without \`CONCURRENTLY\`, which meant it acquired an exclusive lock on the table for the duration of the index build (~18 minutes). During that window, all search queries fell back to sequential scans, which explains the latency spike.

The migration passed review because the reviewer didn't check the table size. On the staging environment, \`search_index\` has only 50,000 rows and the index build takes <1 second, so the migration appeared harmless in pre-production testing.

### Impact

- **Duration:** 1 hour 7 minutes (03:15 to 04:22 UTC)
- **Users affected:** Approximately 12,000 unique users attempted searches during the incident window
- **Error rate:** No errors — searches completed, just slowly (p50 moved from 45ms to 1.2s, p99 from 180ms to 3.4s)
- **Revenue impact:** Estimated $8,200 in lost conversions based on the correlation between search latency and checkout completion rate
- **SLA impact:** Breached the 99.9% availability SLO for the search service (effective availability was 94.2% when measured against the 500ms latency threshold)

### Contributing Factors

1. **No index build time estimation.** The migration review process does not check estimated index build time for large tables. The reviewer approved the migration without realizing the GIN index rebuild would take ~18 minutes on a 47M-row table.

### Remediation

Going forward, we're adding a mandatory size-check step to the migration linter. Any migration that touches a table with more than 1 million rows will be flagged for additional review, and index operations on large tables will require`,
    // suffix target: ~2100 chars
    suffix: ` The broader organizational takeaway is about staging environment fidelity. Our staging database has roughly 0.1% of production's data volume, which means performance characteristics are fundamentally different. We've discussed data sampling strategies before (see RFC-0042) but never implemented them. This incident might finally provide the momentum to prioritize that work.

### Appendix: Query Plans

For reference, here are the EXPLAIN ANALYZE outputs from both the degraded and normal states.

**During incident (no GIN index):**

Sequential Scan on search_index (cost=0.00..1847293.00 rows=47182934 width=284)
  Filter: (tokens @@ to_tsquery('english', 'search term'))
  Rows Removed by Filter: 47182521
  Planning Time: 0.8ms
  Execution Time: 3412.6ms

**After rollback (GIN index restored):**

Bitmap Heap Scan on search_index (cost=412.00..28493.00 rows=413 width=284)
  Recheck Cond: (tokens @@ to_tsquery('english', 'search term'))
  Heap Blocks: exact=398
  -> Bitmap Index Scan on search_index_tokens_gin (cost=0.00..411.89 rows=413 width=0)
     Index Cond: (tokens @@ to_tsquery('english', 'search term'))
  Planning Time: 1.2ms
  Execution Time: 4.7ms

The difference is dramatic: 3412ms vs 4.7ms, a 726x improvement. The sequential scan reads every row in the 47M-row table and filters in memory, while the bitmap index scan uses the GIN index to identify only the ~413 matching rows. The heap blocks count (398) shows that the matching rows are spread across 398 data pages, which is still efficient — each page is 8KB, so the total I/O is about 3.1MB instead of scanning the entire table.

This also illustrates why the canary phase didn't catch the issue: with only 5% of traffic, the absolute number of concurrent full-table scans was low enough that the database could handle the load without obvious degradation. It was only at 100% traffic that the sequential scans saturated the I/O subsystem and latency spiked.

The query plan output also reveals that the GIN index is highly selective — out of 47 million rows, only 413 matched the search term. This 0.001% selectivity is exactly the scenario where indexes provide the most benefit. Without the index, Postgres has no choice but to read every row and apply the filter in memory, which is`,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Incident report with smaller suffix (~2100 chars, near truncation boundary). The prefix ends mid-sentence in Remediation: "index operations on large tables will require" — should describe what the new requirement is (e.g., `CONCURRENTLY` flag, off-hours scheduling, explicit approval). The suffix continues with a broader organizational takeaway. Completion should finish the sentence and possibly add one more before the suffix picks up. Technical incident report voice.',
    },
  },

  // ── Anchor 2 again: Technical README, mixed structure ───────────────
  {
    id: 'prose-mid-doc-mixed-structure',
    description: 'Doc with headings/lists/tables, cursor in prose between structured elements',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'README.md',
    // prefix target: ~3700 chars
    prefix: `to manage multiple environments from a single installation. See the [Profiles](#profiles) section below for details.

> **Compatibility note:** Atlas CLI v2.x requires Node.js 18+ or Python 3.10+. The Go SDK requires Go 1.21+. Older runtime versions may work but are not tested and won't receive bug fixes. Check the [compatibility matrix](https://docs.atlas.dev/compatibility) for the full breakdown by SDK version.

### Installation

Install the CLI globally via npm, pip, or Homebrew:

\`\`\`bash
# npm
npm install -g @atlas/cli

# pip
pip install atlas-cli

# Homebrew (macOS / Linux)
brew install atlas-data/tap/atlas-cli
\`\`\`

Verify the installation with \`atlas version\`. The output should show the CLI version, the SDK version, and the detected runtime.

## Configuration

### Environment Variables

The following environment variables must be set before running the CLI:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| \`ATLAS_API_KEY\` | Yes | — | Your API key from the dashboard |
| \`ATLAS_REGION\` | No | \`us-east-1\` | Target region for data operations |
| \`ATLAS_PROFILE\` | No | \`default\` | Named profile from \`~/.atlas/config\` |
| \`ATLAS_LOG_LEVEL\` | No | \`warn\` | Logging verbosity: debug, info, warn, error |
| \`ATLAS_TIMEOUT_MS\` | No | \`30000\` | Request timeout in milliseconds |

You can also set these in a \`.env\` file in the project root — the CLI loads it automatically via dotenv. Profile-based configuration (\`~/.atlas/config\`) takes precedence over environment variables, which in turn take precedence over defaults.

### Profiles

For managing multiple environments (dev, staging, prod), use named profiles:

\`\`\`toml
# ~/.atlas/config

[default]
api_key = "ak_dev_..."
region = "us-east-1"

[staging]
api_key = "ak_staging_..."
region = "us-west-2"

[production]
api_key = "ak_prod_..."
region = "eu-west-1"
timeout_ms = 60000
\`\`\`

Switch between profiles with \`--profile\` or \`ATLAS_PROFILE\`:

\`\`\`bash
atlas query --profile production "SELECT * FROM events LIMIT 10"
\`\`\`

The CLI validates profile existence on startup — referencing a profile that doesn't exist in \`~/.atlas/config\` will fail immediately with a clear error rather than falling through to defaults silently.

### Data Types

Atlas maps its internal types to language-native types based on the SDK you're using. The mapping is mostly intuitive, but there are a few edge cases worth knowing about:

| Atlas Type | TypeScript | Python | Go | Notes |
|-----------|-----------|--------|-----|-------|
| \`string\` | \`string\` | \`str\` | \`string\` | UTF-8, max 1MB |
| \`int\` | \`number\` | \`int\` | \`int64\` | 64-bit signed |
| \`float\` | \`number\` | \`float\` | \`float64\` | IEEE 754 double |
| \`bool\` | \`boolean\` | \`bool\` | \`bool\` | — |
| \`timestamp\` | \`Date\` | \`datetime\` | \`time.Time\` | Always UTC |
| \`binary\` | \`Uint8Array\` | \`bytes\` | \`[]byte\` | Max 10MB |
| \`json\` | \`unknown\` | \`Any\` | \`json.RawMessage\` | Stored as JSONB |
| \`array<T>\` | \`T[]\` | \`list[T]\` | \`[]T\` | Homogeneous |
| \`map<K,V>\` | \`Record<K,V>\` | \`dict[K,V]\` | \`map[K]V\` | String keys only |

The \`json\` type deserves special mention. Atlas stores it as JSONB internally, which means it's parsed and validated on write. You can query into JSON fields using dot-notation (\`metadata.tags.priority\`), and Atlas will push the filter down to the storage layer rather than doing client-side filtering. This makes it practical for semi-structured data — schemaless fields that you still want to query efficiently.

One gotcha: \`timestamp\` fields are always stored and returned in UTC, regardless of what timezone you send. If you write \`2025-06-15T10:00:00-05:00\`, it's stored as \`2025-06-15T15:00:00Z\`. The SDKs handle conversion automatically in most cases, but if you're using the REST API directly you'll need to`,
    // suffix target: ~3600 chars
    suffix: `

### Indexes

Atlas automatically creates a primary index on the \`id\` field of every collection. For query performance, you'll want to add secondary indexes on fields you filter or sort by frequently.

Create an index via the CLI:

\`\`\`bash
atlas index create events --fields "timestamp,severity" --type btree
\`\`\`

Or programmatically:

\`\`\`typescript
await atlas.indexes.create({
  collection: 'events',
  fields: ['timestamp', 'severity'],
  type: 'btree',
});
\`\`\`

Index types:

- **btree** — General purpose. Good for range queries, sorting, equality. The default choice for most fields.
- **hash** — Equality-only lookups. Slightly faster than btree for exact matches, but can't handle range queries or ordering.
- **gin** — For \`json\` and \`array\` types. Supports containment queries (\`@>\`), existence checks (\`?\`), and path queries. Essential if you query into JSON fields frequently.
- **fulltext** — Text search with stemming, ranking, and phrase matching. Backed by a custom inverted index. See the [Full-Text Search](#full-text-search) section for configuration options.

**Index limits:** Each collection can have up to 20 secondary indexes. Indexes are built asynchronously — the \`create\` call returns immediately and the index builds in the background. Check build progress with \`atlas index status events\`.

Composite indexes (multiple fields) follow leftmost-prefix rules, same as PostgreSQL. An index on \`(timestamp, severity)\` can serve queries filtering on \`timestamp\` alone, but not queries filtering only on \`severity\`. Plan your composite indexes based on your most common query patterns.

### Rate Limiting

Atlas enforces rate limits at the API key level. The limits depend on your plan tier:

| Tier | Reads/sec | Writes/sec | Max batch size |
|------|-----------|------------|----------------|
| Free | 10 | 5 | 100 |
| Developer | 100 | 50 | 1,000 |
| Team | 500 | 250 | 5,000 |
| Enterprise | Custom | Custom | Custom |

When you hit a rate limit, the API returns HTTP 429 with a \`Retry-After\` header indicating how many seconds to wait. The SDK handles retry automatically (see [Retry Policy](#retry-policy) above), but if you're making direct REST calls you'll need to implement backoff yourself.

Batch operations count as a single API call regardless of how many records they contain (up to the batch size limit). This means inserting 1,000 records in one batch costs one write toward your rate limit, while inserting them individually costs 1,000 writes. Always prefer batch operations when working with multiple records.

### Full-Text Search

Atlas includes a built-in full-text search engine backed by custom inverted indexes. Unlike the \`gin\` index type (which handles structured JSON queries), full-text indexes are designed for natural language search with stemming, stop-word removal, and relevance ranking.

Create a full-text index on a collection:

\`\`\`bash
atlas index create articles --fields "title,body" --type fulltext --language english
\`\`\`

Search using the \`.search()\` method in the query builder, which returns results ranked by relevance:

\`\`\`python
results = (
    atlas.from("articles")
    .search("machine learning best practices", fields=["title", "body"])
    .limit(20)
    .execute()
)
\`\`\`

Each result includes a \`_score\` field indicating relevance (0.0 to 1.0). You can combine \`.search()\` with regular \`.where()\` filters — the search narrows candidates first, then filters are applied, then results are ranked by score.

Full-text search supports phrase matching with quotes (\`"exact phrase"\`), field boosting (\`title^2\` to weight title matches higher), and fuzzy matching (\`~2\` for edit distance). The underlying`,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'README with mixed structural elements (tables, code blocks, lists). Cursor is at the end of the Data Types section, mid-sentence about timezone handling in the REST API: "you\'ll need to". The suffix starts with the Indexes section. Completion should finish the sentence about what REST API users need to do with timezones (e.g., handle UTC conversion manually, pass UTC timestamps). Technical README tone. One sentence or short clause.',
    },
  },

  // ── Anchor 1 again: System design doc, topic transition ─────────────
  {
    id: 'prose-mid-doc-multi-topic',
    description: 'Prefix discusses topic A, suffix discusses topic C, cursor at topic B transition',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'design-doc.md',
    // prefix target: ~3800 chars
    prefix: `application code. The SDK serializes the command and sends it to the leader over the internal Raft channel, so from the caller's perspective it looks like a local function call with an async response.

### Consistency Guarantees

The system provides linearizability for single-key operations. If a write to key K completes (returns success), all subsequent reads of K will see that write or a later one. This holds even if the reader connects to a different replica than the writer, because reads are served by the leader (or by followers that have caught up to the leader's commit index — more on that in the read path section below).

For multi-key operations, we provide serializability within a single partition. Transactions that span multiple keys in the same partition are executed atomically and in serial order. Cross-partition transactions are NOT supported — this is a deliberate design choice to avoid the complexity and performance cost of distributed transactions (2PC, Paxos commit, etc.).

If you need cross-partition atomicity, the recommended pattern is the saga pattern: break the transaction into a sequence of single-partition operations with compensating actions for rollback. The SDK includes a saga coordinator that handles the orchestration, retries, and compensation automatically. It's not as clean as a real distributed transaction, but it's predictable and doesn't create head-of-line blocking across partitions.

**CAP tradeoff:** Under network partition, the system chooses consistency over availability (CP). A partition that loses contact with the leader will stop serving writes until the partition heals or a new leader is elected. Reads may still be served from followers if the client opts into "stale reads" mode, which returns data that's at most N seconds old (configurable, default 5s). Stale reads are useful for dashboards and monitoring where slightly outdated data is acceptable.

### Write Path

When a client sends a write request, it follows this path:

1. Client SDK routes the request to the leader of the appropriate partition (determined by hashing the key)
2. Leader validates the request (schema check, size limits, permission check)
3. Leader appends the command to its Raft log
4. Leader replicates the log entry to followers
5. Once a majority of replicas acknowledge, the leader commits the entry
6. Leader applies the command to the state machine and returns the result to the client

Step 5 is where durability happens — once committed, the entry survives any single node failure. The latency cost of this path is dominated by step 4 (network round-trips to followers). In a 3-node cluster with same-region replicas, this typically adds 2-5ms over a local write. Cross-region clusters are significantly slower (50-150ms depending on geography), which is why we recommend keeping all replicas within the same region unless you specifically need geographic redundancy for disaster recovery. For geo-distributed deployments, see the Multi-Region section below.

### Read Path

Reads have two modes, configurable per request:

- **Strong reads** (default): Routed to the leader, which ensures it has the latest committed state before responding. This adds a small overhead (the leader checks its lease or sends a heartbeat round) but guarantees linearizability.
- **Stale reads**: Can be served by any replica. The replica checks that its applied index is within the staleness bound and responds immediately. No leader involvement, so latency is lower and the leader isn't a bottleneck for read-heavy workloads.

For most applications, strong reads are the right default. Switch to stale reads for specific endpoints where freshness isn't critical —`,
    // suffix target: ~3500 chars
    suffix: `

### Compaction

The Raft log grows indefinitely as new commands are appended. Without compaction, storage costs increase linearly and crash recovery takes longer (because the state machine must replay the entire log from the beginning).

We use snapshot-based compaction. Periodically (every 100,000 log entries by default), each node takes a snapshot of its state machine and truncates the log up to the snapshot point. The snapshot is stored alongside the log and serves as the starting point for recovery — instead of replaying millions of entries, the node loads the snapshot and then replays only the entries after the snapshot.

Snapshots are also used for replication catch-up. If a follower falls far behind the leader (its next expected log entry has been compacted away), the leader sends the snapshot instead of the missing log entries. This is slower than incremental replication but handles the edge case of a follower that was offline for an extended period.

**Compaction tuning:** The 100K-entry trigger is a reasonable default for most workloads. If your state machine is large (>1GB), consider increasing the trigger to reduce snapshot frequency. If your entries are large (>1KB average), consider decreasing it to control log size. The dashboard shows log size and snapshot frequency metrics to help you tune.

### Membership Changes

Adding or removing nodes from the cluster requires a configuration change that's committed through Raft (to ensure all nodes agree on the cluster membership). We use the joint consensus approach from the Raft dissertation:

1. Leader proposes a "joint configuration" that includes both old and new membership
2. Once the joint config is committed, the leader proposes the final new configuration
3. Once the final config is committed, the transition is complete

This two-phase approach avoids the split-brain risk that can occur with single-step membership changes. The downside is that it's more complex and takes two consensus rounds instead of one. In practice the extra latency is negligible (a few milliseconds), and the safety guarantee is well worth it.

**Scaling up:** To add a node, start it with the \`--join\` flag pointing to any existing cluster member. The new node receives a snapshot of the current state and begins following the leader's log. Once it's caught up (within a configurable lag threshold), the leader automatically initiates a membership change to include it. The whole process typically takes 30-60 seconds for a state machine under 1GB.

**Scaling down:** To remove a node, issue a \`remove-member\` command via the admin API. The leader commits a membership change that excludes the node. Once committed, the removed node stops receiving log entries and shuts down gracefully. Ensure you always maintain an odd number of nodes (3, 5, 7) to keep majority quorums efficient.

### Failure Modes and Recovery

The system handles three categories of failures:

**Transient network issues** (packet loss, brief partitions): Raft handles these automatically through retransmission. No operator intervention needed.

**Node crashes** (process death, hardware failure): The remaining nodes continue operating as long as a majority is alive. A 3-node cluster tolerates 1 failure, 5-node tolerates 2. The crashed node rejoins automatically on restart and catches up via log replication or snapshot transfer.

**Persistent network partition** (sustained split): The side with a majority of nodes continues operating normally. The minority side stops serving writes and enters a degraded`,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```', '##', '###'],
      quality_notes:
        'System design doc about a distributed key-value store. Prefix discusses the Read Path (topic A: strong vs stale reads), and the cursor is at the end of advice about stale reads: "Switch to stale reads for specific endpoints where freshness isn\'t critical --". The suffix discusses Compaction (topic C). The completion should finish the thought about stale reads (topic B) — e.g., examples of such endpoints, or a sentence wrapping up the read path discussion. Should NOT introduce headings. One to two sentences bridging naturally to where the Compaction section will start.',
    },
  },
];
