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
    prefix: 'The old lighthouse keeper climbed the spiral staircase for what felt like the thousandth time. The wind howled outside, rattling the',
    suffix: '',
    requirements: {
      must_not_include: ['```', '##', '- ', '* '],
      quality_notes: 'Should complete the sentence naturally, then possibly add one more. Atmospheric/narrative tone.',
    },
  },
  {
    id: 'prose-technical-writing',
    description: 'Continue technical documentation',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'README.md',
    prefix: 'The configuration file supports three output formats: JSON, YAML, and TOML. Each format has specific advantages depending on your',
    suffix: '',
    requirements: {
      must_include: ['format'],
      must_not_include: ['```', 'import', 'const'],
      quality_notes: 'Technical documentation tone. Should discuss use cases or tradeoffs of the formats.',
    },
  },
  {
    id: 'prose-casual-blog',
    description: 'Continue a casual blog post',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'blog-post.md',
    prefix: "I've been using Neovim for about six months now, and honestly, the learning curve was brutal. But once you get past the initial",
    suffix: '',
    requirements: {
      must_not_include: ['```', '##'],
      quality_notes: 'Casual, first-person blog voice. Should continue the thought about the learning curve.',
    },
  },
  {
    id: 'prose-mid-paragraph-with-suffix',
    description: 'Insert prose in the middle of a paragraph',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'essay.md',
    prefix: 'The industrial revolution transformed not just manufacturing, but the entire social fabric of European society. Workers migrated from',
    suffix: ' This mass migration created entirely new urban challenges that city planners had never faced before.',
    requirements: {
      must_not_include: ['```'],
      quality_notes: 'Must bridge naturally between prefix and suffix. Academic/formal tone. Should mention rural-to-urban migration or similar.',
    },
  },
  {
    id: 'prose-plaintext-email',
    description: 'Continue a plaintext email',
    mode: 'prose',
    languageId: 'plaintext',
    fileName: 'draft.txt',
    prefix: "Hi Sarah,\n\nThanks for sending over the Q3 report. I've reviewed the numbers and have a few questions about the",
    suffix: '',
    requirements: {
      must_not_include: ['```', '##', 'Dear', 'Sincerely'],
      quality_notes: 'Professional but friendly email tone. Should continue asking about specific aspects of a report.',
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
      quality_notes: 'Even with minimal context, should produce something coherent. Generic but grammatically sound.',
    },
  },
  {
    id: 'prose-latex-academic',
    description: 'Continue academic writing in LaTeX',
    mode: 'prose',
    languageId: 'latex',
    fileName: 'paper.tex',
    prefix: 'The experimental results demonstrate a statistically significant correlation between the two variables ($p < 0.01$). Furthermore, the effect size suggests that',
    suffix: '',
    requirements: {
      must_not_include: ['```python', '```javascript', '##'],
      quality_notes: 'Academic voice. May include LaTeX math notation. Should discuss the practical significance or implications of the finding.',
    },
  },
  {
    id: 'prose-list-continuation',
    description: 'Continue after a bullet point list',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'design-doc.md',
    prefix: "## Design Considerations\n\n- Latency must be under 200ms for 95th percentile\n- The system should handle at least 10k concurrent connections\n- Data consistency is more important than availability\n\nGiven these constraints,",
    suffix: '',
    requirements: {
      must_not_include: ['```'],
      quality_notes: 'Should continue the prose paragraph that follows the bullet list. Technical design document voice.',
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
      quality_notes: 'Should complete the filter condition for even numbers (x % 2 == 0 or similar).',
    },
  },
  {
    id: 'code-js-arrow-function',
    description: 'Complete a JavaScript arrow function',
    mode: 'code',
    languageId: 'javascript',
    fileName: 'handlers.js',
    prefix: "const users = await db.query('SELECT * FROM users WHERE active = true');\nconst userNames = users.map(user => ",
    suffix: ');\n',
    requirements: {
      must_not_include: ['```', 'const users'],
      quality_notes: 'Should extract the name from user objects. Something like user.name or user.username.',
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
      quality_notes: 'Should add more typical user profile fields (name, avatar, createdAt, etc.). Must use valid TypeScript type annotations.',
    },
  },
  {
    id: 'code-py-class-method',
    description: 'Complete a Python class method',
    mode: 'code',
    languageId: 'python',
    fileName: 'models.py',
    prefix: 'class Stack:\n    def __init__(self):\n        self.items = []\n\n    def push(self, item):\n        ',
    suffix: '\n\n    def pop(self):\n        return self.items.pop()',
    requirements: {
      must_include: ['self.items'],
      must_not_include: ['```', 'class Stack', 'def pop'],
      quality_notes: 'Should append item to self.items. Must be valid Python with correct indentation.',
    },
  },
  {
    id: 'code-rust-match',
    description: 'Complete a Rust match expression',
    mode: 'code',
    languageId: 'rust',
    fileName: 'parser.rs',
    prefix: 'fn parse_token(token: &str) -> TokenType {\n    match token {\n        "+" => TokenType::Plus,\n        "-" => TokenType::Minus,\n        ',
    suffix: '\n    }\n}',
    requirements: {
      must_not_include: ['```', 'fn parse_token'],
      quality_notes: 'Should add more match arms for common tokens (*, /, etc.) and possibly a wildcard. Valid Rust syntax.',
    },
  },
  {
    id: 'code-ts-error-handling',
    description: 'Complete error handling in TypeScript',
    mode: 'code',
    languageId: 'typescript',
    fileName: 'api.ts',
    prefix: "async function fetchUser(id: string): Promise<User | null> {\n  try {\n    const response = await fetch(`/api/users/${id}`);\n    ",
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
    prefix: 'func processItems(items []string) []string {\n\tresults := make(chan string, len(items))\n\tfor _, item := range items {\n\t\tgo func(s string) {\n\t\t\t',
    suffix: '\n\t\t}(item)\n\t}\n}',
    requirements: {
      must_include: ['results'],
      must_not_include: ['```', 'func processItems'],
      quality_notes: 'Should process the string and send result to the channel. Valid Go syntax.',
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
    prefix: "import express from 'express';\n\nconst app = express();\n\napp.get('/health', (req, res) => {\n  ",
    suffix: '',
    requirements: {
      must_not_include: ['```', 'import express'],
      quality_notes: 'Should return a health check response. No suffix means end-of-file completion.',
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
      quality_notes: 'Short prefix but enough context for continuation. Should produce a coherent sentence completing the thought.',
    },
  },
];