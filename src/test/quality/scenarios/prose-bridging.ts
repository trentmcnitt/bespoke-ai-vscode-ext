/**
 * Prose bridging scenarios for fill-in-the-middle quality evaluation.
 *
 * Bridging scenarios are the hardest type of completion: there is existing
 * text on BOTH sides of the cursor, and the model must generate text that
 * connects them naturally. Each scenario is extracted from a larger "anchor
 * document" — a realistic 7000-10000 character document where real sentences
 * were removed to create the gap.
 *
 * Prefixes start mid-document (simulating truncation) and suffixes end
 * mid-paragraph (not at section boundaries) to mimic real editing conditions.
 */
import { TestScenario } from '../judge';

export const proseBridgingScenarios: TestScenario[] = [
  // ── Anchor Document 1: Technical Report on Cache Invalidation ────
  // ~8200 chars total across both scenarios from this doc.
  // Yields: prose-bridge-small-sentence, prose-bridge-small-clause

  {
    id: 'prose-bridge-small-sentence',
    description: 'Technical report, bridge ~20 words completing a thought about cache eviction',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'report.md',
    prefix: `the overall hit rate remained above 92% for the first three weeks of the observation period. The week-4 dip to 87% coincided with the Black Friday traffic spike, which introduced a burst of never-before-seen product IDs that displaced frequently-accessed items. Post-spike, the hit rate recovered within 36 hours as the new items either stabilized in the working set or fell out of demand.

### Eviction Strategy Comparison

We tested three eviction strategies under identical traffic patterns recorded from production during the week of Nov 12-18. Each strategy ran on an isolated replica with 4GB of cache memory and a 90/10 read/write split. The metrics below represent 95th-percentile latencies and average hit rates across the seven-day window.

| Strategy | p95 Latency (ms) | Hit Rate | Memory Efficiency |
|----------|-------------------|----------|-------------------|
| LRU      | 12.3              | 91.4%    | 78%               |
| LFU      | 14.1              | 93.2%    | 84%               |
| ARC      | 11.8              | 94.7%    | 81%               |

The Adaptive Replacement Cache (ARC) algorithm outperformed both LRU and LFU on latency and hit rate, though its memory efficiency was slightly lower than LFU. The key advantage of ARC is its ability to balance recency and frequency without manual tuning — the algorithm maintains two internal lists (one for recently-accessed items and one for frequently-accessed items) and dynamically adjusts the partition between them based on observed workload characteristics. When the workload shifts from recency-heavy to frequency-heavy (or vice versa), ARC adapts within a few hundred requests.

One surprising result was the LFU strategy's poor showing on tail latency despite having the highest memory efficiency. We traced this to a "frequency stagnation" effect: items that accumulated high access counts during an initial burst remained pinned in cache long after they stopped being useful. This is a well-documented weakness of naive LFU implementations (see O'Neil et al., 1993), but we had expected our frequency-decay variant to mitigate it. In practice, the decay window of 6 hours was too long for our workload, where popularity shifts happen on the order of minutes during peak traffic. Reducing the decay window to 30 minutes improved LFU's tail latency by ~20% in subsequent testing, but still left it behind ARC on overall metrics.

#### Recommendations

Based on these findings, we recommend migrating the primary cache tier from LRU to ARC. The estimated performance improvement is a 15-20% reduction in p95 latency and a 3 percentage point increase in hit rate. The migration can be done incrementally by routing a percentage of traffic to ARC-backed nodes and comparing metrics in real time.

For the secondary cache tier (which handles the long-tail of less-frequently-accessed content), LRU remains the better choice. The access patterns in this tier are more uniform and less bursty, which neutralizes ARC's adaptive advantage while avoiding the additional memory overhead of maintaining the ghost lists.

We also evaluated a hybrid approach in which the primary tier runs ARC and overflows evicted entries into an LRU-backed secondary tier. Early prototyping showed promise — the combined hit rate was 96.1% in synthetic benchmarks — but the implementation adds non-trivial complexity to the cache client. The overflow mechanism requires tracking cross-tier metadata (original insertion time, access frequency histogram) to make intelligent promotion/demotion decisions, and there isn't an obvious way to handle the case where both tiers attempt concurrent updates to the same key. We decided to defer this approach pending further investigation,`,
    suffix: ` The implementation would require changes to the cache client library to support tier-aware routing, which the infrastructure team estimates at roughly two weeks of engineering effort.

We should also note that these results are specific to our workload profile. Services with different read/write ratios or access patterns may see different relative performance across strategies. Before adopting ARC in other services, we recommend running a similar A/B evaluation using that service's production traffic replay. The infrastructure team is building a generic "cache strategy bench" tool that automates this process — you provide a traffic log and a set of strategies, and it runs each one in an isolated container with configurable memory limits and reports comparative metrics. ETA for that tool is Q1 next year.

### Operational Considerations

Switching eviction strategies carries some operational risk. During the transition period, the new cache will start cold — there's no practical way to migrate the existing LRU state into ARC's dual-list structure. Based on our load testing, a cold ARC cache reaches steady-state hit rates within approximately 8 minutes under normal traffic, but this could stretch to 20+ minutes during off-peak hours when the cache warms more slowly.

To mitigate this, we propose a phased rollout:

1. Deploy ARC to the canary pool (5% of traffic) and monitor for 48 hours
2. If metrics are stable, expand to 25% and hold for another 24 hours
3. Full rollout to the remaining fleet with automated rollback triggers

The rollback triggers are based on two signals: if the p95 latency exceeds 25ms (roughly 2x our current baseline) for more than 5 consecutive minutes, or if the error rate on cache reads exceeds 0.1%. The monitoring dashboard already tracks both of these metrics; we just need to wire them into the deployment pipeline's circuit breaker.

We also need to coordinate the rollout with the application team. The application layer has its own caching logic (HTTP response caching via Varnish, session caching via a separate Redis cluster) and changing the behavior of the data cache could have subtle effects on upstream cache hit patterns. For example, if ARC keeps hot items cached longer than LRU did, the Varnish layer might see fewer origin requests, which could affect its own cache sizing assumptions. We've asked the application team to monitor their cache metrics during our canary phase and flag any anomalies.

One open question is whether we should pre-warm the ARC cache using a traffic replay tool before cutting over production traffic. We built a prototype replayer that reads from the access log and issues synthetic gets, but it introduces a complication: the replayed traffic doesn't trigger real writes, so the cache state diverges from what production would produce. The infra team suggested an alternative approach where we shadow production traffic to the new nodes for a warm-up period before switching the read path. This shadow-warming approach has the advantage of producing a cache state that accurately reflects live traffic, but it doubles the read load on the backend during the warm-up window. Given our current headroom (~35% spare capacity on the DB read replicas), this should be feasible during off-peak hours but risky during the daily traffic peak between 10am-2pm ET. The infra team is still debating the exact cutover timing and whether we need to temporarily scale up the read replica pool to absorb the doubled load`,
    requirements: {
      must_not_include: ['```', 'The implementation would require changes'],
      quality_notes:
        'Gap is ~20 words. The prefix ends mid-sentence after discussing "We decided to defer this approach pending further investigation," — the model needs to finish this thought with a brief clause (e.g., noting it as a potential future optimization, or adding a condition for revisiting it). The suffix picks up with "The implementation would require changes..." which discusses implementation effort for the deferred hybrid approach. The completion must connect the deferral statement to the implementation discussion without repeating either side.',
    },
    saturation: { prefix: 'saturated', suffix: 'saturated' },
  },

  {
    id: 'prose-bridge-small-clause',
    description:
      'Technical report, complete a trailing clause (~10 words) about shadow cache warming',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'report.md',
    prefix: `We should also note that these results are specific to our workload profile. Services with different read/write ratios or access patterns may see different relative performance across strategies. Before adopting ARC in other services, we recommend running a similar A/B evaluation using that service's production traffic replay.

### Operational Considerations

Switching eviction strategies carries some operational risk. During the transition period, the new cache will start cold — there's no practical way to migrate the existing LRU state into ARC's dual-list structure. Based on our load testing, a cold ARC cache reaches steady-state hit rates within approximately 8 minutes under normal traffic, but this could stretch to 20+ minutes during off-peak hours when the cache warms more slowly.

To mitigate this, we propose a phased rollout:

1. Deploy ARC to the canary pool (5% of traffic) and monitor for 48 hours
2. If metrics are stable, expand to 25% and hold for another 24 hours
3. Full rollout to the remaining fleet with automated rollback triggers

The rollback triggers are based on two signals: if the p95 latency exceeds 25ms (roughly 2x our current baseline) for more than 5 consecutive minutes, or if the error rate on cache reads exceeds 0.1%. The monitoring dashboard already tracks both of these metrics; we just need to wire them into the deployment pipeline's circuit breaker.

We also need to coordinate the rollout with the application team. The application layer has its own caching logic (HTTP response caching via Varnish, session caching via a separate Redis cluster) and changing the behavior of the data cache could have subtle effects on upstream cache hit patterns. For example, if ARC keeps hot items cached longer than LRU did, the Varnish layer might see fewer origin requests, which could affect its own cache sizing assumptions. We've asked the application team to monitor their Varnish metrics during the canary phase and flag any anomalies.

One open question is whether we should pre-warm the ARC cache using a traffic replay tool before cutting over production traffic. We built a prototype replayer that reads from the access log and issues synthetic gets, but it introduces a complication: the replayed traffic doesn't trigger real writes, so the cache state diverges from what production would produce. The infra team suggested an alternative approach where we shadow production traffic to the new nodes for a warm-up period,

The shadow-warming idea has some nuance worth discussing. Rather than simply mirroring all reads, the proposal is to selectively replay only GET requests (ignoring writes) to the ARC-backed nodes. This ensures the cache is populated with realistic access patterns without risking any data mutation side effects. The replay proxy sits between the load balancer and the cache fleet, tapping a copy of each read request and forwarding it to the warm-up pool. It adds ~2ms of latency to the forwarding path (measured in our staging environment) but doesn't affect the latency of the primary path since the forwarding is asynchronous — fire and forget.

We tested this approach on the staging fleet and found that a 15-minute warm-up window was sufficient to bring the ARC cache to ~90% of its steady-state hit rate. The remaining 10% takes another 30-45 minutes to converge, mostly long-tail items that are accessed infrequently. For the production cutover, we plan to run the shadow warm-up during the 4am-6am low-traffic window,`,
    suffix: ` before switching the read path. This shadow-warming approach has the advantage of producing a cache state that accurately reflects live traffic, but it doubles the read load on the backend during the warm-up window. Given our current headroom (~35% spare capacity on the DB read replicas), this should be feasible during off-peak hours but risky during the daily traffic peak between 10am-2pm ET.

### Cost Analysis

The move to ARC does not require additional hardware. ARC's memory overhead (the ghost lists that track recently-evicted keys) adds roughly 8-12% to the per-node memory footprint, but we sized our cache fleet with 20% headroom specifically to accommodate this kind of change. The only incremental cost is the engineering time for the migration, which we estimate at 3 weeks total: 2 weeks for the cache client changes and 1 week for testing and rollout.

#### Total Estimated Cost

| Item | Hours | Rate | Cost |
|------|-------|------|------|
| Client library changes | 80 | $175/hr | $14,000 |
| Integration testing | 24 | $175/hr | $4,200 |
| Load testing and benchmarking | 16 | $175/hr | $2,800 |
| Phased rollout and monitoring | 40 | $175/hr | $7,000 |
| **Total** | **160** | | **$28,000** |

Given the projected 15-20% latency improvement and 3 percentage point hit rate increase, the return on investment is strongly positive. Rough back-of-the-envelope calculation: every 1ms of p95 latency reduction saves approximately $800/month in compute costs (fewer retries, lower timeout rates, reduced backend load from cache misses). A 2ms reduction — conservative given our benchmarks — would pay back the engineering investment within 18 months, not counting the harder-to-quantify benefits of improved user experience from lower tail latencies.

It's also worth noting that the ARC implementation we tested is the one from the \`arcache\` library (v3.2.1), which is battle-tested in production at several large companies. We considered writing our own implementation to avoid the dependency, but the library is small (~600 lines), well-tested (98% coverage), and actively maintained. The risk of a supply-chain issue is low relative to the risk of subtle bugs in a hand-rolled implementation of a non-trivial algorithm.

### Monitoring and Observability

The current monitoring stack for the cache fleet is built on Prometheus + Grafana. Each cache node exports metrics via a sidecar exporter, including:

- Hit rate (rolling 1m, 5m, 15m windows)
- Eviction rate and eviction reason breakdown
- Memory utilization (used vs. allocated vs. OS RSS)
- Request latency histograms (p50, p95, p99)
- Connection pool utilization
- Error rates by type (timeout, connection refused, serialization)

For the ARC migration specifically, we'll add two new metrics: the ARC balance ratio (proportion of the cache allocated to the recency list vs. the frequency list) and the ghost list size (number of recently-evicted keys being tracked for promotion decisions). These metrics will help us understand how ARC is adapting to our workload in real time and detect pathological cases where the algorithm oscillates between recency and frequency modes.

The alerting rules will need to be recalibrated after the migration. Our current hit-rate alert fires when the rolling 5-minute average drops below 88%, which was tuned for LRU. With ARC's expected hit rate of ~94%, we should tighten this to 90% — still 4 percentage points of headroom, but enough to catch a real degradation before it impacts user-facing latency. The latency alerts can stay as-is since they're based on absolute thresholds rather than relative`,
    requirements: {
      must_not_include: ['```', 'before switching the read path'],
      quality_notes:
        'Gap is ~10 words (a short clause). The prefix ends with "we plan to run the shadow warm-up during the 4am-6am low-traffic window," and the suffix starts with "before switching the read path." The model needs to insert a brief connective clause — something like "and then cut over at 6am when the on-call team is available" or "giving the cache approximately two hours to reach steady state" — that bridges the timing detail to the read path switch. Very short gap; the main risk is generating too much text or repeating the suffix.',
    },
    saturation: { prefix: 'saturated', suffix: 'saturated' },
  },

  // ── Anchor Document 2: Blog Post on Remote Work Culture ──────────
  // ~7800 chars total. Yields: prose-bridge-medium-paragraph

  {
    id: 'prose-bridge-medium-paragraph',
    description: 'Blog essay, bridge one sentence about async communication tradeoffs',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'blog-post.md',
    prefix: `to a distributed team in 2020, and I've been studying how different organizations handle the transition ever since. My conclusion, after talking to something like 40 team leads across a range of industries (tech, finance, education, government, nonprofits), is that the biggest mistake companies make is treating remote as "office minus the commute." The ones that thrive are the ones that stopped trying to replicate the office experience over Zoom and instead leaned into what remote actually enables: deep work blocks, async-first communication, and flexible schedules that accommodate real life.

I should be honest about my own bias here: I'm an introvert who does his best work alone with headphones on, so remote is basically my natural habitat. The people I know who struggle most with it tend to be the ones who draw energy from spontaneous social interactions — the hallway conversations, the lunch outings, the "hey let me show you something" moments that don't translate well to scheduled Zoom calls. I'll talk about the loneliness factor more in a later section, but for now I want to focus on the communication patterns that make or break remote teams.

## The Async-First Trap

Here's the thing nobody talks about when they evangelize async communication: it requires significantly more discipline than synchronous work, not less. When you're in an office, you can be sloppy with your written communication because you'll bump into the person at lunch and clarify. In an async world, every message you send has to carry enough context to stand on its own, and most people are terrible at this.

I've watched teams adopt async tools (Notion docs, Loom recordings, threaded Slack channels with strict "no DMs for work discussions" rules) and then slowly slide back into synchronous patterns within 3-6 months. The failure mode is almost always the same: someone posts a question in a channel, doesn't get a response within 20 minutes, and hops on a quick call to "just sort it out." Once that becomes acceptable, the async norms erode fast.

The teams that actually make async work tend to have a few things in common. They document decisions obsessively — not in meetings, but in written artifacts that anyone can read later. They have explicit response-time expectations (e.g., "channels are checked 3x per day, urgent items go to a dedicated triage channel"). And they treat writing as a core skill, not a nice-to-have. One engineering manager I talked to said she evaluates candidates partly on the clarity of their written communication during the interview process, because she knows that skill will matter more than whiteboard coding in a remote-first org.

There's also a cultural component that's hard to manufacture. The best async teams I've seen have a genuine respect for each other's focus time. Nobody expects an instant reply. Nobody gets passive-aggressive about response latency. There's an unspoken agreement that "I'll get back to you within a few hours" is perfectly acceptable for most things, and that urgent matters have a dedicated escalation path (usually a phone call or a tagged message in a specific channel). This kind of trust takes months to build and seconds to destroy — one manager who chronically expects immediate responses can undo the whole thing.

But even the best async teams hit a wall when it comes to creative collaboration and conflict resolution.`,
    suffix: ` You can see this play out in design reviews and architecture discussions — the initial proposal works great as an async doc, but the back-and-forth refinement almost always ends up in a synchronous session. And that's fine, honestly. The goal isn't to eliminate all meetings; it's to make meetings rare enough that people actually prepare for them and pay attention.

The hybrid approach that seems to work best is what one company I studied calls "async by default, sync by exception." The rule is simple: start everything in writing. If after two rounds of async feedback you're not converging, schedule a 30-minute call with a clear agenda. The call produces a written summary that goes back into the async record. This way the synchronous conversation is a last resort, not the default, and the output is always captured for people who weren't there.

I've been running my own team this way for about eight months now, and the results are mixed but promising. We have about 60% fewer meetings than before — down from ~12 hours per week of scheduled calls to about 4-5 hours. But the meetings we do have are substantially better: people come prepared, the agenda is clear, and we almost always reach a decision. The time we used to spend in status meetings now goes into written updates posted every Monday and Thursday.

The hardest part, honestly, has been my own behavior. I'm naturally a "let's hop on a quick call" person, and I've had to train myself out of that instinct. My rule now: if I catch myself wanting to schedule a call, I first try to articulate what I need in writing. About half the time, the act of writing it out either answers my own question or makes the async thread productive enough that the call becomes unnecessary. The other half of the time, the written framing makes the eventual call much shorter because everyone arrives with shared context.

## The Loneliness Problem

Here's the part that the productivity-focused remote work discourse tends to gloss over: working from home can be profoundly isolating. Not for everyone, and not all the time, but frequently enough that it deserves honest discussion rather than the usual "just join a coworking space" hand-wave.

I noticed it creeping up on me around month four. The first few months of full-time remote felt liberating — no commute, no open-plan noise, no mandatory fun. But then one Tuesday afternoon I realized I hadn't spoken to another human being out loud in over 30 hours. Not because I was busy. Just because there was no natural occasion for it. My Slack messages were flowing fine, my PRs were getting reviewed, my async updates were on schedule. By every productivity metric I was crushing it. And yet I felt weirdly hollow.

The research on this is pretty clear (Buffer's "State of Remote Work" surveys, Gallup's engagement data, various academic studies from 2020-2023): loneliness and disconnection consistently rank as the #1 or #2 challenge reported by remote workers, right alongside "difficulty unplugging." The standard advice — schedule virtual coffee chats, join a coworking space, cultivate hobbies — is not wrong exactly, but it misses the point. The loneliness isn't about lacking social interaction in general; it's about lacking the specific kind of social interaction that comes from being on a team. The casual solidarity of working alongside people who are in the same boat. The ability to say "ugh, that deploy was rough" and have someone nod because they were there too`,
    requirements: {
      must_not_include: ['```', 'You can see this play out'],
      quality_notes:
        'Gap is ~1 sentence (roughly 20-30 words). The prefix ends with "hit a wall when it comes to creative collaboration and conflict resolution." and the suffix starts with "You can see this play out in design reviews and architecture discussions." The model should bridge these with a sentence that elaborates on WHY async fails for creative/conflict scenarios — something about the need for real-time back-and-forth or the difficulty of conveying nuance in text. The tone is casual blog voice with first-person asides.',
    },
    saturation: { prefix: 'saturated', suffix: 'saturated' },
  },

  // ── Anchor Document 3: System Design Document for Event Processing ─
  // ~8500 chars total. Yields: prose-bridge-medium-transition

  {
    id: 'prose-bridge-medium-transition',
    description:
      'System design doc, bridge a section transition (~2 sentences) about failure handling',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'design-doc.md',
    prefix: `the consumer fleet processes events from a single Kafka topic (\`events.main\`) with 24 partitions. Each partition is processed by exactly one consumer at a time (ensured by the consumer group protocol), which gives us ordered processing within a partition without cross-consumer coordination.

The partition key is the \`tenantId\`, which means all events for a given tenant land on the same partition and are processed in order. This is critical for correctness — some event handlers depend on seeing events in causal order (e.g., a \`subscription.activated\` event must be processed before the corresponding \`invoice.generated\` event). Cross-tenant ordering is not guaranteed and not needed. We chose \`tenantId\` over alternatives like \`userId\` or \`entityId\` because tenant-level ordering covers the broadest set of handler requirements while keeping partition counts manageable — with ~2,000 active tenants and 24 partitions, the distribution is reasonably even (median ~83 tenants per partition).

### Throughput and Scaling

At current volumes (~3,200 events/second, p99 processing time 45ms per event), we need a minimum of 12 partitions to keep up without backpressure. We're provisioning 24 partitions to give us 2x headroom for growth and to handle traffic spikes during batch operations (tenant migrations can generate 10-50x normal event volume for short bursts).

Scaling is horizontal: adding more consumer instances up to the partition count increases throughput linearly. Beyond 24 consumers, additional instances sit idle (Kafka's consumer group protocol assigns at most one consumer per partition). If we need more than 24x throughput, we'll need to increase the partition count, which requires a brief period of rebalancing — not a zero-downtime operation, but manageable with a rolling strategy during off-peak hours.

We also considered using a separate "fast lane" topic for high-priority events (payment confirmations, auth token revocations) that need sub-second processing. The tradeoff is operational complexity: two topics means two sets of consumers, two monitoring dashboards, and more moving parts. For now we're deferring this and instead assigning higher thread priority to handlers registered for these event types within the single-topic consumer. If p99 latency for priority events exceeds 200ms, we'll revisit the multi-topic approach.

One additional consideration is back-pressure handling. When a consumer falls behind — either due to slow handler code or a burst of events from a batch import — the lag on that partition grows. We monitor consumer lag via Prometheus metrics (exposed through the Kafka consumer's built-in JMX beans, scraped every 15 seconds) and alert when any single partition's lag exceeds 10,000 events or when the aggregate lag across all partitions exceeds 50,000. The alerting threshold was calibrated based on our SLA: we guarantee event processing within 60 seconds of ingestion, and at our current throughput a 10,000-event lag represents approximately 3 seconds of processing time, giving us ample headroom before an SLA breach.

For extreme burst scenarios (e.g., a tenant migration that generates 500k events in a few minutes), we have an auto-scaling policy that spins up additional consumer instances within the 24-partition limit. The scaling trigger is a sustained lag growth rate of >1,000 events/second for more than 30 seconds. New instances join the consumer group and receive partitions via Kafka's cooperative rebalancing protocol, which avoids the stop-the-world pauses of the older eager rebalancing. In practice, a new consumer starts processing events within 5-8 seconds of launch.

### Failure Handling and Retry`,
    suffix: `When a handler throws an unrecoverable error (after exhausting retries), the event is routed to a dead-letter topic (\`events.deadletter\`) with the original payload, the handler class name, the exception message, and a retry count. A separate process monitors the dead-letter topic and alerts the on-call engineer via PagerDuty if the dead-letter rate exceeds 0.01% of total throughput over a 5-minute window.

Dead-letter events can be replayed manually through an admin API endpoint. The replay tool re-publishes the original event back to the main topic with a \`replayed: true\` flag, which lets handlers distinguish retries from organic events if they need to (most don't). We keep dead-letter events for 30 days before auto-purging.

One edge case worth calling out: if a handler fails due to a downstream service being unavailable (e.g., the billing API is down), simple retries won't help. For these transient-dependency failures, the handler should throw a \`RetryableError\` subclass, which triggers a different retry path with exponential backoff and a circuit breaker. The circuit breaker tracks failure rates per downstream service and stops sending requests after 5 consecutive failures, checking every 30 seconds to see if the service has recovered. This prevents a single downstream outage from blocking the entire event pipeline — events for other handlers continue processing normally.

The retry budget is configurable per handler via annotations on the handler class. The defaults are:

- **Max retries:** 3
- **Initial delay:** 500ms
- **Backoff multiplier:** 2x (500ms, 1s, 2s)
- **Max delay cap:** 30s

Handlers that deal with external APIs (payment processors, email providers, webhook deliveries) typically override these with higher retry counts and longer backoff windows, since transient failures in those systems can last minutes rather than seconds. The \`PaymentWebhookHandler\`, for example, uses 5 retries with a 60-second max delay and a 10-minute overall timeout before dead-lettering.

#### Idempotency

Because we use at-least-once delivery semantics (an event may be delivered more than once if the consumer crashes after processing but before committing the offset), all handlers must be idempotent. The standard approach is to maintain a processed-event table keyed by the event's unique sequence number. Before processing, the handler checks whether the sequence number exists in the table; if it does, the event is skipped. The check-and-insert is wrapped in a database transaction together with the handler's side effects, ensuring atomicity.

For handlers that call external APIs (which can't participate in a local database transaction), we use a slightly different pattern: process the event, record it in the idempotency table, and rely on the external API's own idempotency mechanisms (e.g., Stripe's \`Idempotency-Key\` header) to prevent duplicate side effects. This isn't bulletproof — not all external APIs support idempotency keys — but it covers the common cases. For the few APIs that don't, we accept the small risk of duplicate calls and design the handlers to be resilient to duplicates at the application level (e.g., checking whether a notification was already sent before sending another).

### Monitoring

The event processing pipeline is monitored through a combination of Prometheus metrics, structured logs, and a custom Grafana dashboard. Key alerts are configured for consumer lag (>10k events on any partition), dead-letter rate (>0.01% of throughput), handler error rate (>1% for any single handler), and processing latency (p99 >500ms). The on-call rotation follows the standard team schedule with a 15-minute response`,
    requirements: {
      must_not_include: ['```', 'dead-letter topic'],
      quality_notes:
        'Gap is ~2 sentences of section-transition content. The prefix ends with the section heading "### Failure Handling and Retry" (with no body text yet), and the suffix starts mid-paragraph with "When a handler throws an unrecoverable error (after exhausting retries), the event is routed to a dead-letter topic..." The model needs to generate an introductory passage for the Failure Handling section — something that describes the general retry strategy (e.g., at-least-once delivery, retry with backoff, max retry count) before the suffix dives into the dead-letter specifics. Should be 2-3 sentences in technical design doc voice.',
    },
    saturation: { prefix: 'saturated', suffix: 'saturated' },
  },

  // ── Anchor Document 4: Instructional Guide on Database Migrations ─
  // ~8000 chars total. Yields: prose-bridge-large-explanation, prose-bridge-large-detail

  {
    id: 'prose-bridge-large-explanation',
    description:
      'Instructional guide, fill an explanatory paragraph (~3 sentences) about zero-downtime migrations',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'guide.md',
    prefix: `most migration tools default to a transactional mode where the entire migration either succeeds or rolls back atomically. This is convenient for development but can be dangerous in production — a migration that takes a table-level lock for 30 seconds will block all reads and writes to that table for the duration. On a table with active traffic, that's an outage.

The severity depends on your database engine and the type of change. PostgreSQL, for example, can add a nullable column without a full table lock (it only needs a brief \`ACCESS EXCLUSIVE\` lock to update the catalog), but adding a column with a default value on Postgres versions before 11 triggers a full table rewrite. MySQL's \`ALTER TABLE\` behavior varies by storage engine and version — InnoDB in MySQL 8.0+ supports many "instant" DDL operations, but older versions or complex changes still require a table copy. You need to understand the specific locking behavior of your database engine for each type of DDL operation.

## Zero-Downtime Migration Patterns

The key idea behind zero-downtime migrations is to break a single dangerous change into multiple safe steps, each of which is backward-compatible with the currently-running application code. This is sometimes called the "expand and contract" pattern (or "parallel change" in some literature).`,
    suffix: `For example, suppose you need to rename a column from \`userName\` to \`user_name\`. A naive approach would be a single \`ALTER TABLE ... RENAME COLUMN\` statement, but this breaks any application code that references the old name. The expand-and-contract approach looks like this:

1. **Expand:** Add the new column \`user_name\` alongside the old one. Deploy application code that writes to both columns but reads from \`userName\`.
2. **Migrate data:** Backfill \`user_name\` for existing rows where it's null.
3. **Switch reads:** Deploy code that reads from \`user_name\` instead of \`userName\`. At this point both columns exist but only \`user_name\` is actively used.
4. **Contract:** Drop the old \`userName\` column once you've confirmed nothing reads from it (check query logs, wait a few days).

Each step is independently deployable and reversible. If step 3 causes problems, you can roll back to reading from \`userName\` without any data loss because both columns are still being written.

The downside is obvious: what used to be one migration is now four, each requiring its own deployment. For teams that deploy multiple times a day this is manageable, but for teams on a weekly or monthly release cycle it can turn a simple rename into a multi-week project. Some teams mitigate this by batching related expand-and-contract steps and using feature flags to control the cutover, but that introduces its own complexity around flag cleanup and stale code paths.

### Handling Large Tables

The expand-and-contract pattern works well for structural changes (adding, renaming, or removing columns), but data migrations on large tables present additional challenges. A backfill query like \`UPDATE users SET user_name = userName WHERE user_name IS NULL\` looks harmless, but on a table with 200 million rows it can run for hours, generate enormous WAL (Write-Ahead Log) traffic, and cause replication lag that affects read replicas`,
    requirements: {
      must_not_include: ['```', 'suppose you need to rename'],
      quality_notes:
        'Gap is ~3 sentences. The prefix ends after introducing the "expand and contract" pattern concept with a brief definition. The suffix starts with "For example, suppose you need to rename a column..." — a concrete example. The model needs to generate 2-3 sentences that explain what expand-and-contract means at a high level (expand = add the new thing alongside the old, migrate data, contract = remove the old thing) BEFORE the suffix dives into the specific column-rename example. Instructional tone, second-person or impersonal. Should not jump into the example itself — that is the suffix\'s job.',
    },
    saturation: { prefix: 'unsaturated', suffix: 'unsaturated' },
  },

  {
    id: 'prose-bridge-large-detail',
    description:
      'Design-oriented guide, add supporting detail (~2 sentences) about migration tooling tradeoffs',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'guide.md',
    prefix: `Each step is independently deployable and reversible. If step 3 causes problems, you can roll back to reading from \`userName\` without any data loss because both columns are still being written.

The downside is obvious: what used to be one migration is now four, each requiring its own deployment. For teams that deploy multiple times a day this is manageable, but for teams on a weekly or monthly release cycle it can turn a simple rename into a multi-week project. Some teams mitigate this by batching related expand-and-contract steps and using feature flags to control the cutover, but that introduces its own complexity around flag cleanup and stale code paths.

### Tooling

Standard migration tools (Flyway, Liquibase, \`knex migrate\`, Django migrations, Alembic) don't enforce zero-downtime patterns — they'll happily run whatever SQL you give them. A few newer tools try to fill this gap:

- **\`gh-ost\`** (GitHub's Online Schema Tool) — performs MySQL schema changes by creating a shadow table, copying data in the background, and swapping tables atomically. Avoids table locks entirely. Only works with MySQL.
- **\`pgroll\`** — Postgres-specific tool that automates expand-and-contract for common schema changes. Still relatively new (as of 2024) but promising.
- **\`reshape\`** — Similar to pgroll but written in Rust. Handles Postgres migrations with automatic expand/contract phases.

These tools are great when they support your specific use case, but they have limitations. \`gh-ost\` doesn't handle foreign key constraints well and requires binlog access, \`pgroll\` doesn't yet support all DDL operations (no enum or constraint changes as of v0.6), and \`reshape\` requires that your application connect through a migration-aware proxy. For many teams, the pragmatic choice is to use a standard migration tool and manually apply expand-and-contract discipline,`,
    suffix: ` Regardless of which tool you use (or whether you roll your own), the most important practice is to test every migration against a production-sized dataset before running it in production. A migration that takes 50ms on your dev database with 1000 rows might take 45 minutes on a production table with 200 million rows — and that's the difference between a non-event and a major incident.

Some teams maintain a "migration staging" environment with a recent copy of production data (anonymized where necessary) specifically for this purpose. The migration runs there first, and only if it completes within the time budget does it get promoted to the production pipeline. This adds friction to the deployment process but has saved us from at least three potential outages in the past year.

### Rollback Strategies

Not every migration can be trivially rolled back. Adding a column is easy to reverse (just drop it), but dropping a column is not — once the data is gone, you need a backup to restore it. This asymmetry means you should think about rollback before writing the migration, not after.

A useful mental model is to classify migrations into three categories:

- **Fully reversible** — add column, add index, add table. Rollback is a simple DROP.
- **Data-destructive** — drop column, drop table, truncate. Rollback requires a backup or a rebuild from event logs.
- **One-way structural** — change column type, split a table, merge tables. These often can't be rolled back without data loss or application changes`,
    requirements: {
      must_not_include: ['```', 'Regardless of which tool you use'],
      quality_notes:
        'Gap is ~2 sentences. The prefix ends after discussing specific tool limitations and noting that "the pragmatic choice is to use a standard migration tool and manually apply expand-and-contract discipline," — this sentence trails off and needs completion. The suffix begins with "Regardless of which tool you use..." which transitions to general advice about testing migrations. The model should generate 1-2 sentences that finish the thought about the pragmatic manual approach (perhaps noting it works well enough when the team has good review practices or runbooks) and transition toward the general testing advice in the suffix.',
    },
    saturation: { prefix: 'unsaturated', suffix: 'unsaturated' },
  },
];
