# AI Inline Completion Prompt Template Research

Research compiled 2026-01-30. This document captures exact prompt templates, prompt engineering patterns, and anchoring techniques from open-source AI code/text completion tools.

---

## Table of Contents

1. [Exact FIM Prompt Templates by Model Family](#1-exact-fim-prompt-templates-by-model-family)
2. [Tool-Specific Prompt Architectures](#2-tool-specific-prompt-architectures)
3. [Prompt Engineering Best Practices for Inline Completion](#3-prompt-engineering-best-practices-for-inline-completion)
4. [Anchoring Completions Without Native Assistant Prefill](#4-anchoring-completions-without-native-assistant-prefill)
5. [Novel Approaches and Patterns](#5-novel-approaches-and-patterns)
6. [Academic Research on FIM and Prompt Design](#6-academic-research-on-fim-and-prompt-design)
7. [Sources](#7-sources)

---

## 1. Exact FIM Prompt Templates by Model Family

These are the exact Fill-in-the-Middle prompt templates used by open-source tools, primarily sourced from Continue.dev's [`AutocompleteTemplate.ts`](https://github.com/continuedev/continue/blob/main/core/autocomplete/templating/AutocompleteTemplate.ts).

### StarCoder / Stable Code

```
<fim_prefix>{prefix}<fim_suffix>{suffix}<fim_middle>
```

Stop tokens: `<fim_prefix>`, `<fim_suffix>`, `<fim_middle>`, `<|endoftext|>`

### Qwen Coder / Granite-4

```
<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>
```

Stop tokens: `<|endoftext|>`, `<|fim_pad|>`, `<|repo_name|>`, `<|file_sep|>`

### CodeLlama

```
<PRE> {prefix} <SUF>{suffix} <MID>
```

Stop tokens: `<PRE>`, `<SUF>`, `<MID>`, `<EOT>`

### DeepSeek Coder

```
<｜fim▁begin｜>{prefix}<｜fim▁hole｜>{suffix}<｜fim▁end｜>
```

Note: DeepSeek uses non-standard Unicode characters (`｜` fullwidth vertical bar U+FF5C and `▁` lower one eighth block U+2581).

### Codestral (Mistral)

```
[SUFFIX]{suffix}[PREFIX]{prefix}
```

Stop tokens: `[PREFIX]`, `[SUFFIX]`

Note: Codestral reverses the typical order, placing suffix before prefix.

### CodeGeeX

Uses a structured format with file metadata:

```
###PATH:{filename}
###LANGUAGE:{language}
###MODE:BLOCK
<|code_suffix|>{suffix}<|code_prefix|>{prefix}<|code_middle|>
```

### GPT/Claude (Chat Models for FIM)

Continue.dev uses a fill-in-blank format for chat models that lack native FIM training:

```
{prefix}[BLANK]{suffix}
```

The instruction asks the model to replace `[BLANK]` with the appropriate completion.

### DeepSeek FIM via API

When using the DeepSeek hosted API (OpenAI-compatible), FIM uses explicit `prompt` and `suffix` parameters rather than special tokens:

```python
response = client.completions.create(
    model="deepseek-chat",
    prompt="def fib(a):",
    suffix="    return fib(a-1) + fib(a-2)",
    max_tokens=128
)
```

Source: [DeepSeek FIM API Docs](https://api-docs.deepseek.com/guides/fim_completion)

### Tabby Configuration

Tabby lets users configure FIM templates per backend in `config.toml`:

```toml
[model.completion.http]
kind = "llama.cpp/completion"
model_name = "your_model"
api_endpoint = "http://localhost:8081"
prompt_template = "<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>"
```

Source: [Tabby Model Configuration](https://tabby.tabbyml.com/docs/administration/model/)

---

## 2. Tool-Specific Prompt Architectures

### Sourcegraph Cody

Cody's completion pipeline has four stages: Planning, Retrieval, Generation, Post-processing. Key prompt engineering details from their [lifecycle blog post](https://sourcegraph.com/blog/the-lifecycle-of-a-code-ai-completion):

**XML tag formatting for Claude:** Cody uses XML tags rather than markdown backticks for code segments in prompts. Per Anthropic's guidance, "Claude has been fine tuned to pay special attention to the structure created by XML tags."

**Whitespace trimming:** "Including whitespace at the end of the prompt would cause significantly worse responses." Cody trims trailing whitespace from prompts and compensates during post-processing.

**Prompt priming (putting words in Claude's mouth):** Cody uses assistant prefill to anchor completions. For example, completing `console.log(|` would include an assistant prefix like:

```
Sure! Here is the completion:<code>console.log(
```

This "lays words in Claude's mouth by omitting information in the initial question and then leading with this in the assistant prompt."

**Context retrieval:** Uses sliding-window Jaccard similarity search on recently-edited files, constrained to under 1 second total retrieval time.

**Post-processing:**
- Levenshtein edit distance to detect and filter completions that repeat previously-written lines
- Indentation-based truncation for multi-line completions
- Tree-sitter syntax validation to devalue completions with syntax errors
- LLM probability scores to rank candidate completions

### GitHub Copilot

Copilot uses a client-server architecture with custom FIM-trained models. Key details from [GitHub's blog on custom completions models](https://github.blog/ai-and-ml/github-copilot/the-road-to-better-completions-building-a-faster-smarter-github-copilot-with-a-new-custom-model/):

- Models are "specialized in completions by way of synthetic fine-tuning to behave like a great FIM engine"
- Training uses "span infillings and docstring/function pairs" mixed with next-token prediction
- A custom reinforcement learning algorithm rewards: syntax validity/style adherence, contextual relevance, and API modernity
- Early RL versions suffered "reward hacking" (over-optimizing for length), requiring "comment guardrails"
- Context harvesting includes current file, imported libraries, and open tabs
- Post-processing includes safety filters for harmful content and public code matching

### Continue.dev

Continue.dev strongly recommends purpose-built FIM models over chat models:

> "Continue does not recommend using GPT or Claude for autocomplete. The suggested autocomplete models are trained with a highly specific prompt format for completing code, and commercial models like GPT-4 or Claude are not trained with this format, meaning they won't generate useful completions."

Recommended models: `starcoder2:3b`, `deepseek-coder:1.3b-base`, `deepseek-coder:6.7b-base`

Template is auto-selected by model name. Users can override via:

```json
{
  "tabAutocompleteModel": {
    "model": "deepseek-coder:6.7b-base",
    "template": "<|fim_prefix|>{{{prefix}}}<|fim_suffix|>{{{suffix}}}<|fim_middle|>"
  }
}
```

Source: [Continue.dev Autocomplete How It Works](https://docs.continue.dev/autocomplete/how-it-works)

### JetBrains (Mellum)

JetBrains built a custom 4B parameter "focal model" specifically for code completion:

- Uses FIM with **semantically meaningful boundaries** (function bodies, loop bodies) rather than random spans
- Middle chunk limited to 700 characters
- Context collection uses three strategies: IoU similarity, path distance (BFS directory traversal), and RAG (BPE-level semantic matching)
- Post-processing includes semantic scope truncation
- Trained with DPO to suppress verbose/unhelpful completions

Source: [Mellum Paper](https://arxiv.org/html/2510.05788v1), [JetBrains AI Blog](https://blog.jetbrains.com/ai/2025/04/mellum-how-we-trained-a-model-to-excel-in-code-completion/)

### JetBrains Full Line Code Completion (IDE-native)

JetBrains' IDE-integrated completion has notable post-processing:

- Syntactic and semantic correctness checks per language
- Unresolved reference filtering (won't suggest non-existent variables/methods)
- Smart filtering to avoid suggestions that users tend to cancel or delete
- Parenthesis balancing
- Seamless overtyping (ghost text doesn't blink while you type)
- Computation delay to prevent accidental acceptance

Source: [JetBrains Blog](https://blog.jetbrains.com/blog/2024/04/04/full-line-code-completion-in-jetbrains-ides-all-you-need-to-know/)

### Supermaven

Supermaven uses a completely novel approach:

- Custom neural network architecture called "Babble" (not a transformer)
- 1 million token context window
- **Edit-based context** rather than file-based: sees the sequence of edits (like `git diff`) rather than file contents
- Latency target ~250ms
- Small model philosophy: "everyone must use a small model to remain profitable"

Source: [Supermaven Blog](https://supermaven.com/blog/introducing-supermaven)

### Codeium / Windsurf

Codeium uses a multi-stage pipeline:

1. **ContextModule** -- determines relevant inputs and state to present to the LLM
2. **Reranking** -- uses precomputed embeddings to rank contextual snippets by importance
3. **Prompt building** -- crafts prompts with reranked context

Source: [Zack Proser Analysis](https://zackproser.com/blog/codeium-analysis-4-2024)

---

## 3. Prompt Engineering Best Practices for Inline Completion

### Prompt Construction

1. **Trim trailing whitespace from prompts.** Sourcegraph found that "whitespace at the end of the prompt would cause significantly worse responses." This is one of the most impactful micro-optimizations.

2. **Use XML tags instead of markdown for Claude.** Anthropic's models respond better to XML-structured prompts than markdown backticks for delineating code sections.

3. **Include both prefix and suffix context.** FIM dramatically improves completion quality over prefix-only. Without suffix context, "the LLM would often repeat code already in the next line."

4. **Rank and filter context aggressively.** "Adding irrelevant context can make response quality worse" (Sourcegraph). Use Jaccard similarity, BM25, or embeddings to select only the most relevant context snippets.

5. **Use language/filename metadata.** CodeGeeX and other tools include `###PATH:` and `###LANGUAGE:` markers. This helps the model adapt completions to the correct language and conventions.

### Generation Parameters

6. **Low temperature (0.1-0.3) for completions.** One practitioner recommends temperature 0.2, noting anything above 0.25 risks hallucination. This is well below typical chat temperatures.

7. **Use language-specific stop tokens.** Beyond model-specific FIM stop tokens, add language-appropriate stops like `"; "` and `"} "` for TypeScript, or `\n\n` for prose.

8. **Limit max tokens aggressively.** 64-200 tokens is typical. Tabby defaults to `max_decoding_tokens = 64`. Shorter limits reduce latency and error accumulation.

9. **Consider different models for single-line vs multi-line.** Sourcegraph uses faster models for single-line and higher-quality models for multi-line: "if a user is willing to wait longer for a multi-line request, it usually is worth it to increase latency slightly in favor of quality."

### Post-Processing

10. **Detect and remove prefix overlap.** When the model echoes text already on the current line, strip it. Cody uses Levenshtein distance; simpler implementations use exact prefix matching.

11. **Detect and remove suffix overlap.** When the completion's tail duplicates the document's suffix, trim it.

12. **Use syntax-aware truncation.** Tree-sitter or similar parsers can identify block boundaries and prevent completions from exceeding the current scope.

13. **Filter syntactically invalid completions.** JetBrains runs per-language correctness checks. Cody uses Tree-sitter to "devalue completions with syntax errors."

14. **Use indentation-based truncation.** For multi-line completions, stop when indentation returns to or exceeds the starting level, suggesting the current block is complete.

### Architecture

15. **Debounce aggressively (200-400ms).** Wait until the user stops typing before making a request. Continue.dev and most tools use this pattern.

16. **Cache completions.** LRU caches prevent redundant API calls when the user backtracks or re-visits a position.

17. **Use streaming for early termination.** Stream completions so you can abort early if the content exceeds scope boundaries or fails quality checks.

---

## 4. Anchoring Completions Without Native Assistant Prefill

This is the core challenge for using chat models (like Claude) as completion engines. Chat models want to produce conversational responses, not raw text continuations. Several techniques exist to solve this:

### Technique 1: Assistant Prefill (Anthropic-specific)

The most direct approach, supported natively by Claude's API. Prefill the assistant message with the text the model should continue from:

```json
{
  "messages": [
    {"role": "user", "content": "Complete the following text..."},
    {"role": "assistant", "content": "Here is the completion: the last few words of the prefix"}
  ]
}
```

The model continues from where the assistant message left off. This is what Bespoke AI currently uses for prose mode (seeding with the last 4 words).

**Limitation:** Not available with extended thinking mode. Not supported by OpenAI or most other providers.

Source: [Anthropic Prefill Docs](https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prefill-claudes-response)

### Technique 2: Cody's "Words in Claude's Mouth" Pattern

Sourcegraph extends the basic prefill by splitting context between the user and assistant messages:

- **User message:** Provides the code context but omits some information
- **Assistant message:** Starts with a response frame like `Sure! Here is the completion:<code>` followed by the prefix text up to the cursor

This creates a strong anchor: the model continues the code rather than generating a conversational response.

Source: [Sourcegraph Lifecycle Blog](https://sourcegraph.com/blog/the-lifecycle-of-a-code-ai-completion)

### Technique 3: Instruction + Stop Token Boundary

For providers that don't support prefill (OpenAI, most cloud APIs):

```
System: You are a code completion engine. Output ONLY the code that should
appear at the cursor position. Do not include explanations, markdown formatting,
or code fences. Do not repeat code that already exists before or after the cursor.

User: Complete the code at the [CURSOR] position. Output only the missing code.

File: example.ts
```python
function greet(name: string) {
    const message = [CURSOR]
    return message;
}
```

The key constraints are:
- Explicit instruction to output only raw code (no explanations, no fences)
- Stop sequences that terminate generation at scope boundaries
- Post-processing to strip any preamble the model adds despite instructions

### Technique 4: Fill-in-Blank with Chat Models

Continue.dev's approach for GPT/Claude when used as autocomplete:

```
{prefix}[BLANK]{suffix}
```

Combined with a system instruction to replace `[BLANK]` with the appropriate completion. This is the simplest approach but least reliable with chat models.

### Technique 5: FIM-Trained Completion Models (Avoid Chat Models Entirely)

The strongest consensus across all tools surveyed: **don't use chat models for autocomplete**. Purpose-built FIM models dramatically outperform chat models at inline completion:

- Continue.dev explicitly recommends against GPT/Claude for autocomplete
- JetBrains built their own 4B model (Mellum) because "typical chat LLMs proved themselves impractical due to high costs and substantial latency... Chat models also tend to provide their outputs in inconsistent format"
- GitHub Copilot uses custom FIM-specialized models, not general GPT
- Supermaven uses a custom architecture (Babble) designed for this task

**Why chat models struggle:** "Chat models emphasize generating complete, assistant-style outputs rather than context-aware code insertions. This focus comes at a cost: the training process largely overlooks the strict contextual and logical consistency required by FIM code completion, where new code must integrate seamlessly with its surrounding prefix and suffix."

### Technique 6: Hybrid Approach (What Bespoke AI Could Consider)

For a tool that must use a chat model (e.g., Claude via API):

1. **For prose:** Continue using assistant prefill. Seed with the last N words of the prefix. This is the strongest anchoring technique available for Claude and is exactly what Cody does.

2. **For code:** Consider offering an Ollama backend with a FIM-trained model (e.g., `deepseek-coder:6.7b-base`, `starcoder2:3b`, or Mellum via the [mellum-sdk](https://github.com/JetBrains/mellum-sdk)). The Ollama backend already supports raw mode with native FIM tokens.

3. **For cloud code completion without prefill:** Use the instruction + stop token approach with aggressive post-processing. Frame the prompt as a code completion task, not a chat task. Use XML tags for Claude. Strip any preamble. Enforce stop boundaries.

---

## 5. Novel Approaches and Patterns

### Edit-Based Context (Supermaven)

Instead of showing the model static file contents, show the sequence of recent edits (like `git diff`). This helps the model understand *intent* (what you're trying to accomplish) rather than just *state* (what the code looks like now). This is a fundamentally different framing that could improve completion relevance.

### Curriculum-Based FIM Training

Instead of randomly splitting files for FIM training, focus on the patterns where models fail most: call expressions, function definitions, class definitions. Weight training data toward these complex patterns based on real user acceptance data.

Source: [Improving FIM Code Completions via Context & Curriculum Based Learning](https://arxiv.org/html/2412.16589v1)

### Structure-Aware FIM (AST-FIM)

Use Abstract Syntax Trees to define FIM boundaries at syntactic structure boundaries (whole subtrees) rather than arbitrary character positions. This better mimics real developer editing patterns.

Source: [Structure-Aware Fill-in-the-Middle Pretraining for Code](https://arxiv.org/html/2506.00204v1)

### Horizon-Length Prediction for Planning

FIM models struggle to "connect" their output to the suffix because they lack planning capability. Horizon-Length Prediction (HLP) trains models to predict how many tokens remain until the suffix, enabling better planning of the middle section.

Source: [Planning-Aware Code Infilling](https://arxiv.org/pdf/2410.03103)

### Instruction-Aware FIM (IFIM)

Standard instruction-tuning degrades FIM performance. IFIM is a specialized instruction-tuning method that preserves FIM capability while adding the ability to follow natural language instructions about what code to generate.

Source: [Bridging Developer Instructions and Code Completion](https://arxiv.org/pdf/2509.24637)

### DPO for Completion Style

JetBrains used Direct Preference Optimization to suppress verbose, hard-to-read completions. After SFT, models still produced "syntactically correct yet unhelpful outputs." DPO with LLM-as-judge scoring cleaned this up without requiring human preference data.

### Probability-Based Quality Scoring

Sourcegraph sums the underlying token probabilities from the LLM to understand "how certain the model is about a specific generation." This enables ranking multiple candidate completions by confidence, independent of any external quality model.

### Multi-Retriever Context with Multiple Perspectives

ProCC (academic work) uses multiple retrieval perspectives to gather context for FIM prompts: API usage patterns, similar code snippets, and documentation. Each perspective is structured as a separate FIM prompt, and results are combined.

Source: [ProCC: Prompt-based Code Completion via Multi-Retrieval Augmented Generation](https://arxiv.org/html/2405.07530v1)

---

## 6. Academic Research on FIM and Prompt Design

### Key Papers

| Paper | Year | Key Contribution |
|-------|------|-----------------|
| [Improving FIM Code Completions via Context & Curriculum Based Learning](https://arxiv.org/abs/2412.16589) | 2024 | Curriculum-based training targeting complex patterns; first real A/B test results |
| [Planning-Aware Code Infilling via Horizon-Length Prediction](https://arxiv.org/pdf/2410.03103) | 2024 | Addresses FIM planning deficiency; models fail to connect output to suffix |
| [Structure-Aware Fill-in-the-Middle (AST-FIM)](https://arxiv.org/html/2506.00204v1) | 2025 | AST-based FIM boundaries outperform random spans |
| [Bridging Developer Instructions and Code Completion (IFIM)](https://arxiv.org/pdf/2509.24637) | 2025 | Instruction tuning that preserves FIM capability |
| [aiXcoder-7B](https://arxiv.org/html/2410.13187v1) | 2024 | PSM format with 16K context; SFIM+FIM+NTP mixed training |
| [Mellum](https://arxiv.org/html/2510.05788v1) | 2025 | Production-grade FIM with multi-file context and DPO |
| [ProCC](https://arxiv.org/html/2405.07530v1) | 2024 | Multi-retrieval augmented generation for FIM prompts |
| [Search-and-Replace Infilling (SRI)](https://arxiv.org/pdf/2601.13384) | 2025 | FIM via search-and-replace blocks; simultaneously infills and corrects bugs |

### Key Findings Across Papers

- **PSM ordering** (Prefix-Suffix-Middle) empirically outperforms SPM (Suffix-Prefix-Middle) for FIM fine-tuning
- **Random span FIM** is necessary for generalization but insufficient for production quality; semantic/structural boundaries produce better training data
- **Context matters more than model size**: well-chosen context with a small model often beats a larger model with generic context
- **Chat models degrade FIM**: standard instruction tuning actively harms FIM capability; specialized methods (IFIM) are needed to preserve it
- **Planning is the bottleneck**: models struggle to connect their output to the suffix (the "horizon" problem)

---

## 7. Sources

### Tool Documentation and Source Code
- [Continue.dev AutocompleteTemplate.ts (GitHub)](https://github.com/continuedev/continue/blob/main/core/autocomplete/templating/AutocompleteTemplate.ts)
- [Continue.dev Autocomplete How It Works](https://docs.continue.dev/autocomplete/how-it-works)
- [Continue.dev Autocomplete Model Setup](https://docs.continue.dev/customize/model-roles/autocomplete)
- [Tabby Code Completion Docs](https://tabby.tabbyml.com/docs/administration/code-completion/)
- [Tabby FIM Prompt Templates Discussion](https://github.com/TabbyML/tabby/discussions/2869)
- [DeepSeek FIM API Docs](https://api-docs.deepseek.com/guides/fim_completion)
- [Sourcegraph: The Lifecycle of a Code AI Completion](https://sourcegraph.com/blog/the-lifecycle-of-a-code-ai-completion)
- [Sourcegraph Cody Autocomplete Docs](https://sourcegraph.com/docs/cody/capabilities/autocomplete)
- [GitHub Blog: The Road to Better Completions](https://github.blog/ai-and-ml/github-copilot/the-road-to-better-completions-building-a-faster-smarter-github-copilot-with-a-new-custom-model/)
- [Supermaven: Introducing Supermaven](https://supermaven.com/blog/introducing-supermaven)
- [Codeium Analysis (Zack Proser)](https://zackproser.com/blog/codeium-analysis-4-2024)

### Anthropic / Claude Specific
- [Claude Prefill Documentation](https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prefill-claudes-response)
- [Claude Reduce Hallucinations Guide](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations)

### JetBrains
- [Mellum: How We Trained a Model for Code Completion (Blog)](https://blog.jetbrains.com/ai/2025/04/mellum-how-we-trained-a-model-to-excel-in-code-completion/)
- [Why and How JetBrains Built Mellum](https://blog.jetbrains.com/ai/2025/02/why-and-how-jetbrains-built-mellum-the-llm-designed-for-code-completion/)
- [Mellum Goes Open Source](https://blog.jetbrains.com/ai/2025/04/mellum-goes-open-source-a-purpose-built-llm-for-developers-now-on-hugging-face/)
- [Full Line Code Completion in JetBrains IDEs](https://blog.jetbrains.com/blog/2024/04/04/full-line-code-completion-in-jetbrains-ides-all-you-need-to-know/)
- [mellum-sdk (GitHub)](https://github.com/JetBrains/mellum-sdk)

### Academic Papers
- [Improving FIM Code Completions via Context & Curriculum Based Learning (arXiv 2412.16589)](https://arxiv.org/abs/2412.16589)
- [Mellum: Production-Grade in-IDE Contextual Code Completion (arXiv 2510.05788)](https://arxiv.org/abs/2510.05788)
- [Planning-Aware Code Infilling via Horizon-Length Prediction (arXiv 2410.03103)](https://arxiv.org/abs/2410.03103)
- [Structure-Aware Fill-in-the-Middle Pretraining for Code (arXiv 2506.00204)](https://arxiv.org/abs/2506.00204)
- [Bridging Developer Instructions and Code Completion (arXiv 2509.24637)](https://arxiv.org/abs/2509.24637)
- [aiXcoder-7B (arXiv 2410.13187)](https://arxiv.org/abs/2410.13187)
- [ProCC: Prompt-based Code Completion via Multi-Retrieval Augmented Generation (arXiv 2405.07530)](https://arxiv.org/abs/2405.07530)
- [Search-and-Replace Infilling (arXiv 2601.13384)](https://arxiv.org/abs/2601.13384)

### Community and Blogs
- [Fast, Predictable & Self-hosted AI Code Completion (DEV Community)](https://dev.to/sp90/fast-predictable-self-hosted-ai-code-completion-1f4d)
- [FIM: The Magic Behind Smart Code Completion](https://vnavarro.dev/blog/fim)
- [Code-Intelligence Prompt Templates](https://chabicht.github.io/code-intelligence/PROMPT-TEMPLATES.html)
- [Cursor System Prompt Leaked](https://medium.com/data-science-in-your-pocket/cursor-ais-leaked-prompt-7-prompt-engineering-tricks-for-vibe-coders-c75ebda1a24b)
- [Leaked System Prompts Collection (GitHub)](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools)
- [Using Chat Models as Completion Models (OpenAI Forum)](https://community.openai.com/t/using-chat-models-as-completion-models/880393)
