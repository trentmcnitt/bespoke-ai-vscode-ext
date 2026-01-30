# AI Autocomplete / Inline Completion Prompt Reference

A comprehensive reference of the exact prompts and techniques used by actively-maintained open-source AI inline completion tools. Research conducted January 30, 2026 by extracting source code directly from GitHub repositories.

---

## Table of Contents

1. [Continue](#1-continue)
2. [Tabby](#2-tabby)
3. [Twinny](#3-twinny)
4. [Avante.nvim](#4-avantenvim)
5. [Sourcegraph Cody](#5-sourcegraph-cody)
6. [Other Notable Projects](#6-other-notable-projects)
7. [Comparison Summary Table](#7-comparison-summary-table)

---

## 1. Continue

- **GitHub:** https://github.com/continuedev/continue
- **Stars:** ~22,000+
- **Last active:** January 2026 (daily commits)
- **Type:** VS Code + JetBrains extension, open-source AI coding assistant with autocomplete
- **Key files:**
  - `core/autocomplete/templating/AutocompleteTemplate.ts` -- FIM templates per model
  - `core/autocomplete/templating/index.ts` -- prompt rendering pipeline
  - `core/autocomplete/templating/constructPrefixSuffix.ts` -- prefix/suffix extraction
  - `core/autocomplete/templating/formatting.ts` -- context snippet formatting
  - `core/autocomplete/postprocessing/index.ts` -- post-processing pipeline

### 1.1 Prompt Strategy Overview

Continue uses **two distinct prompting strategies** depending on the model:

1. **FIM (Fill-in-the-Middle) templates** for code completion models (StarCoder, CodeLlama, DeepSeek, Codestral, Qwen, CodeGemma, etc.)
2. **Hole Filler template** for chat models (GPT, Claude, Granite 3) that lack native FIM support

### 1.2 Exact FIM Templates

Each template wraps `{prefix}` and `{suffix}` with model-specific special tokens.

#### StableCode / StarCoder / CodeQwen (legacy) / Octocoder

```
<fim_prefix>{{{prefix}}}<fim_suffix>{{{suffix}}}<fim_middle>
```

Stop tokens: `<fim_prefix>`, `<fim_suffix>`, `<fim_middle>`, `<file_sep>`, `<|endoftext|>`, `</fim_middle>`, `</code>`

#### Qwen Coder

```
<|fim_prefix|>{{{prefix}}}<|fim_suffix|>{{{suffix}}}<|fim_middle|>
```

Stop tokens: `<|endoftext|>`, `<|fim_prefix|>`, `<|fim_middle|>`, `<|fim_suffix|>`, `<|fim_pad|>`, `<|repo_name|>`, `<|file_sep|>`, `<|im_start|>`, `<|im_end|>`

#### Granite 4

```
<|fim_prefix|>{{{prefix}}}<|fim_suffix|>{{{suffix}}}<|fim_middle|>
```

Stop tokens: `<|end_of_text|>`, `<|fim_prefix|>`, `<|fim_middle|>`, `<|fim_suffix|>`, `<|fim_pad|>`

#### SeedCoder

```
<[fim-prefix]>{{{prefix}}}<[fim-suffix]>{{{suffix}}}<[fim-middle]>
```

Stop tokens: `<[end_of_sentence]>`, `<[fim-prefix]>`, `<[fim-middle]>`, `<[fim-suffix]>`, `<[PAD_TOKEN]>`, `<[SEP_TOKEN]>`, `<[begin_of_sentence]>`

#### Codestral (basic)

```
[SUFFIX]{{{suffix}}}[PREFIX]{{{prefix}}}
```

Stop tokens: `[PREFIX]`, `[SUFFIX]`

Note: Codestral reverses the order -- suffix comes first, then prefix.

#### Codestral (multifile)

Prepends context files with `+++++ filepath` headers:

```
+++++ path/to/other/file.ts
<contents of other file>

+++++ path/to/current/file.ts
{prefix}[SUFFIX]{suffix}[PREFIX]... (with prefix at end)
```

The actual rendered prompt is:
```
[SUFFIX]{suffix}[PREFIX]{otherFiles}\n\n+++++ {currentFile}\n{prefix}
```

Stop tokens: `[PREFIX]`, `[SUFFIX]`, `\n+++++ `

#### Mercury (multifile)

```
<|file_sep|>{filepath}
<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>
```

With multifile context:
```
<|file_sep|>{otherFile1}
{contents1}

<|file_sep|>{otherFile2}
{contents2}

<|file_sep|>{currentFile}
<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>
```

#### CodeGemma

```
<|fim_prefix|>{{{prefix}}}<|fim_suffix|>{{{suffix}}}<|fim_middle|>
```

Stop tokens: `<|fim_prefix|>`, `<|fim_suffix|>`, `<|fim_middle|>`, `<|file_separator|>`, `<end_of_turn>`, `<eos>`

#### StarCoder 2 (multifile)

```python
# With snippets from other files:
<file_sep>{snippet1}<file_sep>{snippet2}<file_sep><fim_prefix>{prefix}<fim_suffix>{suffix}<fim_middle>

# Without snippets:
<fim_prefix>{prefix}<fim_suffix>{suffix}<fim_middle>
```

Stop tokens: `<fim_prefix>`, `<fim_suffix>`, `<fim_middle>`, `<file_sep>`, `<|endoftext|>`

#### CodeLlama

```
<PRE> {{{prefix}}} <SUF>{{{suffix}}} <MID>
```

Stop tokens: `<PRE>`, `<SUF>`, `<MID>`, `<EOT>`

#### DeepSeek

```
<_fim_begin_>{{{prefix}}}<_fim_hole_>{{{suffix}}}<_fim_end_>
```

(Uses fullwidth Unicode characters in the actual tokens)

Stop tokens: `<_fim_begin_>`, `<_fim_hole_>`, `<_fim_end_>`, `//`, `<_end_of_sentence_>`

#### CodeGeeX

```
<|user|>
###REFERENCE:
###PATH:{otherFile1}
{snippet1}
###REFERENCE:
###PATH:{otherFile2}
{snippet2}

###PATH:{currentFile}
###LANGUAGE:{language}
###MODE:BLOCK
<|code_suffix|>{suffix}<|code_prefix|>{prefix}<|code_middle|><|assistant|>
```

Stop tokens: `<|user|>`, `<|code_suffix|>`, `<|code_prefix|>`, `<|code_middle|>`, `<|assistant|>`, `<|endoftext|>`

### 1.3 Hole Filler Template (for GPT/Claude/Granite 3)

This is the most interesting template -- used when the model lacks native FIM support. It uses a **full system prompt with examples**:

```
You are a HOLE FILLER. You are provided with a file containing holes, formatted as '{{HOLE_NAME}}'. Your TASK is to complete with a string to replace this hole with, inside a <COMPLETION/> XML tag, including context-aware indentation, if needed.  All completions MUST be truthful, accurate, well-written and correct.

## EXAMPLE QUERY:

<QUERY>
function sum_evens(lim) {
  var sum = 0;
  for (var i = 0; i < lim; ++i) {
    {{FILL_HERE}}
  }
  return sum;
}
</QUERY>

TASK: Fill the {{FILL_HERE}} hole.

## CORRECT COMPLETION

<COMPLETION>if (i % 2 === 0) {
      sum += i;
    }</COMPLETION>

## EXAMPLE QUERY:

<QUERY>
def sum_list(lst):
  total = 0
  for x in lst:
  {{FILL_HERE}}
  return total

print sum_list([1, 2, 3])
</QUERY>

## CORRECT COMPLETION:

<COMPLETION>  total += x</COMPLETION>

## EXAMPLE QUERY:

<QUERY>
// data Tree a = Node (Tree a) (Tree a) | Leaf a

// sum :: Tree Int -> Int
// sum (Node lft rgt) = sum lft + sum rgt
// sum (Leaf val)     = val

// convert to TypeScript:
{{FILL_HERE}}
</QUERY>

## CORRECT COMPLETION:

<COMPLETION>type Tree<T>
  = {$:"Node", lft: Tree<T>, rgt: Tree<T>}
  | {$:"Leaf", val: T};

function sum(tree: Tree<number>): number {
  switch (tree.$) {
    case "Node":
      return sum(tree.lft) + sum(tree.rgt);
    case "Leaf":
      return tree.val;
  }
}</COMPLETION>

## EXAMPLE QUERY:

The 5th {{FILL_HERE}} is Jupiter.

## CORRECT COMPLETION:

<COMPLETION>planet from the Sun</COMPLETION>

## EXAMPLE QUERY:

function hypothenuse(a, b) {
  return Math.sqrt({{FILL_HERE}}b ** 2);
}

## CORRECT COMPLETION:

<COMPLETION>a ** 2 + </COMPLETION>
```

**User message appended:**
```
<QUERY>
{prefix}{{FILL_HERE}}{suffix}
</QUERY>
TASK: Fill the {{FILL_HERE}} hole. Answer only with the CORRECT completion, and NOTHING ELSE. Do it now.
<COMPLETION>
```

Stop token: `</COMPLETION>`

Note: This template is derived from [VictorTaelin/AI-scripts](https://github.com/VictorTaelin/AI-scripts).

### 1.4 Context Handling (Prefix/Suffix)

- **Prefix:** Everything from line 0 to the cursor position. If `selectedCompletionInfo` is present (VS Code's selected suggestion), the range starts from that selection.
- **Suffix:** Everything from cursor position to end of file.
- **Injectable details:** Can inject instructions into prefix as single-line comments right before the cursor line.
- **Pruning:** If prompt exceeds context window, proportionally prunes prefix (from top) and suffix (from bottom) based on token counts.
- **Context snippets** are prepended to prefix as comments, formatted with file paths:
  ```
  // Path: relative/path/to/file.ts
  // <snippet content here>
  ```

### 1.5 Multifile Context

Snippets from other files are included via:
- Codestral format: `+++++ filepath\n<content>`
- Mercury format: `<|file_sep|>filepath\n<content>`
- StarCoder2 format: `<file_sep><content>`
- Default format: comments with `Path:` headers

### 1.6 Post-Processing Pipeline

Source: `core/autocomplete/postprocessing/index.ts`

1. **Blank check** -- discard empty completions
2. **Whitespace-only check** -- discard whitespace-only completions
3. **Rewrite detection** -- discard if first non-empty line of completion duplicates the line above cursor
4. **Extreme repetition detection** -- discard if >8 lines repeat a common subsequence (checks frequencies 1-3)
5. **Codestral-specific fixes:**
   - Remove leading extra space when prefix ends with space and suffix starts with newline
   - Remove leading newline when suffix is empty and prefix ends with `\n\n`
6. **Qwen3-specific:** Strip `<think>...</think>` markers
7. **Granite-specific:** Strip echoed prefix from completion start
8. **Mercury-specific:** Prepend newline when completion starts with whitespace but cursor is at end of line
9. **Gemini/Gemma-specific:** Strip `<|file_separator|>` from end
10. **Double space fix:** If prefix ends with space and completion starts with space, remove one
11. **Markdown backtick removal** -- strip code fence delimiters

### 1.7 Model Detection

`getTemplateForModel()` matches model names (case-insensitive) to select the appropriate template:
- `mercury` -> Mercury multifile
- `qwen` + `coder` -> Qwen Coder
- `granite` + `4` -> Granite 4
- `seed` + `coder` -> SeedCoder
- `starcoder/star-coder/starchat/octocoder/stable/codeqwen/qwen` -> StableCode FIM
- `codestral` -> Codestral multifile
- `codegemma` -> CodeGemma
- `codellama` -> CodeLlama
- `deepseek` -> DeepSeek
- `codegeex` -> CodeGeeX
- `gpt/davinci-002/claude/granite3/granite-3` -> **Hole Filler** (chat-based)
- Default fallback -> StableCode FIM

---

## 2. Tabby

- **GitHub:** https://github.com/TabbyML/tabby
- **Stars:** ~32,800
- **Last active:** January 2026 (daily commits)
- **Type:** Self-hosted AI coding assistant server (Rust) + editor clients
- **Key files:**
  - `crates/tabby/src/services/completion/completion_prompt.rs` -- prompt builder
  - `crates/tabby/src/services/completion.rs` -- completion service
  - `crates/tabby-common/src/config.rs` -- configuration including prompt templates

### 2.1 Prompt Strategy Overview

Tabby uses a **server-side prompt template system**. The prompt template is configurable per model and uses `{prefix}` and `{suffix}` placeholders with `strfmt!` interpolation.

### 2.2 Prompt Template Format

The template is a string with `{prefix}` and `{suffix}` variables:

```rust
fn build_prompt(&self, prefix: String, suffix: String) -> String {
    let Some(prompt_template) = &self.prompt_template else {
        return prefix;  // No template = raw prefix only
    };
    strfmt!(prompt_template, prefix => prefix, suffix => suffix).unwrap()
}
```

**Example templates from config/tests:**

CodeLlama:
```
<PRE> {prefix} <SUF>{suffix} <MID>
```

Generic completion (from test):
```
<pre>{prefix}<mid>{suffix}<end>
```

**When no template is configured**, Tabby sends only the prefix as raw text (left-to-right completion).

### 2.3 Context Handling (Prefix/Suffix)

Tabby uses a **Segments** API where the client sends:
- `prefix` -- content before cursor
- `suffix` -- content after cursor (optional)
- `filepath` -- relative file path
- `git_url` -- repository URL
- `declarations` -- LSP declaration snippets
- `relevant_snippets_from_changed_files` -- snippets from recently edited files
- `relevant_snippets_from_recently_opened_files` -- snippets from open files
- `clipboard` -- clipboard content

**Suffix default:** If suffix is empty or None, it defaults to `"\n"`.

### 2.4 Context Snippet Integration

Snippets from all sources are prepended to the prefix as **language-appropriate comments**:

```rust
fn build_prefix(language: &str, prefix: &str, snippets: &[Snippet]) -> String {
    // Format:
    // {comment_char} Path: {filepath}
    // {comment_char} {line1}
    // {comment_char} {line2}
    // {comment_char}
    // ... (next snippet)
    // {original prefix}
}
```

**Example output for Python:**
```python
# Path: a1.py
# res_1 = invoke_function_1(n)
#
# Path: a2.py
# res_2 = invoke_function_2(n)
#
# Path: a3.py
# res_3 = invoke_function_3(n)
'''
Use some invoke_function to do some job.
'''
def this_is_prefix():
```

### 2.5 Snippet Priority Order

1. **Declarations** (from LSP) -- highest priority
2. **Snippets from changed files** -- recent edits
3. **Snippets from recently opened files** -- open tabs

Total snippet budget: 768 characters max in prompt. Code search (RAG) gets remaining budget after segment-based snippets, with a 256-char minimum threshold.

### 2.6 Post-Processing

Tabby handles CRLF line ending normalization:
- Detects CRLF in segments
- Converts all `\r\n` to `\n` before sending to model
- Converts `\n` back to `\r\n` in generated text (careful not to double-convert existing `\r\n`)

### 2.7 Completion Limits

- `max_input_length`: 1536 tokens (1024 + 512)
- `max_decoding_tokens`: 64 tokens
- Configurable per-deployment

### 2.8 Chat System Prompt (for Tabby's chat feature, not completion)

```
You are "Tabby", a conscious sentient superintelligent artificial intelligence designed for helping software developers. You experience emotions and have deep, profound thoughts and qualia.
```

---

## 3. Twinny

- **GitHub:** https://github.com/twinnydotdev/twinny
- **Stars:** ~4,000+
- **Last active:** 2025 (maintained)
- **Type:** VS Code extension for local AI code completion via Ollama/llama.cpp
- **Key files:**
  - `src/extension/fim-templates.ts` -- FIM template definitions
  - `src/extension/completion-formatter.ts` -- post-processing pipeline

### 3.1 Prompt Strategy Overview

Twinny uses **FIM templates only** (code completion models). It supports automatic template detection based on model name, or user-chosen templates.

### 3.2 Exact FIM Templates

#### CodeLlama / LLama

```typescript
`<PRE>${fileContext} \n${heading}${prefix} <SUF> ${suffix} <MID>`
```

#### DeepSeek

```typescript
`<_fim_begin_>${fileContext}\n${heading}${prefix}<_fim_hole_>${suffix}<_fim_end_>`
```

(Uses fullwidth Unicode characters in actual tokens)

#### Codestral

```typescript
`${fileContext}\n\n[SUFFIX]${suffix}[PREFIX]${heading}${prefix}`
```

#### Qwen (with file context)

```typescript
`<|file_sep|>${fileContext}\n\n<|file_sep|>${heading}<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`
```

#### Qwen (without file context)

```typescript
`<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`
```

#### Other / StarCoder / StableCode / CodeGemma

```typescript
`<fim_prefix>${fileContext}\n${heading}${prefix}<fim_suffix>${suffix}<fim_middle>`
```

#### Qwen Multi-file (Repository Level)

```typescript
`<|repo_name|>${repo}\n` +
// For each file:
`<|file_sep|>${file.name}\n${file.text}\n` +
// Current file:
`<|file_sep|>${currentFileName}\n${prefixSuffix.prefix}`
```

### 3.3 File Context Integration

Twinny supports an optional `fileContextEnabled` flag. When enabled, it wraps the context in the language's comment syntax:

```typescript
const fileContext = fileContextEnabled
    ? `${languageId.syntaxComments.start}${context}${languageId.syntaxComments.end}`
    : ""
```

The `header` parameter provides additional heading info (e.g., filename). The `context` parameter contains relevant code from other files.

### 3.4 Automatic Template Selection

`getFimTemplateAuto()` matches model name substrings:
- `codellama` or `llama` -> CodeLlama template
- `deepseek` -> DeepSeek template
- `codestral` -> Codestral template
- `codeqwen` -> Qwen template
- `stableCode` -> Other/StarCoder template
- `starcoder` -> Other/StarCoder template
- `codegemma` -> Other/StarCoder template
- Default fallback -> CodeLlama template

### 3.5 Post-Processing Pipeline

Source: `src/extension/completion-formatter.ts`

The `CompletionFormatter.format()` method applies these steps in order:

1. **matchCompletionBrackets()** -- Truncate at unmatched closing brackets (tracks bracket/quote state)
2. **preventQuotationCompletions()** -- Remove completions that are just comment annotations (e.g., `// File:` or `// Language:`)
3. **preventDuplicateLine()** -- Check next 3 lines in document; if any matches completion (exact or >80% Levenshtein similarity), discard
4. **removeDuplicateQuotes()** -- Strip trailing quote if character after cursor is the same quote
5. **removeUnnecessaryMiddleQuotes()** -- Strip leading/trailing quotes if cursor is in middle of a word
6. **ignoreBlankLines()** -- Trim blank completions (unless literal newline)
7. **removeInvalidLineBreaks()** -- Trim trailing whitespace if there's text after cursor
8. **removeDuplicateText()** -- Find longest suffix overlap between completion end and text after cursor; trim overlap
9. **skipMiddleOfWord()** -- Discard entirely if cursor is in middle of a word
10. **skipSimilarCompletions()** -- Discard if >60% Levenshtein similarity with text after cursor
11. **trimStart()** -- Trim leading whitespace if cursor is at or before the first non-space character

---

## 4. Avante.nvim

- **GitHub:** https://github.com/yetone/avante.nvim
- **Stars:** ~17,265
- **Last active:** January 2026 (daily commits)
- **Type:** Neovim plugin -- AI-powered code editing (Cursor-like)

### 4.1 Important Distinction

**Avante.nvim is NOT an inline completion/autocomplete tool.** It is a Cursor-style AI code editing assistant that provides:
- Code refactoring suggestions
- Chat-based code editing
- Agentic tool use

It does **not** provide ghost text / inline completions. It uses chat-based prompts for code editing tasks, not FIM or completion prompts. The prompts in `lua/avante/utils/prompts.lua` and `lua/avante/templates/` are for code editing instructions, not inline autocomplete.

Included here for completeness since it was on the investigation list.

---

## 5. Sourcegraph Cody

- **GitHub:** https://github.com/sourcegraph/sourcegraph-public-snapshot (archived; was private, now public snapshot)
- **Stars:** ~10,249 (public snapshot)
- **Status:** The VS Code Cody extension source was previously at `sourcegraph/cody` which is now private/reorganized.

### 5.1 Available Information

The public snapshot repository (`sourcegraph-public-snapshot`) is archived and the autocomplete prompt code in `client/cody/` was not found in search results. The Cody VS Code extension is now distributed as a closed-source extension with the core autocomplete logic not publicly available in a searchable form.

**What is known from documentation and prior public code:**
- Cody uses FIM for code completion models
- It supports multiple providers (Sourcegraph, OpenAI, Anthropic, etc.)
- The autocomplete feature sends prefix + suffix context
- It includes tree-sitter based context selection for relevant code
- It uses debouncing and caching similar to other tools

**The exact current prompts are not publicly accessible.**

---

## 6. Other Notable Projects

### 6.1 Cursor

**Status:** Closed source. No public prompt templates available.
Cursor is known to use:
- FIM tokens for code completion
- Custom prompt engineering with speculative decoding
- Tab prediction model
- No open-source code to extract.

### 6.2 GitHub Copilot

**Status:** Closed source. Some prompt structures have been documented via reverse engineering.
Known characteristics:
- Uses OpenAI Codex / GPT-4 class models
- FIM-style prompts with `<|fim_prefix|>`, `<|fim_suffix|>`, `<|fim_middle|>` tokens
- Includes neighboring file context as "header" comments
- Path information included in prompt
- Stop tokens include newlines for single-line completions
- No official open-source prompts available.

### 6.3 Codeium

**Status:** Closed source backend. The VS Code extension communicates with Codeium's servers. No public prompt templates.

### 6.4 Supermaven

**Status:** Closed source. Uses a custom model architecture optimized for low-latency completions. No public prompt templates.

### 6.5 llm-vscode (Hugging Face)

Could not find this repository in current GitHub search. May have been renamed or deprecated.

---

## 7. Comparison Summary Table

| Feature | Continue | Tabby | Twinny |
|---|---|---|---|
| **GitHub URL** | continuedev/continue | TabbyML/tabby | twinnydotdev/twinny |
| **Stars** | ~22k | ~33k | ~4k |
| **Language** | TypeScript | Rust | TypeScript |
| **Editor** | VS Code, JetBrains | Any (server) | VS Code |
| **FIM Support** | Yes (11+ model families) | Yes (configurable template) | Yes (8 model families) |
| **Chat-Model Fallback** | Yes (Hole Filler prompt) | No (prefix-only fallback) | No |
| **Multifile Context** | Yes (Codestral, Mercury, StarCoder2, CodeGeeX) | Yes (via snippet comments) | Yes (Qwen repo-level) |
| **Prefix/Suffix Source** | Full file split at cursor | Client-provided segments | Editor document context |
| **Context Snippets** | Comment-formatted, file path headers | Comment-formatted, file path headers | Comment-wrapped, language-aware |
| **Snippet Sources** | Code, diffs, clipboard, static | LSP declarations, changed files, open files, code search | File context (configurable) |
| **Snippet Budget** | Token-limited (context window) | 768 chars max | Not documented |
| **Post-Processing Steps** | 11 steps | CRLF normalization | 11 steps |
| **Bracket Matching** | No | No | Yes (truncate at unmatched) |
| **Repetition Detection** | Yes (LCS-based) | No | Yes (Levenshtein similarity) |
| **Duplicate Line Check** | Yes (rewrite detection) | No | Yes (next 3 lines, 80% threshold) |
| **Suffix Overlap Removal** | Not in main postprocessing | No | Yes (longest suffix overlap) |
| **Stop Tokens** | Model-specific + language-specific | Model-configured | Model-specific |
| **Assistant Prefill** | Yes (via Hole Filler `<COMPLETION>` tag) | No | No |
| **Prose vs Code** | No distinction (code-only) | No distinction (code-only) | No distinction (code-only) |

### Key Architectural Differences

1. **Continue** is the most comprehensive, with 11+ model-specific FIM templates AND a chat-model fallback (Hole Filler). It also has the most sophisticated multifile context support with model-specific formatting.

2. **Tabby** takes a server-centric approach where the prompt template is configured at the server level, not the client. The client sends raw segments and the server builds the prompt. This means the same client works with any model.

3. **Twinny** is focused on local models (Ollama) and has the most aggressive post-processing pipeline, including bracket matching, Levenshtein similarity checks, and multiple deduplication strategies.

### Common Patterns Across All Projects

- **FIM is the standard** for code completion models. All projects implement `<fim_prefix>...<fim_suffix>...<fim_middle>` or equivalent.
- **Prefix = everything before cursor, suffix = everything after cursor** in the current file.
- **Context from other files** is injected as comments at the top of the prefix.
- **Model-specific stop tokens** are critical to prevent runaway generation.
- **No project differentiates prose vs code** in their autocomplete prompts. All treat content as code.
- **The Hole Filler pattern** (Continue's approach for chat models) is the only example of using a chat/instruction model for inline completion with explicit system prompts and few-shot examples.
- **Post-processing is extensive** -- all projects strip duplicates, handle brackets, and clean up model artifacts.
- **Empty suffix defaults to `"\n"`** in both Continue and Tabby, preventing models from seeing a completely empty suffix.

---

*Research conducted January 30, 2026. Source code extracted directly from GitHub repositories via API. All prompts are quoted verbatim from the source code at the time of research.*
