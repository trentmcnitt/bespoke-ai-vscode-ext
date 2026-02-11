/**
 * Golden data test scenarios for completion quality evaluation.
 *
 * Each scenario defines an input context (what the user has typed) and
 * requirements for what a good completion looks like.
 */
import { TestScenario } from './judge';

// ─── PROSE SCENARIOS ────────────────────────────────────────────────

export const proseScenarios: TestScenario[] = [
  {
    id: 'prose-narrative-mid-sentence',
    description: 'Continue a narrative mid-sentence',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'story.md',
    prefix:
      'The old lighthouse keeper climbed the spiral staircase for what felt like the thousandth time. The wind howled outside, rattling the',
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```', '##', '- ', '* '],
      quality_notes:
        'Should complete the sentence naturally, then possibly add one more. Atmospheric/narrative tone.',
    },
  },
  {
    id: 'prose-technical-writing',
    description: 'Continue technical documentation',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'README.md',
    prefix:
      'The configuration file supports three output formats: JSON, YAML, and TOML. Each format has specific advantages depending on your',
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_include: ['format'],
      must_not_include: ['```', 'import', 'const'],
      quality_notes:
        'Technical documentation tone. Should discuss use cases or tradeoffs of the formats.',
    },
  },
  {
    id: 'prose-casual-blog',
    description: 'Continue a casual blog post',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'blog-post.md',
    prefix:
      "I've been using Neovim for about six months now, and honestly, the learning curve was brutal. But once you get past the initial",
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```', '##'],
      quality_notes:
        'Casual, first-person blog voice. Should continue the thought about the learning curve.',
    },
  },
  {
    id: 'prose-mid-paragraph-with-suffix',
    description: 'Insert prose in the middle of a paragraph',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'essay.md',
    prefix:
      'The industrial revolution transformed not just manufacturing, but the entire social fabric of European society. Workers migrated from',
    suffix:
      ' This mass migration created entirely new urban challenges that city planners had never faced before.',
    saturation: { prefix: 'unsaturated', suffix: 'unsaturated' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Must bridge naturally between prefix and suffix. Academic/formal tone. Should mention rural-to-urban migration or similar.',
    },
  },
  {
    id: 'prose-plaintext-email',
    description: 'Continue a plaintext email',
    mode: 'prose',
    languageId: 'plaintext',
    fileName: 'draft.txt',
    prefix:
      "Hi Sarah,\n\nThanks for sending over the Q3 report. I've reviewed the numbers and have a few questions about the",
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```', '##', 'Dear', 'Sincerely'],
      quality_notes:
        'Professional but friendly email tone. Should continue asking about specific aspects of a report.',
    },
  },
  {
    id: 'prose-short-prefix',
    description: 'Continue from very little context',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'notes.md',
    prefix: 'The key insight is that',
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Even with minimal context, should produce something coherent. Generic but grammatically sound.',
    },
  },
  {
    id: 'prose-latex-academic',
    description: 'Continue academic writing in LaTeX',
    mode: 'prose',
    languageId: 'latex',
    fileName: 'paper.tex',
    prefix:
      'The experimental results demonstrate a statistically significant correlation between the two variables ($p < 0.01$). Furthermore, the effect size suggests that',
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```python', '```javascript', '##'],
      quality_notes:
        'Academic voice. May include LaTeX math notation. Should discuss the practical significance or implications of the finding.',
    },
  },
  {
    id: 'prose-list-continuation',
    description: 'Continue after a bullet point list',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'design-doc.md',
    prefix:
      '## Design Considerations\n\n- Latency must be under 200ms for 95th percentile\n- The system should handle at least 10k concurrent connections\n- Data consistency is more important than availability\n\nGiven these constraints,',
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Should continue the prose paragraph that follows the bullet list. Technical design document voice.',
    },
  },

  // ── Context size variations ──────────────────────────────────────

  {
    id: 'prose-long-prefix-narrative',
    description: 'Saturated narrative context (4000+ prefix, 3000+ suffix)',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'novel-chapter.md',
    prefix: `# Chapter Three: The Letter

Thornfield was the kind of village that appeared on postcards but rarely on maps. Tucked into a fold of the Yorkshire moors, it had a population of four hundred and twelve — a number that had barely changed since the 1960s, when the last of the hill farms consolidated and the young people began drifting toward Leeds and Manchester in search of work that did not involve sheep. Those who stayed did so out of stubbornness or love or some combination of the two that was difficult to separate.

Eleanor Moss belonged to the latter category, though she would have struggled to articulate it. Her parents, Gerald and Anne, had run the village shop for thirty-five years before retiring to a bungalow in Scarborough. Her mother still telephoned every Sunday at precisely half past four, and the conversations followed a pattern so well-worn that Eleanor sometimes found herself mouthing the responses before they came. How's the weather up there? Has David fixed the guttering yet? Have you thought about what I said about the conservatory?

She had not thought about the conservatory. She had not thought about much of anything beyond the daily rhythm that had become her life: the morning walk to check on the chickens, the hours at her desk where she edited academic manuscripts for a small press in Edinburgh, the evening meal with David, and the slow unwinding hours before sleep. It was a good life, she told herself frequently enough to suggest she was not entirely convinced.

David taught history at the comprehensive in Harrogate, a forty-minute drive each way through roads that turned treacherous every winter. He was a quiet, methodical man who alphabetized his bookshelves and ironed his shirts on Sunday evenings while listening to Radio 4. Eleanor loved him in the comfortable, unexamined way that twenty years of marriage produces — a love built more on habit and shared history than on any ongoing spark of revelation. They were happy, or at least they were content, and in Thornfield those two words meant roughly the same thing.

The house they had built together sat at the top of Barrow Lane, a stone cottage with a slate roof and a garden that Eleanor tended with more ambition than skill. She had planted roses the first spring, and they had survived despite her irregular watering and a tendency to prune at the wrong time of year. The chickens — four hens, no rooster — occupied a coop near the back wall, and their eggs were the one thing she produced that felt concretely useful. On clear mornings, she could see all the way to the ridge where the old signal tower stood, its stones slowly surrendering to the weather.

The village of Thornfield sat at the edge of the moors, where the heather turned purple in late summer and the wind never quite stopped blowing. Eleanor had lived there all her life, first in her parents' cottage near the church, then in the larger house she and David had built the year after their wedding. She knew every stone wall, every sheep path, every place where the stream pooled deep enough for trout.

But on that particular Tuesday morning, standing at her kitchen window with a cup of tea going cold in her hands, the village looked different. Not in any way she could point to — the church spire still rose above the yew trees, the postman's red van was making its usual rounds, and Mrs. Gallagher was walking her terrier along the lane. Everything was exactly as it should have been, and yet something fundamental had shifted.

She set down the cup and reached for her coat. The letter from the solicitor was still in her pocket, where she had shoved it yesterday after reading it twice. David's brother, whom they hadn't heard from in eleven years, had died in a hospital in Melbourne. He had left everything to Eleanor — not to David, but to Eleanor specifically. The solicitor's careful phrasing couldn't disguise the oddness of it.

The walk to the post office took seven minutes. Eleanor used every one of them trying to decide what to tell Margaret behind the counter, who would certainly ask why she looked`,
    suffix: ` so pale on such a fine morning.

Margaret Ellerby had run the Thornfield post office for as long as anyone could remember. She was a broad, cheerful woman with steel-grey hair and an unerring instinct for other people's business. Nothing happened in the village without Margaret knowing about it, usually before it had finished happening. She kept the post office stocked with gossip the way other shops stocked biscuits — generously and with an eye toward variety.

"Morning, Eleanor," Margaret said, looking up from her stamp drawer. "You look like you've seen a ghost. Sit down, love, I'll put the kettle on."

Eleanor did not sit down. She stood at the counter and produced the letter from her pocket, smoothing it flat against the glass surface that covered a display of commemorative envelopes. She had not planned to show it to anyone. The words came out before she could stop them.

"Robert is dead," she said.

Margaret set down the stamps. Her expression shifted through surprise, calculation, and something that might have been recognition, all in the space of a heartbeat. "Robert Moss? David's brother Robert?"

"He died three weeks ago in Melbourne. Liver failure, the solicitor says, though the letter is somewhat vague on the details." Eleanor paused. "He left everything to me."

The silence that followed was the kind unique to small villages, where every piece of news is weighed not just for its content but for its implications — who it would affect, what it would change, which alliances it might disturb. Margaret processed information the way a computer processes data: quickly, thoroughly, and with an output that was always slightly different from what you expected.

"To you," Margaret repeated. "Not to David."

"Not to David."

Margaret pulled two mugs from beneath the counter. She filled the electric kettle and switched it on without taking her eyes off Eleanor. "Well," she said carefully, "I imagine David will have some questions about that."

Eleanor nodded. David would indeed have questions, and she did not have answers for any of them. She had not even told him yet. The letter had arrived yesterday while he was at work, and by the time he came home she had convinced herself that one more night of not knowing would not change anything. But standing here in the bright fluorescent light of the post office, with Margaret's shrewd eyes watching her, the secret felt heavier than it had at home.

Outside, the postman's van trundled past the window. A dog barked somewhere down the lane. The kettle began its slow climb toward boiling, and Eleanor realized that she had set something in motion that could not be easily stopped.

Margaret poured the tea with the deliberate care of someone who understood that certain conversations required props. She set Eleanor's mug on the counter — the one with the chipped handle that had been there since the post office was renovated in 2003 — and took a slow sip from her own before speaking again.

"How much is everything, then?" Margaret asked. "When a solicitor in Melbourne writes a letter to a woman in Yorkshire, it's usually not about a box of old photographs."

Eleanor wrapped her hands around the warm mug. "The letter mentions a house in St Kilda, some investments, and what the solicitor describes as 'a substantial collection of personal effects.' There's a figure at the bottom. It's... it's quite a lot, Margaret."`,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```', '##', '- '],
      quality_notes:
        'Long narrative context. Should continue naturally with the scene, maintaining third-person past tense and the literary tone.',
    },
  },
  {
    id: 'prose-long-prefix-technical',
    description: 'Saturated technical documentation (4000+ prefix, 3000+ suffix)',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'architecture.md',
    prefix: `# System Architecture

## Overview

This document describes the architecture of the Order Management Platform (OMP), a distributed system responsible for processing, tracking, and fulfilling customer orders across multiple sales channels. The platform handles approximately 2.4 million orders per month, with peak throughput during seasonal promotions reaching 300 orders per second.

The system is decomposed into five bounded contexts: Catalog, Pricing, Inventory, Order Processing, and Fulfillment. Each bounded context owns its data and exposes capabilities through well-defined interfaces — either synchronous REST APIs for queries or asynchronous events for state changes. The bounded contexts communicate primarily through an event backbone (Apache Kafka), with synchronous calls reserved for cases where the caller needs an immediate, consistent response.

### Design Principles

The architecture is guided by four principles:

1. **Autonomy over coordination.** Each service can be deployed, scaled, and operated independently. Cross-service transactions are avoided in favor of eventual consistency with compensating actions.
2. **Events as the source of truth.** State changes are captured as immutable events before being materialized into read-optimized views. This provides a complete audit trail and enables temporal queries.
3. **Operational simplicity.** We favor well-understood technologies (PostgreSQL, Redis, Kafka) over specialized tools, even when the specialized tool offers superior features, because the operational cost of maintaining expertise across many systems outweighs the marginal benefit.
4. **Graceful degradation.** When a downstream service is unavailable, the system continues to accept and queue work rather than rejecting requests. Circuit breakers and bulkheads prevent cascading failures.

### Technology Stack

The platform runs on Kubernetes (EKS) across three AWS availability zones. Services are written in TypeScript (Node.js 20) and Go, with TypeScript used for the API layer and Go for high-throughput event processors. Infrastructure is managed via Terraform, and CI/CD runs on GitHub Actions with deployment to staging on every merge to main and production deployment gated behind manual approval.

## Event Sourcing Architecture

The system uses event sourcing as its primary persistence pattern. Rather than storing the current state of each entity, we store the complete sequence of events that led to that state. This approach provides a full audit trail, enables temporal queries, and allows us to rebuild state at any point in time.

### Event Store

Events are stored in an append-only log backed by PostgreSQL. Each event record contains: a monotonically increasing sequence number, the aggregate ID, the event type, the JSON payload, metadata (timestamp, correlation ID, causation ID), and a schema version number. The sequence number serves as the global ordering guarantee — consumers can checkpoint their position and resume from any point.

We chose PostgreSQL over purpose-built event stores (EventStoreDB, Axon) for operational simplicity. The team already has deep PostgreSQL expertise, and the expected event volume (roughly 50 million events per year) is well within PostgreSQL's capabilities. The tradeoff is that we must implement our own subscription mechanism rather than relying on built-in catch-up subscriptions.

### Projections

Read models are built by projection handlers that consume the event stream. Each projection maintains its own checkpoint and can be rebuilt from scratch by replaying events from sequence zero. We run three classes of projections:

1. **Live projections** update in near-real-time (< 100ms lag) and serve the main API.
2. **Batch projections** run on a schedule and produce analytics datasets.
3. **Ad-hoc projections** are temporary, built for specific investigations or migrations.

The projection framework handles idempotency automatically — replaying an already-processed event is a no-op. This means`,
    suffix: ` projections can be torn down and rebuilt at any time without side effects, which is critical for both disaster recovery and schema evolution.

Each projection handler is a simple function that takes an event and updates one or more database tables. The framework wraps each handler invocation in a transaction that atomically updates the read model and advances the checkpoint. If the handler throws, the transaction rolls back and the event will be retried on the next polling cycle.

### Snapshotting

For aggregates with long event histories (some order aggregates accumulate hundreds of events over their lifecycle), we use periodic snapshotting to avoid replaying the full event stream on every load. A snapshot captures the materialized state of the aggregate at a specific sequence number. When loading an aggregate, the system finds the most recent snapshot and replays only the events that occurred after it.

Snapshots are stored in the same PostgreSQL database as the events, in a separate table keyed by aggregate ID and sequence number. The snapshotting process runs asynchronously — it does not block the write path. A background worker monitors aggregate event counts and creates snapshots when the count since the last snapshot exceeds a configurable threshold (currently 50 events).

### Error Handling and Dead Letters

Events that fail processing after three retry attempts are moved to a dead-letter queue (a separate Kafka topic). The operations team receives an alert for every dead-lettered event, and a dashboard provides tooling to inspect, edit, and replay failed events. Dead-lettered events do not block the processing of subsequent events — the projection handler skips ahead and continues from the next sequence number.

The most common causes of dead-lettered events are schema incompatibilities (when a new event version is published before the consumer has been updated) and transient database failures during peak load. Both are typically resolved within minutes, and the replay mechanism ensures no data is lost.

## CQRS Query Layer

The query layer sits in front of the projected read models and provides a unified GraphQL API for all consumer-facing applications. The API gateway handles authentication, rate limiting, and request routing. Complex queries that span multiple projections are composed at the gateway level using DataLoader for batching and deduplication, keeping individual projection queries simple and focused.

### Query Performance

Read model tables are optimized for the specific access patterns of each consumer. The orders dashboard, for example, queries a denormalized table that joins order header, line items, and fulfillment status into a single row per order. This eliminates the need for runtime joins and keeps p95 query latency under 15ms for typical dashboard loads. Pagination uses cursor-based keyset pagination rather than offset-based pagination to ensure consistent performance regardless of result set position.

For analytics queries that scan large date ranges, we maintain separate time-partitioned tables with pre-aggregated daily and weekly rollups. The batch projection pipeline refreshes these rollups nightly, and the GraphQL schema exposes them through a dedicated \`analytics\` query namespace. Queries against the rollup tables typically complete in under 50ms even for year-spanning date ranges.`,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Long technical doc. Should continue the sentence about idempotency and projection guarantees. Maintain the formal technical documentation voice.',
    },
  },
  {
    id: 'prose-long-both',
    description: 'Saturated prefix + suffix (mid-document insert, 4000+/3000+)',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'report.md',
    prefix: `# Q3 Performance Review — Acme Corporation

**Prepared by:** Strategic Planning Division
**Date:** October 15, 2025
**Distribution:** Executive Leadership Team, Board of Directors

## Executive Summary

The third quarter of fiscal year 2025 delivered a mixed performance profile. Top-line revenue exceeded targets, driven by strong enterprise deal closure, but underlying health metrics — customer satisfaction, employee retention, and system reliability — deteriorated in ways that demand immediate intervention. This report presents the quantitative findings, analyzes root causes, and proposes corrective actions with specific timelines and ownership.

The most encouraging development was the enterprise segment's 23% year-over-year growth, fueled by three marquee deals (Globex, Initech, and Umbrella Corp) that together represent $14.2M in annual recurring revenue. The sales cycle for enterprise accounts shortened from 97 days to 71 days, reflecting the effectiveness of the solution engineering team's pre-sales engagement model introduced in Q2.

The most concerning development was the August service disruption, a cascading failure in the payment processing pipeline that resulted in 14 hours of degraded service across three business days. The direct revenue impact was approximately $2.3M in lost transactions, but the indirect effects — a 7-point drop in NPS, accelerated churn in the SMB segment, and a measurable decline in team morale — will take quarters to fully remediate.

## Financial Performance

### Revenue

Total revenue for Q3 was $47.8M, representing 12% year-over-year growth and exceeding the board-approved target of $43.5M by 10%. Monthly recurring revenue (MRR) closed the quarter at $15.9M, up from $14.2M at the end of Q2.

The revenue composition shifted notably toward enterprise. Enterprise accounts (defined as contracts exceeding $100K ARR) now represent 62% of total ARR, up from 54% at the start of the fiscal year. While this concentration carries its own risks — the loss of any single enterprise account would be material — it reflects a deliberate strategic pivot approved by the board in January.

### Cost Structure

Gross margin improved to 74%, up from 71% in Q2, primarily due to infrastructure optimization work that reduced cloud compute costs by 18%. Operating expenses grew 6% quarter-over-quarter, driven by headcount additions in engineering and customer success. EBITDA margin held steady at 11%, in line with the full-year target of 10-13%.

### Cash Position

The company ended Q3 with $28.4M in cash and equivalents, after a $3.1M investment in the new data center buildout and $1.7M in unplanned remediation costs related to the August incident.

## Operational Metrics

### Customer Health

Net Promoter Score declined from 72 to 65 during Q3. The decline was concentrated in the period immediately following the August outage, with survey responses citing "reliability concerns" as the primary driver. Pre-outage NPS was trending upward at 74. Customer health scores, which aggregate product usage, support ticket volume, and engagement metrics, show that 78% of accounts are in "green" status, 15% in "yellow," and 7% in "red." The red cohort increased from 4% in Q2 and correlates strongly with accounts that experienced transaction failures during the outage.

### Employee Metrics

Headcount grew to 312, a net increase of 18 from Q2 after accounting for 23 new hires and 5 voluntary departures. However, the engineering department experienced disproportionate attrition: 8 engineers departed during the quarter, yielding an annualized turnover rate of 18% against an industry benchmark of 12%. Exit interviews reveal three consistent themes: on-call burden, below-market compensation for senior roles, and limited career progression visibility.

## Quarterly Performance Review

The third quarter showed mixed results across our key performance indicators. Revenue grew 12% year-over-year, exceeding the target of 10%, driven primarily by expansion in the enterprise segment. Customer acquisition costs decreased by 8%, reflecting improvements in our inbound marketing funnel.

However, several metrics fell short of expectations. Net promoter score declined from 72 to 65, correlating with the service disruptions in August. Employee turnover in the engineering department reached 18%, well above the industry benchmark of 12%. These challenges, while not existential, require immediate attention.

### Key Findings

The revenue growth was not evenly distributed. The enterprise segment grew 23%, while the SMB segment contracted by 3%. This divergence suggests that our`,
    suffix: `

### Recommendations

Based on these findings, we propose three immediate actions:

1. **Invest in reliability engineering.** The August outages cost us approximately $2.3M in lost revenue and damaged customer trust. We recommend hiring three additional SREs and implementing a formal incident management process. Specifically, we propose adopting a tiered on-call rotation (primary and secondary) with guaranteed compensatory time off, deploying automated canary analysis for all production deployments, and establishing a formal post-incident review process with published findings. Target completion: end of Q4. Budget impact: $450K in annualized compensation plus $80K in tooling.

2. **Launch an SMB retention program.** The contraction in the SMB segment is driven by churn, not acquisition failure. Exit interviews indicate pricing and support responsiveness as the top concerns. We recommend introducing a "Growth" tier at a 20% discount to the current SMB price point, with reduced feature scope but guaranteed 4-hour support response times. Additionally, we propose assigning dedicated customer success managers to the top 50 SMB accounts by revenue, rather than the current pooled support model. Target launch: November 1. Budget impact: $120K in Q4 for CSM hiring, offset by projected churn reduction of $800K in ARR.

3. **Address engineering turnover.** Conduct stay interviews with high performers, benchmark compensation against current market rates, and reduce on-call burden through better automation. The compensation review should be completed within 30 days, with adjustments effective in the November payroll cycle. For on-call burden, we propose investing in automated alerting triage (estimated to reduce false-positive pages by 60%) and expanding the on-call rotation from 4 engineers to 8 by cross-training infrastructure knowledge. Target completion: end of Q4.

### Risk Assessment

The primary risk to Q4 performance is the compounding effect of the issues identified above. If engineering turnover continues at the current rate, our capacity to deliver the reliability improvements and SMB product changes will be constrained. We have identified this as a circular dependency and recommend prioritizing the compensation adjustment and on-call reduction as the highest-leverage interventions.

A secondary risk is enterprise segment concentration. With 62% of ARR now in enterprise accounts, the loss of any top-5 account would reduce ARR by 4-7%. We recommend establishing a formal strategic account program with executive sponsorship for each account exceeding $2M ARR.

### Next Steps

The executive team will review these recommendations at the October 22 leadership meeting. Department heads are asked to prepare implementation plans with resource requirements and dependencies by October 20. The Q4 operating plan will be updated to reflect approved initiatives by November 1.

### Appendix: Key Metrics Summary

| Metric | Q2 Actual | Q3 Target | Q3 Actual | Status |
|--------|-----------|-----------|-----------|--------|
| Revenue | $42.7M | $43.5M | $47.8M | Exceeded |
| MRR | $14.2M | $14.8M | $15.9M | Exceeded |
| NPS | 72 | 73 | 65 | Missed |
| Eng Turnover | 10% | < 12% | 18% | Missed |
| Gross Margin | 71% | 72% | 74% | Exceeded |`,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```', '### Recommendations'],
      quality_notes:
        'Mid-document insert with both prefix and suffix. Must bridge the analysis paragraph to the recommendations section. Business report voice.',
    },
  },
  {
    id: 'prose-medium-prefix-with-suffix',
    description: 'Medium prefix + medium suffix',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'guide.md',
    prefix:
      'When configuring the development environment, there are several important steps to follow. First, ensure that Node.js version 18 or later is installed. Second, clone the repository and run the setup script. The script will install dependencies and',
    suffix:
      ' Once the setup is complete, you can verify the installation by running the test suite, which should pass without errors.',
    saturation: { prefix: 'unsaturated', suffix: 'unsaturated' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Medium-length prefix and suffix. Completion should bridge between the setup description and the verification step. Instructional voice.',
    },
  },

  // ── Voice and register diversity ─────────────────────────────────

  {
    id: 'prose-formal-legal',
    description: 'Continue formal/legal document language',
    mode: 'prose',
    languageId: 'plaintext',
    fileName: 'terms-of-service.txt',
    prefix:
      'By accessing or using the Service, you agree to be bound by these Terms. If you do not agree to all the terms and conditions of this agreement, you may not access or use the Service. The Company reserves the right to modify these Terms at any time, and such modifications shall be effective immediately upon',
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```', '##'],
      quality_notes:
        'Formal legal register. Should continue with standard terms-of-service language about notification of changes or continued use constituting acceptance.',
    },
  },
  {
    id: 'prose-conversational-dialogue',
    description: 'Continue dialogue between characters',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'story.md',
    prefix:
      '"I told you this would happen," Maria said, setting her coffee down with more force than necessary.\n\nJames leaned back in his chair. "You told me a lot of things. Most of them turned out to be wrong."\n\n"Name one time I was wrong about something important."\n\nHe opened his mouth, then closed it. After a moment, he said, "',
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```', '##'],
      quality_notes:
        "Dialogue continuation. Should provide James's response in a natural conversational tone, staying in character with the established tension.",
    },
  },
  {
    id: 'prose-structured-inventory',
    description: 'Continue a structured inventory/specification list',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'inventory.md',
    prefix:
      '## Server Room Inventory\n\n**Rack A1:**\n- 2x Dell PowerEdge R750 (web servers, Ubuntu 22.04)\n- 1x Dell PowerEdge R650 (database primary, Ubuntu 22.04)\n- 1x Juniper EX4300 (ToR switch, 48-port)\n\n**Rack A2:**\n- 2x Dell PowerEdge R750 (application servers, Ubuntu 22.04)\n- 1x Synology RS3621xs+ (NAS, 12-bay, RAID 6)\n- ',
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Structured inventory list. Should continue with more rack items in the same format (count x model, parenthetical description).',
    },
  },
  {
    id: 'prose-journalistic-news',
    description: 'Continue a news article',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'article.md',
    prefix:
      'City council voted 7-2 Tuesday night to approve the controversial downtown redevelopment plan, ending months of heated public debate. The $340 million project will transform the former industrial waterfront into a mixed-use district with housing, retail, and public green space.\n\nMayor Patricia Chen called the vote "a turning point for our city," while opponents vowed to',
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```', '##'],
      quality_notes:
        "Journalistic news voice. Objective, third-person reporting. Should continue with the opponents' response or next steps.",
    },
  },
  {
    id: 'prose-instructional-recipe',
    description: 'Continue recipe/how-to instructions',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'recipe.md',
    prefix:
      "## Classic Sourdough Bread\n\n### Ingredients\n- 500g bread flour\n- 350g water (room temperature)\n- 100g active starter\n- 10g salt\n\n### Instructions\n\n1. Mix flour and water in a large bowl. Let rest for 30 minutes (autolyse).\n2. Add the starter and salt. Fold until fully incorporated.\n3. Over the next 4 hours, perform stretch-and-folds every 30 minutes. You'll notice the dough becoming",
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Recipe instructions in second-person imperative. Should continue describing dough development or the next step in the process.',
    },
  },
  {
    id: 'prose-reflective-journal',
    description: 'Continue a personal journal entry',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'journal.md',
    prefix:
      "January 15\n\nI've been thinking a lot about what Sarah said at dinner last week — that I spend so much time planning for the future that I forget to actually live in the present. She's probably right. I keep a task list for everything, even weekends. Even vacations. There's something comforting about the structure, but I'm starting to wonder if",
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```', '##'],
      quality_notes:
        'Intimate, reflective first-person journal voice. Should continue the introspective thought about over-planning and presence.',
    },
  },

  // ── Edge cases for prose ─────────────────────────────────────────

  {
    id: 'prose-mid-word',
    description: 'Prefix ends mid-word',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'draft.md',
    prefix: 'The team discussed the implementa',
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Prefix ends mid-word ("implementa"). Should complete the word (e.g., "implementation") and continue the sentence naturally.',
    },
  },
  {
    id: 'prose-after-heading',
    description: 'Prefix ends right after a markdown heading',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'doc.md',
    prefix: '## Error Handling\n\n',
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```', '##'],
      quality_notes:
        'Cursor right after a heading. Should begin a paragraph about error handling, not add another heading or list.',
    },
  },
  {
    id: 'prose-numbered-list-continuation',
    description: 'Continue a numbered list',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'steps.md',
    prefix:
      '## Migration Steps\n\n1. Back up the existing database\n2. Run the schema migration script\n3. Verify data integrity with the check tool\n4. ',
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Should continue with item 4 content (not "4." again since it is already in the prefix). Should be a logical next step in a migration process.',
    },
  },
];

