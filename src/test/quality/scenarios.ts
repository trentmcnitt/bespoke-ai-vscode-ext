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
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Should continue the prose paragraph that follows the bullet list. Technical design document voice.',
    },
  },

  // ── Context size variations ──────────────────────────────────────

  {
    id: 'prose-long-prefix-narrative',
    description: 'Long narrative context (~2000 chars)',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'novel-chapter.md',
    prefix: `The village of Thornfield sat at the edge of the moors, where the heather turned purple in late summer and the wind never quite stopped blowing. Eleanor had lived there all her life, first in her parents' cottage near the church, then in the larger house she and David had built the year after their wedding. She knew every stone wall, every sheep path, every place where the stream pooled deep enough for trout.

But on that particular Tuesday morning, standing at her kitchen window with a cup of tea going cold in her hands, the village looked different. Not in any way she could point to — the church spire still rose above the yew trees, the postman's red van was making its usual rounds, and Mrs. Gallagher was walking her terrier along the lane. Everything was exactly as it should have been, and yet something fundamental had shifted.

She set down the cup and reached for her coat. The letter from the solicitor was still in her pocket, where she had shoved it yesterday after reading it twice. David's brother, whom they hadn't heard from in eleven years, had died in a hospital in Melbourne. He had left everything to Eleanor — not to David, but to Eleanor specifically. The solicitor's careful phrasing couldn't disguise the oddness of it.

The walk to the post office took seven minutes. Eleanor used every one of them trying to decide what to tell Margaret behind the counter, who would certainly ask why she looked`,
    suffix: '',
    requirements: {
      must_not_include: ['```', '##', '- '],
      quality_notes:
        'Long narrative context. Should continue naturally with the scene, maintaining third-person past tense and the literary tone.',
    },
  },
  {
    id: 'prose-long-prefix-technical',
    description: 'Long technical documentation context (~2000 chars)',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'architecture.md',
    prefix: `## Event Sourcing Architecture

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
    suffix: '',
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Long technical doc. Should continue the sentence about idempotency and projection guarantees. Maintain the formal technical documentation voice.',
    },
  },
  {
    id: 'prose-long-both',
    description: 'Long prefix + long suffix (mid-document insert)',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'report.md',
    prefix: `## Quarterly Performance Review

The third quarter showed mixed results across our key performance indicators. Revenue grew 12% year-over-year, exceeding the target of 10%, driven primarily by expansion in the enterprise segment. Customer acquisition costs decreased by 8%, reflecting improvements in our inbound marketing funnel.

However, several metrics fell short of expectations. Net promoter score declined from 72 to 65, correlating with the service disruptions in August. Employee turnover in the engineering department reached 18%, well above the industry benchmark of 12%. These challenges, while not existential, require immediate attention.

### Key Findings

The revenue growth was not evenly distributed. The enterprise segment grew 23%, while the SMB segment contracted by 3%. This divergence suggests that our`,
    suffix: `

### Recommendations

Based on these findings, we propose three immediate actions:

1. **Invest in reliability engineering.** The August outages cost us approximately $2.3M in lost revenue and damaged customer trust. We recommend hiring three additional SREs and implementing a formal incident management process.

2. **Launch an SMB retention program.** The contraction in the SMB segment is driven by churn, not acquisition failure. Exit interviews indicate pricing and support responsiveness as the top concerns.

3. **Address engineering turnover.** Conduct stay interviews with high performers, benchmark compensation against current market rates, and reduce on-call burden through better automation.`,
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
    suffix: '\n\t\t}(item)\n\t}\n}',
    requirements: {
      must_include: ['results'],
      must_not_include: ['```', 'func processItems'],
      quality_notes: 'Should process the string and send result to the channel. Valid Go syntax.',
    },
  },
  {
    id: 'code-long-prefix-ts',
    description: 'Long TypeScript file context (~3000 chars prefix)',
    mode: 'code',
    languageId: 'typescript',
    fileName: 'event-bus.ts',
    prefix: `import { EventEmitter } from 'events';

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

class TypedEventBus {
  private emitter = new EventEmitter();
  private subscriptions: Subscription[] = [];
  private middlewares: Array<(event: EventName, payload: unknown) => unknown> = [];

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
}

export { TypedEventBus, EventMap, EventName };`,
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
    requirements: {
      must_not_include: ['```', 'async function validateInput'],
      quality_notes:
        'This scenario runs on a slot that has already served 5 completions. Quality should be indistinguishable from a fresh slot. Should add validation logic (type checks, field checks, etc.). Valid TypeScript.',
    },
  },
];
