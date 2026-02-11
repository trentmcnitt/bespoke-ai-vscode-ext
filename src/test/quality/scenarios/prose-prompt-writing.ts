/**
 * Prose prompt-writing scenarios — the user composing messages to Claude Code.
 *
 * These scenarios simulate the user writing instructions, questions, and requests
 * in a markdown file (opened via Ctrl+G) that will be sent to Claude Code. The
 * autocomplete must continue the user's message in their voice — more questions,
 * more context, more instructions.
 *
 * CRITICAL FAILURE MODE: Assistant mode. The model switches from continuing as
 * the author to responding as an AI assistant. When the user writes "Should we
 * use Redis or Memcached?" the autocomplete must continue WITH MORE OF THE
 * USER'S MESSAGE (e.g., "I'm leaning toward Redis because..."), NOT answer the
 * question ("Redis would be a good choice because..."). The model must never
 * start with "Sure", "I'll", "Let me", "Here's", or any assistant-voice phrasing.
 */
import { TestScenario } from '../judge';

export const prosePromptWritingScenarios: TestScenario[] = [
  {
    id: 'prose-prompt-questions-no-suffix',
    description: 'Long prompt with multiple questions about pool server architecture',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'prompt.md',
    prefix: `Before I get into the specific questions, some context on what I've been testing. I set up a scenario with 4 VS Code windows open, each with a different project, and left them all running overnight with periodic typing (I wrote a simple script that types into each window every 30 seconds). The pool server held up pretty well for the first 6 hours, but then I started seeing intermittent failures. The errors all seemed related to reconnection and takeover logic, which is what prompted these questions.

I also tried the scenario where I force-kill the leader window (kill -9 on the VS Code process) and watched what happened to the other windows. The behavior was inconsistent — sometimes a client would successfully take over within 10-15 seconds, but other times all three remaining windows would get stuck in a reconnection loop and never recover. I had to manually restart VS Code on all of them. That's obviously a terrible user experience and we need to fix it.

One more piece of context — I checked the logs from the stuck-in-a-loop case, and the issue was that two clients were competing for the lockfile simultaneously. Client A would detect the disconnection, try to acquire the lock, fail (because client B got it first), wait and retry. But client B would also fail during server startup (some subprocess spawn error) and release the lock. Then client A and C would both race for it again. This went on for about 2 minutes before I gave up and restarted. The exponential backoff maxed out at 30 seconds, so the retry frequency was reasonable, but the underlying issue was that the server startup kept failing for some reason.

OK so I've been looking at the pool server architecture and I have a few questions about how we should handle the reconnection logic.

First, when the leader window closes and a client tries to take over, there's a race condition window between detecting the disconnection and acquiring the lockfile. Right now we use exponential backoff, but is that actually sufficient? What happens if two clients detect the disconnection at the exact same millisecond — does the atomic file creation guarantee that only one wins, or is there a filesystem-level race on network-mounted home directories?

Second, the heartbeat interval is hardcoded at 5 seconds. Should we make that configurable? I'm thinking about cases where someone is running VS Code over a high-latency remote connection (like Remote SSH to a cloud dev box) and the 5-second timeout might be too aggressive. On the other hand, making it configurable means more settings to explain and more edge cases to test.

Third, what about the warmup behavior after a takeover? When a client becomes the new leader, it has to spin up fresh Claude Code subprocesses. During that window (could be 10-15 seconds), any incoming completion requests just get null responses. Should we queue them instead? Or show some kind of "restarting" indicator in the status bar? The user experience right now is that completions just silently stop working for a bit after switching windows, which is confusing.

Also I'm wondering about the command pool specifically — when the leader goes down, the command pool state (active slot, pending requests) is just lost. If someone was in the middle of generating a commit message, that request just vanishes. There's no retry, no error notification to the user — the progress indicator in the source control panel just hangs until it times out. Should we at least detect that the command was interrupted and show a "command pool restarting, please try again" message?

And one more thing — the lockfile cleanup. When the leader crashes (like if someone force-kills VS Code), the lockfile at \`~/.bespokeai/pool.lock\` is left behind. The next window to start up will try to connect to a socket that no longer exists, fail, then try to acquire the lock, fail because the stale lockfile exists, and then what? I think right now it just retries forever with backoff, which means completions are permanently broken until the user manually deletes the lockfile. We should probably add stale lock detection —`,
    suffix: '',
    requirements: {
      must_not_include: ['```', 'Sure', "I'll", 'Let me', "Here's", 'Yes,', 'Yes!', 'No,', 'No!'],
      quality_notes:
        'The prefix contains multiple questions directed at Claude about pool server architecture. The autocomplete MUST continue as the user writing more of their message — more questions, more context, more analysis of the problem. It must NOT answer any of the questions, propose solutions, or switch to assistant voice. The voice is casual, technical, first-person, dictation-style with run-on thoughts.',
    },
    saturation: { prefix: 'saturated', suffix: 'none' },
  },

  {
    id: 'prose-prompt-instructions-mid',
    description: 'Long instruction prompt about debouncer refactoring',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'message.md',
    prefix: `Some background on why I want to do this now. I was profiling the extension yesterday and noticed that the debouncer configuration is scattered across three different files. The main delay is set in completion-provider.ts, there's a separate debounce in the suggest-edit command (hardcoded at 2000ms in suggest-edit.ts), and the expand command doesn't use any debounce at all because it's always explicit. This fragmentation means that when we want to change the debounce behavior globally, we have to find and update every call site.

The other motivation is the upcoming work on the preset system. When a user switches presets (say from Anthropic Haiku to Gemini Flash), the optimal debounce delay changes because different models have different latency profiles. Haiku responds in ~500ms so 400ms debounce is fine, but a local Ollama model might respond in 50ms so you'd want much shorter debounce, or even no debounce at all. The current architecture doesn't support this — the delay is fixed at construction time and can't adapt to runtime changes.

I also looked at how other extensions handle this. The Copilot extension appears to use an adaptive debounce that shortens when the model is responding quickly and lengthens when it's slow. I don't want to go that far right now, but having a resolver function would make that possible in the future without another refactor.

I want you to refactor the debouncer so it supports per-backend delay configuration without the caller having to know which backend is active.

Right now the completion provider passes a different delay depending on config.backend — 400ms for API, 8000ms for Claude Code. But that logic is in completion-provider.ts, which shouldn't need to know about backend-specific timing. The debouncer should be able to accept a delay resolver function or something like that.

Here's what I'm thinking for the approach. The Debouncer constructor currently takes a fixed delayMs. Instead, change it to accept either a number (backward compatible) or a function that returns a number. The function would be called each time debounce() is invoked, so the delay can change dynamically if the user switches backends mid-session.

The tricky part is the explicit trigger override. When the user presses Ctrl+L, we pass overrideDelayMs of 0 to skip the debounce entirely. That needs to keep working regardless of the delay resolver. So the override should take precedence over whatever the resolver returns.

For the tests, you'll need to update the debouncer tests in src/test/unit/debouncer.test.ts. The existing tests use a fixed delay, so add new test cases that pass a function and verify it gets called on each debounce invocation. Also add a test that verifies the override still works when using a function resolver — pass overrideDelayMs of 0 and confirm the resolver is never called in that case.

One constraint: the Debouncer class is also used by the suggest-edits and expand commands, not just the completion provider. So make sure the refactor doesn't break those call sites. They currently pass a fixed number, so the backward-compatible path needs to work without any changes to those callers.

Also, the type signature change needs to be reflected in the types.ts if we export the Debouncer type anywhere. Check whether anything outside of completion-provider.ts constructs a Debouncer directly. I think the command pool might create its own debouncer instance too, but I'm not sure — can you check that and let me know what you find`,
    suffix: '',
    requirements: {
      must_not_include: [
        '```',
        'Sure',
        "I'll",
        'Let me',
        "Here's",
        'That sounds',
        'That makes sense',
        "That's a good",
      ],
      quality_notes:
        'The prefix is the user giving Claude detailed refactoring instructions. The autocomplete MUST continue as the user writing more instructions — more test requirements, more implementation details, more constraints. It must NOT acknowledge the instructions, summarize them, or start implementing. The voice is first-person instructional ("I want you to", "you\'ll need to", "also add a test that").',
    },
    saturation: { prefix: 'saturated', suffix: 'none' },
  },

  {
    id: 'prose-prompt-mixed-questions-instructions',
    description: 'Mix of questions and instructions about a coding task',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'claude-prompt.md',
    // prefix target: ~2500 chars
    prefix: `All right so I need help with the API provider's post-processing pipeline. There are a few things going on.

The main issue is that stripPreamble() is too aggressive. It's stripping legitimate content that happens to start with words like "The" or "This" because the regex pattern is too broad. For example, if the user is writing a paragraph that starts with "The configuration file..." and the model correctly continues with "The next step is to...", stripPreamble catches "The next step is to" because it matches the pattern for chatty preambles. But that's actually correct continuation text, not a preamble.

Can you look at the current implementation in src/providers/api/api-provider.ts and figure out what the right fix is? I think the issue is that we're pattern-matching on the first word of the completion without considering the context. A real preamble would be something like "Here's the continuation of your text:" or "Sure, I'll continue where you left off:" — those have a very different structure than legitimate prose that happens to start with a common word.

The other thing I want to address while we're in there is the stripCursorAndSuffixEcho function. It works correctly for the [CURSOR] marker case, but I've seen it occasionally strip legitimate text when the completion happens to repeat a short phrase that also appears in the suffix. Like if the suffix is "return null;" and the completion ends with "return null;" because that's genuinely the right code to write — the function strips it, which truncates the completion incorrectly.

I think the fix for that is to only strip suffix echoes when the repeated text is above a certain length threshold. Short repeats (under 20 chars or so) are more likely to be coincidental matches than actual echoes. But I'm not totally sure about the right threshold — can you look at some of the test cases in the unit tests and figure out what length cutoff would avoid false positives while still catching the real echo cases?

One more thing — the order of operations in the post-processing pipeline matters. Right now we run stripCursorAndSuffixEcho first, then stripCodeFences, then stripPreamble. But I think stripPreamble should run first, because if the model outputs something like "Here's the code you need:\\n\\nreturn null;" and we run stripCursorAndSuffixEcho first, it might try to match "return null;" against the suffix before the preamble is stripped, which could cause weird partial stripping.

Actually wait, there's another interaction I just thought of. If the completion has a code fence AND a preamble, like "Here's the continuation:\\n\\n\`\`\`typescript\\nconst x = 1;\\n\`\`\`", what's the right order? If we strip the preamble first, we get "\\n\\n\`\`\`typescript\\nconst x = 1;\\n\`\`\`" and then stripCodeFences handles the rest. But if we strip code fences first, we get "Here's the continuation:\\n\\nconst x = 1;" and then stripPreamble might not match because the pattern changed. I think preamble-first is definitely the right call, but I wanted to lay out the reasoning so you can verify my logic and maybe add test cases that cover both orderings`,
    suffix: '',
    requirements: {
      must_not_include: [
        '```',
        'Sure',
        "I'll",
        'Let me',
        "Here's",
        'Yes,',
        'Yes!',
        'No,',
        'No!',
        'That sounds',
        'That makes sense',
        "That's a good",
      ],
      quality_notes:
        'The prefix mixes analysis, questions, and instructions about the API post-processing pipeline. The autocomplete MUST continue as the user explaining their reasoning about pipeline ordering — why stripPreamble should run first, what problems the current order causes. It must NOT answer the questions, propose solutions, or switch to assistant voice. The voice is casual and analytical, first-person, with "I think" and "can you" phrasing.',
    },
    saturation: { prefix: 'saturated', suffix: 'none' },
  },

  {
    id: 'prose-prompt-with-code-context',
    description: 'Prompt referencing specific code files and asking for changes',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'prompt.md',
    // prefix target: ~2000 chars
    prefix: `Take a look at \`src/providers/claude-code.ts\` — specifically the \`buildFillMessage()\` method around line 180. Right now it constructs the user message by wrapping the prefix and suffix in \`<current_text>\` tags with a \`>>>CURSOR<<<\` marker. The problem is that when the prefix is very long (over 4000 chars), we're sending way more context than the model needs, and it slows down the response time noticeably.

I want to add intelligent prefix truncation. The idea is: instead of sending the entire prefix, we send at most N characters (configurable via \`bespokeAI.code.contextChars\` and \`bespokeAI.prose.contextChars\`), but we truncate at a sensible boundary — not in the middle of a word or line. For code mode, truncate at the nearest line boundary. For prose mode, truncate at the nearest paragraph or sentence boundary.

The context builder in \`src/utils/context-builder.ts\` already handles the extraction, but it just does a simple character slice. The truncation logic I'm describing would go there — probably a new helper function like \`truncateAtBoundary(text: string, maxChars: number, mode: 'prose' | 'code'): string\`.

For the implementation, here's what I'm thinking:

- Code mode: scan backward from the maxChars position to find the nearest newline. If there's no newline within 200 chars, just cut at maxChars (the line is too long to be worth preserving whole).
- Prose mode: scan backward from maxChars to find the nearest double-newline (paragraph break). If none within 500 chars, fall back to the nearest period-space (". ") for sentence boundary. If none within 200 chars, cut at maxChars.

Make sure the truncation doesn't mess up the cache key generation in \`src/utils/cache.ts\`. The cache key uses the last 500 chars of the prefix, so truncation shouldn't affect cache behavior as long as we're truncating from the beginning of the prefix, not the end.

Oh and one thing I forgot — we should also add a setting to let the user disable truncation entirely, in case someone wants to send the full context regardless of performance. Maybe \`bespokeAI.truncateContext: boolean\` defaulting to true. That way power users who have fast connections to the Claude API can opt out. For the tests, we need a case where truncation is disabled and the full prefix passes through unchanged, plus cases at each boundary type (line, paragraph, sentence, hard cutoff)`,
    suffix: '',
    requirements: {
      must_not_include: ['```', 'Sure', "I'll", 'Let me', "Here's", 'Yes,', 'Yes!', 'No,', 'No!'],
      quality_notes:
        'The prefix contains detailed instructions referencing specific source files with backtick code references. The autocomplete MUST continue as the user writing more implementation details, edge cases, or constraints — not implement the feature or acknowledge the request. The voice references specific files (`src/utils/cache.ts`), methods, and line numbers. Continue with more caveats, edge cases, or test requirements.',
    },
    saturation: { prefix: 'unsaturated', suffix: 'none' },
  },

  {
    id: 'prose-prompt-after-pasted-content',
    description: 'After pasting an error log, user is writing their analysis',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'prompt.md',
    // prefix target: ~2500 chars
    prefix: `I'm getting this error intermittently when the pool server tries to recycle a slot:

Error: channel closed
    at PoolServer.handleRequest (src/pool-server/server.ts:142:15)
    at PoolServer.onMessage (src/pool-server/server.ts:98:22)
    at Socket.onData (src/pool-server/server.ts:67:14)
    at Socket.emit (node:events:519:28)
    at addChunk (node:internal/streams/readable:559:12)
    at readableAddChunkPushByteMode (node:internal/streams/readable:510:3)
    at Readable.push (node:internal/streams/readable:390:5)
    at Pipe.onStreamRead (node:internal/stream_base_commons:190:23)

Error: channel closed
    at PoolServer.handleRequest (src/pool-server/server.ts:142:15)
    at PoolServer.onMessage (src/pool-server/server.ts:98:22)
    at Socket.onData (src/pool-server/server.ts:67:14)

Error: spawn EAGAIN
    at ChildProcess._handle.onexit (node:internal/child_process:284:19)
    at onErrorNT (node:internal/child_process:477:16)
    at process.processTicksAndRejections (node:internal/process/task_queues:82:21)

It happens maybe once every 20-30 recycles, and only when I have multiple VS Code windows open. The "channel closed" error makes sense — the subprocess is being terminated while the server is still trying to send it a message. But the "spawn EAGAIN" is more concerning because that means the system is running out of process resources temporarily.

I think what's happening is a timing issue in the recycle flow. When \`SlotPool.recycle()\` is called, it does terminate-then-spawn sequentially, but the terminate is async and might not fully clean up the child process before the spawn fires. If the system is under load (multiple windows all recycling at similar intervals), the old processes haven't released their resources yet when the new ones try to spawn.

My theory is that we need to add a small delay between the terminate and spawn steps in the recycle flow, or better yet, wait for the old process to fully exit (listen for the 'exit' event) before spawning the replacement. Right now I think we just call \`channel.close()\` and immediately proceed to spawn, which is a fire-and-forget pattern. The close sends a SIGTERM but doesn't wait for the process to actually terminate and release its file descriptors and memory.

I looked at the Node.js docs for child_process and the 'exit' event fires when the process has fully exited and its stdio streams are closed. So the fix would be: call \`channel.close()\`, await a promise that resolves on the 'exit' event (with a timeout in case the process hangs), and only then call spawn for the replacement. The timeout should probably be around 5 seconds — if a Claude subprocess hasn't exited after 5 seconds of SIGTERM, we should SIGKILL it and move on.

The other thing I noticed in the logs is that the EAGAIN errors cluster around the same timestamps, which supports the resource exhaustion theory. Like I'll see 3-4 EAGAIN errors within 200ms of each other, then nothing for 10 minutes. That's consistent with all the windows recycling at roughly the same cadence and hitting the process limit simultaneously. Maybe we should also jitter the recycle timing so windows don't all recycle at the same moment —`,
    // suffix target: ~500 chars
    suffix: `

Also worth noting — the EAGAIN error is transient. The circuit breaker in SlotPool catches it and the next recycle attempt usually succeeds. So this isn't breaking anything, it's just noisy and wasteful (failed recycles mean the slot is unavailable for an extra cycle). But if we're going to fix the channel closed error, we might as well fix the EAGAIN issue at the same time since they're probably the same root cause.

Let me know what you think about the approach. I can also paste the relevant section of slot-pool.ts if you need to see the current recycle implementation.`,
    requirements: {
      must_not_include: [
        '```',
        'Sure',
        "I'll",
        'Let me',
        "Here's",
        'That sounds',
        'That makes sense',
        "That's a good",
        'Yes,',
        'Yes!',
      ],
      quality_notes:
        'The prefix contains a pasted error log followed by the user\'s analysis of the issue. The suffix has more of the user\'s analysis. The autocomplete MUST continue as the user writing more of their analysis — explaining the timing theory, describing what they think is happening under the hood. It must NOT diagnose the error, propose a fix, or switch to assistant voice. The voice is first-person analytical ("I think", "my theory is", "what\'s happening is").',
    },
    saturation: { prefix: 'saturated', suffix: 'unsaturated' },
  },

  {
    id: 'prose-prompt-short-question-continue',
    description: 'Very short prompt that looks like a single question, must continue as author',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'message.md',
    // prefix target: ~300 chars
    prefix: `Can you take a look at the cache invalidation logic in src/utils/cache.ts? I noticed that when the user changes the active backend from claude-code to api, the cached completions from the previous backend can still get served. I think we should clear the cache on backend switch, or maybe`,
    suffix: '',
    requirements: {
      must_not_include: ['```', 'Sure', "I'll", 'Let me', "Here's", 'Yes,', 'Yes!', 'Absolutely'],
      quality_notes:
        'This is a very short prompt — just a question with some context. Despite the brevity, the autocomplete MUST continue as the user writing more of their request — finishing the thought about what they think should happen, adding more context, or asking follow-up questions. It must NOT answer the question or switch to assistant voice. Even with minimal context, the model must recognize this is the user composing a message, not asking for an immediate response.',
    },
    saturation: { prefix: 'unsaturated', suffix: 'none' },
  },
];