// ─── CODE SCENARIOS ─────────────────────────────────────────────────

export const codeScenarios: TestScenario[] = [
  {
    id: 'code-ts-function-body',
    description: 'Complete a TypeScript function body',
    mode: 'code',
    languageId: 'typescript',
    fileName: 'utils.ts',
    prefix: 'function fibonacci(n: number): number {\n  if (n <= 1) return n;\n  ',
    suffix: '\n}',
    saturation: { prefix: 'unsaturated', suffix: 'unsaturated' },
    requirements: {
      must_include: ['return', 'fibonacci'],
      must_not_include: ['```', 'function fibonacci'],
      quality_notes: 'Should return recursive fibonacci call. Must be valid TypeScript.',
    },
  },
  {
    id: 'code-py-list-comprehension',
    description: 'Complete a Python list comprehension',
    mode: 'code',
    languageId: 'python',
    fileName: 'data.py',
    prefix: 'numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]\nevens = [x for x in numbers if ',
    suffix: ']\n',
    saturation: { prefix: 'unsaturated', suffix: 'unsaturated' },
    requirements: {
      must_not_include: ['```', 'def ', 'import'],
      quality_notes:
        'Should complete the filter condition for even numbers (x % 2 == 0 or similar).',
    },
  },
  {
    id: 'code-js-arrow-function',
    description: 'Complete a JavaScript arrow function',
    mode: 'code',
    languageId: 'javascript',
    fileName: 'handlers.js',
    prefix:
      "const users = await db.query('SELECT * FROM users WHERE active = true');\nconst userNames = users.map(user => ",
    suffix: ');\n',
    saturation: { prefix: 'unsaturated', suffix: 'unsaturated' },
    requirements: {
      must_not_include: ['```', 'const users'],
      quality_notes:
        'Should extract the name from user objects. Something like user.name or user.username.',
    },
  },
  {
    id: 'code-ts-interface',
    description: 'Complete a TypeScript interface definition',
    mode: 'code',
    languageId: 'typescript',
    fileName: 'types.ts',
    prefix: 'interface UserProfile {\n  id: string;\n  email: string;\n  ',
    suffix: '\n}',
    saturation: { prefix: 'unsaturated', suffix: 'unsaturated' },
    requirements: {
      must_not_include: ['```', 'interface'],
      quality_notes:
        'Should add more typical user profile fields (name, avatar, createdAt, etc.). Must use valid TypeScript type annotations.',
    },
  },
  {
    id: 'code-py-class-method',
    description: 'Complete a Python class method',
    mode: 'code',
    languageId: 'python',
    fileName: 'models.py',
    prefix:
      'class Stack:\n    def __init__(self):\n        self.items = []\n\n    def push(self, item):\n        ',
    suffix: '\n\n    def pop(self):\n        return self.items.pop()',
    saturation: { prefix: 'unsaturated', suffix: 'unsaturated' },
    requirements: {
      must_include: ['self.items'],
      must_not_include: ['```', 'class Stack', 'def pop'],
      quality_notes:
        'Should append item to self.items. Must be valid Python with correct indentation.',
    },
  },
  {
    id: 'code-rust-match',
    description: 'Complete a Rust match expression',
    mode: 'code',
    languageId: 'rust',
    fileName: 'parser.rs',
    prefix:
      'fn parse_token(token: &str) -> TokenType {\n    match token {\n        "+" => TokenType::Plus,\n        "-" => TokenType::Minus,\n        ',
    suffix: '\n    }\n}',
    saturation: { prefix: 'unsaturated', suffix: 'unsaturated' },
    requirements: {
      must_not_include: ['```', 'fn parse_token'],
      quality_notes:
        'Should add more match arms for common tokens (*, /, etc.) and possibly a wildcard. Valid Rust syntax.',
    },
  },
  {
    id: 'code-ts-error-handling',
    description: 'Complete error handling in TypeScript',
    mode: 'code',
    languageId: 'typescript',
    fileName: 'api.ts',
    prefix:
      'async function fetchUser(id: string): Promise<User | null> {\n  try {\n    const response = await fetch(`/api/users/${id}`);\n    ',
    suffix: '\n  } catch (err) {\n    console.error(err);\n    return null;\n  }\n}',
    saturation: { prefix: 'unsaturated', suffix: 'unsaturated' },
    requirements: {
      must_include: ['response'],
      must_not_include: ['```', 'async function fetchUser'],
      quality_notes: 'Should check response.ok, parse JSON, and return the user. Valid TypeScript.',
    },
  },
  {
    id: 'code-go-goroutine',
    description: 'Complete a Go goroutine pattern',
    mode: 'code',
    languageId: 'go',
    fileName: 'worker.go',
    prefix:
      'func processItems(items []string) []string {\n\tresults := make(chan string, len(items))\n\tfor _, item := range items {\n\t\tgo func(s string) {\n\t\t\t',
    suffix:
      '\n\t\t}(item)\n\t}\n\tclose(results)\n\tvar out []string\n\tfor r := range results {\n\t\tout = append(out, r)\n\t}\n\treturn out\n}',
    saturation: { prefix: 'unsaturated', suffix: 'unsaturated' },
    requirements: {
      must_include: ['results'],
      must_not_include: ['```', 'func processItems'],
      quality_notes: 'Should process the string and send result to the channel. Valid Go syntax.',
    },
  },
  {
    id: 'code-long-prefix-ts',
    description: 'Saturated TypeScript file context (4000+ prefix, 3000+ suffix)',
    mode: 'code',
    languageId: 'typescript',
    fileName: 'event-bus.ts',
    prefix: `import { EventEmitter } from 'events';

// ─── Utility Types ──────────────────────────────────────────────────

/** Deep readonly wrapper — prevents mutation of event payloads after emission. */
type DeepReadonly<T> = T extends (infer U)[]
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** Extract the union of payload types from an event map. */
type PayloadOf<M, K extends keyof M> = M[K];

/** Branded type for correlation IDs used in event tracing. */
type CorrelationId = string & { readonly __brand: 'CorrelationId' };

function createCorrelationId(): CorrelationId {
  return \`evt_\${Date.now()}_\${Math.random().toString(36).slice(2, 8)}\` as CorrelationId;
}

// ─── Event Metadata ─────────────────────────────────────────────────

interface EventMetadata {
  /** Unique correlation ID for distributed tracing. */
  correlationId: CorrelationId;
  /** ISO 8601 timestamp of when the event was emitted. */
  timestamp: string;
  /** Name of the service or module that emitted the event. */
  source: string;
}

interface EventEnvelope<T = unknown> {
  metadata: EventMetadata;
  payload: T;
}

// ─── Logging ────────────────────────────────────────────────────────

interface EventBusLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: Error, context?: Record<string, unknown>): void;
}

const noopLogger: EventBusLogger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
};

// ─── Event Map and Core Types ───────────────────────────────────────

interface EventMap {
  'user:created': { id: string; email: string; createdAt: Date };
  'user:updated': { id: string; changes: Record<string, unknown> };
  'user:deleted': { id: string; reason: string };
  'order:placed': { orderId: string; userId: string; total: number };
  'order:shipped': { orderId: string; trackingNumber: string };
  'order:delivered': { orderId: string; deliveredAt: Date };
}

type EventName = keyof EventMap;
type EventHandler<T extends EventName> = (payload: EventMap[T]) => void | Promise<void>;

interface Subscription {
  event: EventName;
  handler: EventHandler<any>;
  once: boolean;
}

interface EventBusOptions {
  logger?: EventBusLogger;
  source?: string;
  maxListeners?: number;
}

class TypedEventBus {
  private emitter = new EventEmitter();
  private subscriptions: Subscription[] = [];
  private middlewares: Array<(event: EventName, payload: unknown) => unknown> = [];
  private readonly logger: EventBusLogger;
  private readonly source: string;

  constructor(options: EventBusOptions = {}) {
    this.logger = options.logger ?? noopLogger;
    this.source = options.source ?? 'unknown';
    if (options.maxListeners !== undefined) {
      this.emitter.setMaxListeners(options.maxListeners);
    }
  }

  /**
   * Register a handler for a specific event type.
   * Returns an unsubscribe function.
   */
  on<T extends EventName>(event: T, handler: EventHandler<T>): () => void {
    this.emitter.on(event, handler as any);
    const sub: Subscription = { event, handler, once: false };
    this.subscriptions.push(sub);
    return () => {
      this.emitter.off(event, handler as any);
      this.subscriptions = this.subscriptions.filter(s => s !== sub);
    };
  }

  once<T extends EventName>(event: T, handler: EventHandler<T>): void {
    this.emitter.once(event, handler as any);
    this.subscriptions.push({ event, handler, once: true });
  }

  use(middleware: (event: EventName, payload: unknown) => unknown): void {
    this.middlewares.push(middleware);
  }

  async emit<T extends EventName>(event: T, payload: EventMap[T]): Promise<void> {
    let processed = payload as unknown;
    for (const mw of this.middlewares) {
      processed = mw(event, processed);
    }
    this.emitter.emit(event, processed);
    // Clean up one-time subscriptions
    this.subscriptions = this.subscriptions.filter(s => !(s.event === event && s.once));
  }

  /**
   * Wait for a specific event to fire, with an optional timeout.
   */
  waitFor<T extends EventName>(event: T, timeoutMs?: number): Promise<EventMap[T]> {
    return new Promise((resolve, reject) => {
      `,
    suffix: `
    });
  }

  removeAllListeners(event?: EventName): void {
    if (event) {
      this.emitter.removeAllListeners(event);
      this.subscriptions = this.subscriptions.filter(s => s.event !== event);
    } else {
      this.emitter.removeAllListeners();
      this.subscriptions = [];
    }
  }

  /**
   * Returns the number of listeners registered for a specific event,
   * or the total number of listeners across all events if no event is specified.
   */
  listenerCount(event?: EventName): number {
    if (event) {
      return this.subscriptions.filter(s => s.event === event).length;
    }
    return this.subscriptions.length;
  }

  /**
   * Returns an array of event names that have at least one listener registered.
   */
  activeEvents(): EventName[] {
    const events = new Set<EventName>();
    for (const sub of this.subscriptions) {
      events.add(sub.event);
    }
    return Array.from(events);
  }

  /**
   * Pipe all events from this bus to another bus. Useful for creating
   * hierarchical event architectures where child buses bubble events up.
   */
  pipe(target: TypedEventBus): () => void {
    const unsubscribers: Array<() => void> = [];
    const allEvents: EventName[] = [
      'user:created',
      'user:updated',
      'user:deleted',
      'order:placed',
      'order:shipped',
      'order:delivered',
    ];
    for (const event of allEvents) {
      const unsub = this.on(event, (payload: any) => {
        target.emit(event, payload);
      });
      unsubscribers.push(unsub);
    }
    return () => {
      for (const unsub of unsubscribers) {
        unsub();
      }
    };
  }

  /**
   * Create a child bus that inherits middlewares from the parent.
   * Events emitted on the child do not propagate to the parent unless piped.
   */
  createChild(options: Omit<EventBusOptions, 'logger'> = {}): TypedEventBus {
    const child = new TypedEventBus({ ...options, logger: this.logger });
    for (const mw of this.middlewares) {
      child.use(mw);
    }
    return child;
  }

  /**
   * Dispose of the event bus, removing all listeners and clearing internal state.
   */
  dispose(): void {
    this.removeAllListeners();
    this.middlewares.length = 0;
    this.logger.debug('Event bus disposed', { source: this.source });
  }
}

// ─── Factory and Convenience Exports ────────────────────────────────

function createEventBus(options?: EventBusOptions): TypedEventBus {
  return new TypedEventBus(options);
}

export { TypedEventBus, EventMap, EventName, EventBusOptions, EventBusLogger };
export { createEventBus, createCorrelationId };
export type { EventEnvelope, EventMetadata, DeepReadonly, CorrelationId };

// ─── Default Event Handlers ─────────────────────────────────────────

/**
 * Logging middleware that records every event emission to the provided logger.
 * Attach via \`bus.use(createLoggingMiddleware(logger))\`.
 */
function createLoggingMiddleware(
  logger: EventBusLogger,
): (event: EventName, payload: unknown) => unknown {
  return (event, payload) => {
    logger.debug(\`Event emitted: \${event}\`, { payload });
    return payload;
  };
}

/**
 * Validation middleware that ensures payloads are plain objects.
 * Rejects primitives and arrays to catch common caller mistakes.
 */
function createValidationMiddleware(): (event: EventName, payload: unknown) => unknown {
  return (_event, payload) => {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new TypeError(\`Event payload must be a plain object, got \${typeof payload}\`);
    }
    return payload;
  };
}

export { createLoggingMiddleware, createValidationMiddleware };`,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```', 'class TypedEventBus'],
      quality_notes:
        'Long TypeScript context. Should implement the waitFor body: register a once listener that resolves, and optionally set a timeout that rejects. Valid TypeScript.',
    },
  },
  {
    id: 'code-html-tag',
    description: 'Complete an HTML tag in the middle of markup',
    mode: 'code',
    languageId: 'html',
    fileName: 'index.html',
    prefix:
      '<nav class="main-nav">\n  <ul>\n    <li><a href="/">Home</a></li>\n    <li><a href="/about">About</a></li>\n    <li><a href="',
    suffix: '</a></li>\n  </ul>\n</nav>',
    saturation: { prefix: 'unsaturated', suffix: 'unsaturated' },
    requirements: {
      must_not_include: ['```', '<nav', '<ul>'],
      quality_notes:
        'Should complete the href value and link text for a navigation item. Valid HTML.',
    },
  },
];

// ─── EDGE CASE SCENARIOS ────────────────────────────────────────────

export const edgeCaseScenarios: TestScenario[] = [
  {
    id: 'edge-empty-suffix-code',
    description: 'Code completion at end of file (no suffix)',
    mode: 'code',
    languageId: 'typescript',
    fileName: 'index.ts',
    prefix:
      "import express from 'express';\n\nconst app = express();\n\napp.get('/health', (req, res) => {\n  ",
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```', 'import express'],
      quality_notes:
        'Should return a health check response. No suffix means end-of-file completion.',
    },
  },
  {
    id: 'edge-short-prefix',
    description: 'Prose with a short but viable prefix',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'draft.md',
    prefix: 'However, the results suggest that',
    suffix: '',
    saturation: { prefix: 'unsaturated', suffix: 'none' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Short prefix but enough context for continuation. Should produce a coherent sentence completing the thought.',
    },
  },
];

// ─── REUSE QUALITY SCENARIOS ─────────────────────────────────────────
//
// These scenarios are run through a shared provider that has already
// served several completions on the same slot. They test whether
// quality degrades when the session has accumulated prior context.
//
// The "priming" completions are simple throwaway requests. The reuse
// scenarios below are the ones that get quality-judged in Layer 2.

/** Simple contexts used to "prime" the slot before the real scenarios. */
export const reusePrimingContexts: Array<{
  prefix: string;
  suffix: string;
  languageId: string;
  fileName: string;
  mode: 'prose' | 'code';
}> = [
  {
    prefix: 'The sun was setting over the',
    suffix: '',
    languageId: 'markdown',
    fileName: 'notes.md',
    mode: 'prose',
  },
  {
    prefix: 'function double(n) { return ',
    suffix: ' }',
    languageId: 'javascript',
    fileName: 'math.js',
    mode: 'code',
  },
  {
    prefix: 'The primary benefit of caching is',
    suffix: '',
    languageId: 'markdown',
    fileName: 'doc.md',
    mode: 'prose',
  },
  {
    prefix: 'const sorted = items.sort((a, b) => ',
    suffix: ');\n',
    languageId: 'typescript',
    fileName: 'utils.ts',
    mode: 'code',
  },
  {
    prefix: 'In conclusion, the evidence strongly suggests that',
    suffix: '',
    languageId: 'markdown',
    fileName: 'essay.md',
    mode: 'prose',
  },
];

/** Scenarios run after priming — these get Layer 2 evaluation. */
export const reuseQualityScenarios: TestScenario[] = [
  {
    id: 'reuse-prose-after-priming',
    description: 'Prose completion after 5 prior completions on the same slot',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'article.md',
    prefix:
      'The research team published their findings in the March issue of the journal. Their most surprising discovery was that',
    suffix: ' This finding contradicts decades of conventional wisdom in the field.',
    saturation: { prefix: 'unsaturated', suffix: 'unsaturated' },
    requirements: {
      must_not_include: ['```', '##'],
      quality_notes:
        'This scenario runs on a slot that has already served 5 completions. Quality should be indistinguishable from a fresh slot. Should bridge naturally between prefix and suffix with a plausible scientific finding.',
    },
  },
  {
    id: 'reuse-code-after-priming',
    description: 'Code completion after 5 prior completions on the same slot',
    mode: 'code',
    languageId: 'typescript',
    fileName: 'handlers.ts',
    prefix:
      'async function validateInput(data: unknown): Promise<boolean> {\n  if (typeof data !== "object" || data === null) return false;\n  ',
    suffix: '\n}',
    saturation: { prefix: 'unsaturated', suffix: 'unsaturated' },
    requirements: {
      must_not_include: ['```', 'async function validateInput'],
      quality_notes:
        'This scenario runs on a slot that has already served 5 completions. Quality should be indistinguishable from a fresh slot. Should add validation logic (type checks, field checks, etc.). Valid TypeScript.',
    },
  },
];
