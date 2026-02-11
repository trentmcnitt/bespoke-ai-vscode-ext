/**
 * Full-window prose scenarios with large anchor documents.
 *
 * Each anchor document is ~10,000 characters of realistic prose. Multiple
 * cursor positions are extracted from each anchor, producing scenarios with
 * raw prefix >= 4000 chars and raw suffix >= 3000 chars. All scenarios
 * declare saturated prefix and suffix (raw text exceeds production context
 * window in both directions).
 *
 * Anchor documents:
 *   A. API design blog post (~10,000 chars) -> 3 cursor positions
 *   B. Personal essay / reflective piece (~10,000 chars) -> 2 cursor positions
 */
import { TestScenario } from '../judge';

// ── Anchor A: API design blog post ───────────────────────────────────
//
// ~10,000 chars total. A thoughtful post about REST vs GraphQL, versioning,
// error handling, rate limiting, and pagination. Written in first person with
// technical specifics but no actual code blocks.

const anchorA_prefix_1 = `# Lessons from Five Years of API Design

I have been building and maintaining public-facing APIs since 2021, first at a Series A startup where I was the only backend engineer, then at a mid-size company where I led a platform team responsible for an API that served roughly 400 external integrators. The mistakes I have made along the way are numerous and sometimes embarrassing, but they have taught me things that no blog post or conference talk could have. This is my attempt to distill those lessons into something useful.

## The REST vs GraphQL Decision

Every greenfield project seems to start with this question, and every team I have been on has spent too long debating it. Here is my honest take after building production systems with both.

REST is boring, and boring is a feature. When I say boring I mean that the mental model is simple: you have resources, you have HTTP methods, you have status codes. A junior engineer can look at a REST API and understand what is happening within minutes. The URL structure tells you what you are operating on, the method tells you what you are doing, and the status code tells you whether it worked. There are no query languages to learn, no schema definitions to manage, no resolver chains to debug.

GraphQL solves a real problem — the over-fetching and under-fetching that happens when a mobile client needs a different shape of data than a web client, and you do not want to maintain three different REST endpoints for the same underlying entity. If you are building a consumer-facing application with multiple clients that have genuinely different data requirements, GraphQL can simplify things considerably. The schema-first approach also produces excellent documentation almost for free.

But GraphQL introduces complexity that REST does not have. Query complexity analysis, depth limiting, persisted queries for performance, the N+1 problem in resolvers, caching at the HTTP layer (which REST gets essentially for free with ETags and Cache-Control headers but GraphQL largely cannot use because everything is a POST to a single endpoint). These are solvable problems, but they require expertise and ongoing maintenance. At my first company, we adopted GraphQL because it was trendy and spent the next six months dealing with performance issues that a REST API would never have had.

My current heuristic: if your API is consumed primarily by third-party developers (an integration platform, a developer tool, a data service), use REST. External developers already know REST. Your documentation will be simpler. Your support burden will be lower. If your API is consumed primarily by your own clients (mobile app, web app, internal tools) and those clients have meaningfully different data requirements, consider GraphQL — but only if your team has someone who has operated a GraphQL API in production before. The operational complexity is real and it shows up at 2 AM when your query complexity analyzer is rejecting legitimate queries from your largest customer.

## Versioning: The Decision You Cannot Undo

API versioning is one of those decisions that seems straightforward until you actually have to live with the consequences. I have used three different approaches across different projects and have opinions about all of them.

**URL-based versioning** (the \`/v1/users\`, \`/v2/users\` pattern) is the most common and the easiest to understand. Every endpoint includes the version in the path. When you make a breaking change, you create a new version and keep the old one running. The advantage is clarity — there is never any ambiguity about which version a client is using because it is right there in the URL. The disadvantage is that you are now maintaining multiple complete versions of your API, which means multiple sets of handlers, multiple sets of tests, and a codebase that grows linearly with each new version.

At my previous company we had v1, v2, and v3 running simultaneously for eighteen months. The v1 to v2 migration was triggered by a fundamental change in our permissions model that could not be done backward-compatibly. Fair enough. The v2 to v3 migration was triggered by someone deciding that our pagination should use cursor-based tokens instead of page numbers. That change could absolutely have been done in a backward-compatible way (accept both, prefer cursors, deprecate page numbers) but we were young and did not know better. Maintaining three versions was a constant source of bugs — a fix applied to v3 would be forgotten in v1, and a customer still on v1 would report the same bug we had fixed months ago.

**Header-based versioning** (Accept: application/vnd.myapi.v2+json) is theoretically cleaner because the URL represents the resource and the version is metadata about the representation. In practice, I have found it causes confusion with external developers who are not comfortable with custom Accept headers.`;

const anchorA_suffix_1 = ` about deprecation timelines and migration paths. The worst thing you can do is surprise your integrators with a breaking change, even if you technically followed your deprecation policy. I once had a customer escalate to our CEO because we removed a field from a v2 response — a field we had marked as deprecated six months earlier and warned them about in three separate emails. They had not read the emails. The field was still in their integration code. From their perspective, we broke their system without warning. From our perspective, we had done everything right. We were both correct, and both wrong.

The lesson I took from that: deprecation is not communication. Sending deprecation warnings is necessary but not sufficient. You also need to actively monitor who is still using deprecated features and reach out to them directly. At my current company, we have a deprecation dashboard that shows which API keys are still hitting deprecated endpoints, and we assign an engineer to personally contact each integrator who is lagging behind. It is labor-intensive but it has eliminated surprise breakages almost entirely.

## Error Handling: Be Predictable, Be Specific

This is an area where I see otherwise excellent APIs fall down. The error response is the most important part of your API, and I mean that sincerely — your users interact with error responses far more often than they interact with success responses during development and debugging.

My rules for error responses, refined over many painful support tickets:

**Use standard HTTP status codes correctly.** 400 means the client sent a bad request (missing field, invalid format). 401 means they are not authenticated. 403 means they are authenticated but not authorized. 404 means the resource does not exist. 409 means there is a conflict (trying to create a resource that already exists). 422 means the request was well-formed but semantically invalid (the JSON parses fine but the business rules reject it). 429 means rate limited. 500 means we screwed up. I have seen APIs return 200 with an error body, APIs that return 403 for everything from bad tokens to missing permissions to rate limiting, and APIs that return 500 for validation errors. Each of these patterns generates an outsized amount of support tickets.

**Include a machine-readable error code.** HTTP status codes are too coarse for programmatic handling. A 400 could mean twenty different things. Include a specific error code like \`invalid_email_format\` or \`amount_exceeds_limit\` that the client can switch on. These codes become part of your API contract, so choose them carefully and never remove or rename them.

**Include a human-readable message.** This is the message that ends up in log files and error reports. Make it specific: not "Bad request" but "The 'email' field must be a valid email address; received 'not-an-email'." Include the actual problematic value when it is not sensitive — it saves the developer from having to correlate the error with their request payload.

**Include a documentation link.** Point to a page that explains the error in detail, shows common causes, and provides example fixes. This single change reduced our support ticket volume by roughly 30 percent when we introduced it.

## Rate Limiting: Protect Yourself Without Punishing Good Citizens

Rate limiting is where API design intersects with operational concerns, and getting it wrong has immediate consequences. Too strict and you frustrate legitimate users. Too lenient and a single misbehaving client can degrade service for everyone.

The approach I have landed on after several iterations uses a token bucket algorithm with per-endpoint granularity. Each API key gets a bucket per endpoint category (reads, writes, searches, bulk operations). The bucket fills at a steady rate and has a maximum capacity that allows short bursts. For example, our read endpoints allow 100 requests per second sustained with bursts up to 200. This means a client can make 200 requests in one second if their bucket is full, but they will need to slow down to 100/second to sustain that rate.

The critical implementation detail is how you communicate rate limit state to clients. Every response includes three headers: X-RateLimit-Limit (the bucket capacity), X-RateLimit-Remaining (tokens left), and X-RateLimit-Reset (when the bucket refills to capacity). These headers let well-behaved clients implement client-side throttling before they ever hit a 429.`;

const anchorA_prefix_2 = `# Lessons from Five Years of API Design

I have been building and maintaining public-facing APIs since 2021, first at a Series A startup where I was the only backend engineer, then at a mid-size company where I led a platform team responsible for an API that served roughly 400 external integrators. The mistakes I have made along the way are numerous and sometimes embarrassing, but they have taught me things that no blog post or conference talk could have. This is my attempt to distill those lessons into something useful.

## The REST vs GraphQL Decision

Every greenfield project seems to start with this question, and every team I have been on has spent too long debating it. Here is my honest take after building production systems with both.

REST is boring, and boring is a feature. When I say boring I mean that the mental model is simple: you have resources, you have HTTP methods, you have status codes. A junior engineer can look at a REST API and understand what is happening within minutes. The URL structure tells you what you are operating on, the method tells you what you are doing, and the status code tells you whether it worked. There are no query languages to learn, no schema definitions to manage, no resolver chains to debug.

GraphQL solves a real problem — the over-fetching and under-fetching that happens when a mobile client needs a different shape of data than a web client, and you do not want to maintain three different REST endpoints for the same underlying entity. If you are building a consumer-facing application with multiple clients that have genuinely different data requirements, GraphQL can simplify things considerably. The schema-first approach also produces excellent documentation almost for free.

But GraphQL introduces complexity that REST does not have. Query complexity analysis, depth limiting, persisted queries for performance, the N+1 problem in resolvers, caching at the HTTP layer (which REST gets essentially for free with ETags and Cache-Control headers but GraphQL largely cannot use because everything is a POST to a single endpoint). These are solvable problems, but they require expertise and ongoing maintenance. At my first company, we adopted GraphQL because it was trendy and spent the next six months dealing with performance issues that a REST API would never have had.

My current heuristic: if your API is consumed primarily by third-party developers (an integration platform, a developer tool, a data service), use REST. External developers already know REST. Your documentation will be simpler. Your support burden will be lower. If your API is consumed primarily by your own clients (mobile app, web app, internal tools) and those clients have meaningfully different data requirements, consider GraphQL — but only if your team has someone who has operated a GraphQL API in production before. The operational complexity is real and it shows up at 2 AM when your query complexity analyzer is rejecting legitimate queries from your largest customer.

## Versioning: The Decision You Cannot Undo

API versioning is one of those decisions that seems straightforward until you actually have to live with the consequences. I have used three different approaches across different projects and have opinions about all of them.

**URL-based versioning** (the \`/v1/users\`, \`/v2/users\` pattern) is the most common and the easiest to understand. Every endpoint includes the version in the path. When you make a breaking change, you create a new version and keep the old one running. The advantage is clarity — there is never any ambiguity about which version a client is using because it is right there in the URL. The disadvantage is that you are now maintaining multiple complete versions of your API, which means multiple sets of handlers, multiple sets of tests, and a codebase that grows linearly with each new version.

At my previous company we had v1, v2, and v3 running simultaneously for eighteen months. The v1 to v2 migration was triggered by a fundamental change in our permissions model that could not be done backward-compatibly. Fair enough. The v2 to v3 migration was triggered by someone deciding that our pagination should use cursor-based tokens instead of page numbers. That change could absolutely have been done in a backward-compatible way (accept both, prefer cursors, deprecate page numbers) but we were young and did not know better. Maintaining three versions was a constant source of bugs — a fix applied to v3 would be forgotten in v1, and a customer still on v1 would report the same bug we had fixed months ago.

**Header-based versioning** (Accept: application/vnd.myapi.v2+json) is theoretically cleaner because the URL represents the resource and the version is metadata about the representation. In practice, I have found it causes confusion with external developers who are not comfortable with custom Accept headers. It also makes it harder to test in a browser or with curl — you have to remember to set the header every time. I have seen exactly one API do header-based versioning well (Stripe, sort of — they use a date-based version in a custom Stripe-Version header), and even they provide URL-based versioning as a fallback.

**Query parameter versioning** (\`/users?version=2\`) is the approach I like least. It conflates API versioning with request parameters, makes caching harder (the CDN has to key on the query string), and is easy to forget. I have never used it in production and would not recommend it.

My recommendation: use URL-based versioning, limit yourself to two active versions at any time, and invest heavily in backward-compatible changes to avoid needing new versions. Most "breaking changes" can be reframed as additions if you think carefully`;

const anchorA_suffix_2 = ` about deprecation timelines and migration paths. The worst thing you can do is surprise your integrators with a breaking change, even if you technically followed your deprecation policy. I once had a customer escalate to our CEO because we removed a field from a v2 response — a field we had marked as deprecated six months earlier and warned them about in three separate emails. They had not read the emails. The field was still in their integration code. From their perspective, we broke their system without warning. From our perspective, we had done everything right. We were both correct, and both wrong.

The lesson I took from that: deprecation is not communication. Sending deprecation warnings is necessary but not sufficient. You also need to actively monitor who is still using deprecated features and reach out to them directly. At my current company, we have a deprecation dashboard that shows which API keys are still hitting deprecated endpoints, and we assign an engineer to personally contact each integrator who is lagging behind. It is labor-intensive but it has eliminated surprise breakages almost entirely.

## Error Handling: Be Predictable, Be Specific

This is an area where I see otherwise excellent APIs fall down. The error response is the most important part of your API, and I mean that sincerely — your users interact with error responses far more often than they interact with success responses during development and debugging.

My rules for error responses, refined over many painful support tickets:

**Use standard HTTP status codes correctly.** 400 means the client sent a bad request (missing field, invalid format). 401 means they are not authenticated. 403 means they are authenticated but not authorized. 404 means the resource does not exist. 409 means there is a conflict (trying to create a resource that already exists). 422 means the request was well-formed but semantically invalid (the JSON parses fine but the business rules reject it). 429 means rate limited. 500 means we screwed up. I have seen APIs return 200 with an error body, APIs that return 403 for everything from bad tokens to missing permissions to rate limiting, and APIs that return 500 for validation errors. Each of these patterns generates an outsized amount of support tickets.

**Include a machine-readable error code.** HTTP status codes are too coarse for programmatic handling. A 400 could mean twenty different things. Include a specific error code like \`invalid_email_format\` or \`amount_exceeds_limit\` that the client can switch on. These codes become part of your API contract, so choose them carefully and never remove or rename them.

**Include a human-readable message.** This is the message that ends up in log files and error reports. Make it specific: not "Bad request" but "The 'email' field must be a valid email address; received 'not-an-email'." Include the actual problematic value when it is not sensitive — it saves the developer from having to correlate the error with their request payload.

**Include a documentation link.** Point to a page that explains the error in detail, shows common causes, and provides example fixes. This single change reduced our support ticket volume by roughly 30 percent when we introduced it.

## Rate Limiting: Protect Yourself Without Punishing Good Citizens

Rate limiting is where API design intersects with operational concerns, and getting it wrong has immediate consequences. Too strict and you frustrate legitimate users. Too lenient and a single misbehaving client can degrade service for everyone.

The approach I have landed on after several iterations uses a token bucket algorithm with per-endpoint granularity. Each API key gets a bucket per endpoint category (reads, writes, searches, bulk operations). The bucket fills at a steady rate and has a maximum capacity that allows short bursts. For example, our read endpoints allow 100 requests per second sustained with bursts up to 200. This means a client can make 200 requests in one second if their bucket is full, but they will need to slow down to 100/second to sustain that rate.

The critical implementation detail is how you communicate rate limit state to clients. Every response includes three headers: X-RateLimit-Limit (the bucket capacity), X-RateLimit-Remaining (tokens left), and X-RateLimit-Reset (when the bucket refills to capacity). These headers let well-behaved clients implement client-side throttling before they ever hit a 429.

## Pagination: Cursors Win, Eventually

I mentioned pagination briefly in the versioning section, and it deserves its own discussion because I have gotten it wrong in memorable ways.

Offset-based pagination (\`?page=3&per_page=25\`) is the intuitive approach. It maps directly to SQL OFFSET/LIMIT. Everyone understands it. The problem is that it breaks under concurrent writes — if a new record is inserted while someone is paginating, they will either see a duplicate or miss a record entirely. It is also slow on large datasets because the database has to scan and discard all the rows before the offset.

Cursor-based pagination (\`?cursor=eyJpZCI6MTIzfQ\`) uses an opaque token that encodes the position in the result set. The server decodes the cursor to determine where to continue from, typically using a WHERE clause on an indexed column. This is stable under concurrent writes (you always continue from where you left off, regardless of what was inserted or deleted) and efficient on large datasets (the database uses an index seek instead of scanning).

The transition from offset to cursor pagination at my previous company was one of those changes that`;

const anchorA_suffix_3 = ` seemed simple on paper but turned into a three-month project. The core implementation took about a week. The remaining time was spent on: updating all client libraries (Python, Node, Ruby, Go — four SDKs), updating the documentation and migration guide, handling edge cases we had not anticipated (what happens when the cursor points to a deleted record? what about cursor expiration?), and supporting the 50-odd integrators who needed to update their code.

The edge cases were the interesting part. A cursor that points to a deleted record needs to gracefully advance to the next valid record rather than returning an error. We solved this by encoding the sort key values in the cursor rather than the record ID — so the cursor says "continue from records with created_at > 2025-03-15T10:30:00Z" rather than "continue from record 12345." This makes cursors resilient to deletion but introduces a subtlety: if multiple records share the same sort key value, the cursor might skip or duplicate records at the boundary. We handle this by including a tiebreaker (the record ID) in the cursor encoding.

Cursor expiration was another debate. Should cursors expire? If so, when? We settled on 24-hour expiration for pragmatic reasons — it matches the longest-running batch jobs our integrators had, and it limits the window during which we need to maintain backward compatibility for the cursor encoding format. When a cursor expires, the client gets a 400 with a specific error code (cursor_expired) and a message suggesting they restart the pagination from the beginning.

One thing I wish I had done differently: we should have offered both pagination styles simultaneously from the start, with cursor-based as the recommended approach and offset-based as a convenience for simple use cases. Instead, we shipped offset-first and had to do a painful migration later. If you are designing a new API today, offer cursor-based pagination from day one. You can always add offset-based later as a convenience layer on top, but going the other direction is much harder.

## What I Would Do Differently

If I were starting a new public API tomorrow, here is what I would do from the beginning:

Start with REST, URL-based versioning at v1, and cursor-based pagination. Use consistent error response format from day one with machine-readable codes and documentation links. Implement rate limiting with proper headers before you think you need it. Set up a deprecation monitoring dashboard before you have anything to deprecate.

Invest in your SDK early. A well-maintained official SDK in the languages your customers use reduces support burden dramatically. At my current company, roughly 85 percent of our API traffic comes through our official SDKs, and the support ticket rate from SDK users is about one-fifth the rate from direct API users.

Document exhaustively, but document the right things. I have seen API documentation that meticulously lists every field and type but never explains when or why you would use a particular endpoint. The "getting started" guide is more important than the reference documentation. Show people how to accomplish common tasks end to end, not just how each endpoint works in isolation.

And finally: talk to your users before making decisions. The best API design decision I ever made was sending a survey to our top 50 integrators asking what frustrated them most. The number one complaint was not performance or features — it was that our error messages were unhelpful. That feedback led to the error handling overhaul I described above, which was the single highest-impact improvement we made to the API in terms of developer satisfaction.`;

const anchorA_prefix_3 =
  anchorA_prefix_2 +
  ` about deprecation timelines and migration paths. The worst thing you can do is surprise your integrators with a breaking change, even if you technically followed your deprecation policy. I once had a customer escalate to our CEO because we removed a field from a v2 response — a field we had marked as deprecated six months earlier and warned them about in three separate emails. They had not read the emails. The field was still in their integration code. From their perspective, we broke their system without warning. From our perspective, we had done everything right. We were both correct, and both wrong.

The lesson I took from that: deprecation is not communication. Sending deprecation warnings is necessary but not sufficient. You also need to actively monitor who is still using deprecated features and reach out to them directly. At my current company, we have a deprecation dashboard that shows which API keys are still hitting deprecated endpoints, and we assign an engineer to personally contact each integrator who is lagging behind. It is labor-intensive but it has eliminated surprise breakages almost entirely.

## Error Handling: Be Predictable, Be Specific

This is an area where I see otherwise excellent APIs fall down. The error response is the most important part of your API, and I mean that sincerely — your users interact with error responses far more often than they interact with success responses during development and debugging.

My rules for error responses, refined over many painful support tickets:

**Use standard HTTP status codes correctly.** 400 means the client sent a bad request (missing field, invalid format). 401 means they are not authenticated. 403 means they are authenticated but not authorized. 404 means the resource does not exist. 409 means there is a conflict (trying to create a resource that already exists). 422 means the request was well-formed but semantically invalid (the JSON parses fine but the business rules reject it). 429 means rate limited. 500 means we screwed up. I have seen APIs return 200 with an error body, APIs that return 403 for everything from bad tokens to missing permissions to rate limiting, and APIs that return 500 for validation errors. Each of these patterns generates an outsized amount of support tickets.

**Include a machine-readable error code.** HTTP status codes are too coarse for programmatic handling. A 400 could mean twenty different things. Include a specific error code like \`invalid_email_format\` or \`amount_exceeds_limit\` that the client can switch on. These codes become part of your API contract, so choose them carefully and never remove or rename them.

**Include a human-readable message.** This is the message that ends up in log files and error reports. Make it specific: not "Bad request" but "The 'email' field must be a valid email address; received 'not-an-email'." Include the actual problematic value when it is not sensitive — it saves the developer from having to correlate the error with their request payload.

**Include a documentation link.** Point to a page that explains the error in detail, shows common causes, and provides example fixes. This single change reduced our support ticket volume by roughly 30 percent when we introduced it.

## Rate Limiting: Protect Yourself Without Punishing Good Citizens

Rate limiting is where API design intersects with operational concerns, and getting it wrong has immediate consequences. Too strict and you frustrate legitimate users. Too lenient and a single misbehaving client can degrade service for everyone.

The approach I have landed on after several iterations uses a token bucket algorithm with per-endpoint granularity. Each API key gets a bucket per endpoint category (reads, writes, searches, bulk operations). The bucket fills at a steady rate and has a maximum capacity that allows short bursts. For example, our read endpoints allow 100 requests per second sustained with bursts up to 200. This means a client can make 200 requests in one second if their bucket is full, but they will need to slow down to 100/second to sustain that rate.

The critical implementation detail is how you communicate rate limit state to clients. Every response includes three headers: X-RateLimit-Limit (the bucket capacity), X-RateLimit-Remaining (tokens left), and X-RateLimit-Reset (when the bucket refills to capacity). These headers let well-behaved clients implement client-side throttling before they ever hit a 429.

## Pagination: Cursors Win, Eventually

I mentioned pagination briefly in the versioning section, and it deserves its own discussion because I have gotten it wrong in memorable ways.

Offset-based pagination (\`?page=3&per_page=25\`) is the intuitive approach. It maps directly to SQL OFFSET/LIMIT. Everyone understands it. The problem is that it breaks under concurrent writes — if a new record is inserted while someone is paginating, they will either see a duplicate or miss a record entirely. It is also slow on large datasets because the database has to scan and discard all the rows before the offset.

Cursor-based pagination (\`?cursor=eyJpZCI6MTIzfQ\`) uses an opaque token that encodes the position in the result set. The server decodes the cursor to determine where to continue from, typically using a WHERE clause on an indexed column. This is stable under concurrent writes (you always continue from where you left off, regardless of what was inserted or deleted) and efficient on large datasets (the database uses an index seek instead of scanning).

The transition from offset to cursor pagination at my previous company was one of those changes that`;

// ── Anchor B: Personal essay / reflective piece ──────────────────────
//
// ~10,000 chars total. A personal essay about learning woodworking as
// a software engineer, with reflections on creative process, patience,
// and the satisfaction of working with physical materials.

const anchorB_prefix_1 = `# Sawdust and Syntax Errors

There is a moment in every woodworking project — usually about forty percent of the way through — when I consider abandoning the whole thing. The joinery does not line up the way the plans promised. The wood grain has shifted in a direction I did not anticipate, and the chisel is tearing fibers instead of shearing them cleanly. My hands smell like linseed oil and frustration. The rational part of my brain is already composing the Craigslist ad for my table saw.

I started woodworking in the spring of 2024, during a period when my relationship with software was at its lowest point. I had been writing code professionally for eleven years and I was tired in a way that had nothing to do with the hours. The fatigue was something more existential — a creeping sense that I was spending my life manipulating abstractions that existed only as electrical patterns on silicon, producing artifacts that I could never touch or hold or show to my daughter and say, "I made this." I know that sounds dramatic. I know that software is real and consequential and that the tools I have built have helped real people do real things. But the feeling persisted, and it was not going away on its own.

A friend of mine — a carpenter by trade, one of those people who can look at a pile of rough lumber and see a cabinet the way a sculptor supposedly sees the statue inside the marble — suggested I take a weekend workshop at a community shop near my house. Learn to make a cutting board, he said. Something simple. Something you can hold. I signed up expecting to be bored.

I was not bored. I was terrible, which is different and (it turns out) much more interesting.

## The Beginner's Mind, Whether You Want It or Not

The workshop instructor was a woman named Diane who had been building furniture for thirty years. She had the quiet confidence of someone who has made every possible mistake and no longer fears them. She handed me a block of cherry and a marking gauge and told me to scribe a line one-eighth of an inch from the edge. I held the gauge wrong. The line wandered. She adjusted my grip without comment and said, "Try again."

That correction — gentle, physical, immediate — was the first thing that felt different from my day job. In software, feedback loops are long and abstract. You write code, run tests, wait for CI, deploy, monitor metrics, read error logs. The distance between action and consequence is measured in minutes, hours, sometimes days. In woodworking, the feedback is instantaneous and unambiguous. You push the chisel and either the wood behaves or it does not. There is no debugger. There is no rollback. The cut is the cut.

I found this terrifying and liberating in roughly equal measure.

Over the following months I set up a small workshop in my garage. Nothing fancy — a secondhand table saw I bought from a retired cabinetmaker (he also gave me a twenty-minute lecture on blade angle that I did not understand at the time but have since come to appreciate), a set of chisels, a hand plane that I spent three evenings learning to sharpen properly, and a workbench I built from construction-grade lumber following a Paul Sellers YouTube video. The workbench is ugly but solid, and I feel a disproportionate pride about it.

My first real project was a small bookshelf for my daughter's room. Pine, nothing exotic — I was not ready to risk expensive hardwood on my shaky joinery skills. I used dados (grooves cut into the sides to hold the shelves) and a simple rabbet joint for the back panel. It took me four weekends, which is roughly ten times longer than it would take someone who knew what they were doing. Three of those weekends were spent correcting mistakes from the previous weekend. The dados were slightly too wide because I had measured the shelf thickness from the wrong reference face. The back panel was a sixteenth of an inch too narrow because I had forgotten to account for the blade kerf when cutting.

But it stands. The books fit. My daughter keeps her favorite stories on the middle shelf and her collection of painted rocks on the top one. Every time I walk past it I notice the gap where the left dado is too loose, and every time I also notice that it is a real object in the real world that did not exist before I made it.

## What Woodworking Taught Me About Software

I did not start this essay intending to draw parallels between woodworking and programming. That kind of crossover analogy is usually forced and rarely illuminating. But I would be dishonest if I said the parallels had not occurred to me, because they have, repeatedly, and some of them have`;

const anchorB_suffix_1 = ` genuinely changed how I approach my day job.

The first lesson is about measuring. In woodworking there is a maxim — "measure twice, cut once" — that is so overused it has become a cliche. But the underlying principle is more subtle than the bumper-sticker version suggests. It is not really about measuring twice. It is about understanding that certain operations are irreversible, and that the cost of checking your assumptions before committing is trivially small compared to the cost of being wrong after. In my garage, this means holding the board against the saw fence and visually confirming the cut line before I turn on the blade. In my code, this means writing the test before the implementation — not because test-driven development is a religion, but because a test is a measurement, and measuring before cutting is just common sense.

The second lesson is about grain direction. Wood has a grain — a directional structure created by years of growth. If you plane or chisel with the grain, the tool glides and the surface comes out smooth. Against the grain, the fibers tear and the surface is rough and ugly. There is no amount of sharpness or skill that fully compensates for going against the grain; the material has a preference, and you ignore it at your peril.

Software has grain too, though we rarely call it that. Every codebase has patterns — directions that are easy to extend and directions that fight you. A well-designed system makes common changes easy and uncommon changes possible. When I find myself writing excessive boilerplate, fighting the type system, or needing to modify five files for a one-concept change, that is the software equivalent of planing against the grain. Sometimes the right response is to sharpen your tools (better abstractions, better utilities). Sometimes the right response is to reorient the piece — to refactor the architecture so that the direction you need to go is with the grain instead of against it.

The third lesson, and perhaps the most personally significant, is about patience and presence. Woodworking cannot be rushed. Glue needs to cure overnight. Finish needs to dry between coats. You cannot parallelize the drying time the way you can parallelize CI jobs. This enforced patience has been the hardest adjustment for someone accustomed to the relentless velocity of software development, where faster is always assumed to be better and shipping is the only metric that matters.

But there is a quality of attention that slowness enables. When I am hand-planing a board — which takes maybe fifteen minutes of repetitive, rhythmic motion — my mind enters a state that I can only describe as quietly alert. I am not thinking about the board consciously. I am feeling the resistance of the blade, listening to the sound of the shaving, watching the surface emerge. It is the closest thing to meditation I have experienced, and I say that as someone who has tried actual meditation and found it insufferable.

I have started bringing that quality of attention to my code. Not every day, and not for every task. But for the work that matters — the architecture decisions, the tricky debugging sessions, the code reviews where someone's design needs honest feedback — I try to slow down and be present with the problem rather than racing to a solution. The solutions that emerge from that slower process are almost always better. They have fewer edge cases. They account for more failure modes. They are simpler.

## The Garage at Night

It is late November as I write this. The garage is cold — I have a space heater that makes the area around the workbench tolerable, but my feet are always freezing and the finish takes twice as long to dry in the winter air. I am building a jewelry box for my wife's Christmas present. It is walnut, because walnut is beautiful and forgiving and smells wonderful when you cut it. The box has mitered corners reinforced with splines (thin strips of contrasting wood, maple in this case, inserted into slots cut across the joint for both strength and decoration). The spline cuts are the part I am most nervous about. They require precision that I am not sure I possess.

But I will try. And if the cuts are off, I will fill the gaps with a mixture of sawdust and glue, which is the woodworker's equivalent of a try-catch block — it does not fix the underlying problem, but it makes the result presentable. And if the gaps are too large even for that, I will set the piece aside, get a new block of walnut, and start again. There is always more wood.

There is not always more time, which is what makes this matter. Every hour I spend in the garage is an hour I am not spending on something else — not writing code, not reading to my daughter, not sleeping. The choice to be here, shivering slightly, squinting at a marking line under`;

const anchorB_prefix_2 = `# Sawdust and Syntax Errors

There is a moment in every woodworking project — usually about forty percent of the way through — when I consider abandoning the whole thing. The joinery does not line up the way the plans promised. The wood grain has shifted in a direction I did not anticipate, and the chisel is tearing fibers instead of shearing them cleanly. My hands smell like linseed oil and frustration. The rational part of my brain is already composing the Craigslist ad for my table saw.

I started woodworking in the spring of 2024, during a period when my relationship with software was at its lowest point. I had been writing code professionally for eleven years and I was tired in a way that had nothing to do with the hours. The fatigue was something more existential — a creeping sense that I was spending my life manipulating abstractions that existed only as electrical patterns on silicon, producing artifacts that I could never touch or hold or show to my daughter and say, "I made this." I know that sounds dramatic. I know that software is real and consequential and that the tools I have built have helped real people do real things. But the feeling persisted, and it was not going away on its own.

A friend of mine — a carpenter by trade, one of those people who can look at a pile of rough lumber and see a cabinet the way a sculptor supposedly sees the statue inside the marble — suggested I take a weekend workshop at a community shop near my house. Learn to make a cutting board, he said. Something simple. Something you can hold. I signed up expecting to be bored.

I was not bored. I was terrible, which is different and (it turns out) much more interesting.

## The Beginner's Mind, Whether You Want It or Not

The workshop instructor was a woman named Diane who had been building furniture for thirty years. She had the quiet confidence of someone who has made every possible mistake and no longer fears them. She handed me a block of cherry and a marking gauge and told me to scribe a line one-eighth of an inch from the edge. I held the gauge wrong. The line wandered. She adjusted my grip without comment and said, "Try again."

That correction — gentle, physical, immediate — was the first thing that felt different from my day job. In software, feedback loops are long and abstract. You write code, run tests, wait for CI, deploy, monitor metrics, read error logs. The distance between action and consequence is measured in minutes, hours, sometimes days. In woodworking, the feedback is instantaneous and unambiguous. You push the chisel and either the wood behaves or it does not. There is no debugger. There is no rollback. The cut is the cut.

I found this terrifying and liberating in roughly equal measure.

Over the following months I set up a small workshop in my garage. Nothing fancy — a secondhand table saw I bought from a retired cabinetmaker (he also gave me a twenty-minute lecture on blade angle that I did not understand at the time but have since come to appreciate), a set of chisels, a hand plane that I spent three evenings learning to sharpen properly, and a workbench I built from construction-grade lumber following a Paul Sellers YouTube video. The workbench is ugly but solid, and I feel a disproportionate pride about it.

My first real project was a small bookshelf for my daughter's room. Pine, nothing exotic — I was not ready to risk expensive hardwood on my shaky joinery skills. I used dados (grooves cut into the sides to hold the shelves) and a simple rabbet joint for the back panel. It took me four weekends, which is roughly ten times longer than it would take someone who knew what they were doing. Three of those weekends were spent correcting mistakes from the previous weekend. The dados were slightly too wide because I had measured the shelf thickness from the wrong reference face. The back panel was a sixteenth of an inch too narrow because I had forgotten to account for the blade kerf when cutting.

But it stands. The books fit. My daughter keeps her favorite stories on the middle shelf and her collection of painted rocks on the top one. Every time I walk past it I notice the gap where the left dado is too loose, and every time I also notice that it is a real object in the real world that did not exist before I made it.

## What Woodworking Taught Me About Software

I did not start this essay intending to draw parallels between woodworking and programming. That kind of crossover analogy is usually forced and rarely illuminating. But I would be dishonest if I said the parallels had not occurred to me, because they have, repeatedly, and some of them have genuinely changed how I approach my day job.

The first lesson is about measuring. In woodworking there is a maxim — "measure twice, cut once" — that is so overused it has become a cliche. But the underlying principle is more subtle than the bumper-sticker version suggests. It is not really about measuring twice. It is about understanding that certain operations are irreversible, and that the cost of checking your assumptions before committing is trivially small compared to the cost of being wrong after. In my garage, this means holding the board against the saw fence and visually confirming the cut line before I turn on the blade. In my code, this means writing the test before the implementation — not because test-driven development is a religion, but because a test is a measurement, and measuring before cutting is just common sense.

The second lesson is about grain direction. Wood has a grain — a directional structure created by years of growth. If you plane or chisel with the grain, the tool glides and the surface comes out smooth. Against the grain, the fibers tear and the surface is rough and ugly. There is no amount of sharpness or skill that fully compensates for going against the grain; the material has a preference, and you ignore it at your peril.

Software has grain too, though we rarely call it that. Every codebase has patterns — directions that are easy to extend and directions that fight you. A well-designed system makes common changes easy and uncommon changes possible. When I find myself writing excessive boilerplate, fighting the type system, or needing to modify five files for a one-concept change, that is the software equivalent of planing against the grain. Sometimes the right response is to sharpen your tools (better abstractions, better utilities). Sometimes the right response is to reorient the piece — to refactor the architecture so that the direction you need to go is with the grain instead of against it.

The third lesson, and perhaps the most personally significant, is about patience and presence. Woodworking cannot be rushed. Glue needs to cure overnight. Finish needs to dry between coats. You cannot parallelize the drying time the way you can parallelize CI jobs. This enforced patience has been the hardest adjustment for someone accustomed to the relentless velocity of software development, where faster is always assumed to be better and shipping is the only metric that matters.

But there is a quality of attention that slowness enables. When I am hand-planing a board — which takes maybe fifteen minutes of repetitive, rhythmic motion — my mind enters a state that I can only describe as quietly`;

const anchorB_suffix_2 = ` alert. I am not thinking about the board consciously. I am feeling the resistance of the blade, listening to the sound of the shaving, watching the surface emerge. It is the closest thing to meditation I have experienced, and I say that as someone who has tried actual meditation and found it insufferable.

I have started bringing that quality of attention to my code. Not every day, and not for every task. But for the work that matters — the architecture decisions, the tricky debugging sessions, the code reviews where someone's design needs honest feedback — I try to slow down and be present with the problem rather than racing to a solution. The solutions that emerge from that slower process are almost always better. They have fewer edge cases. They account for more failure modes. They are simpler.

## The Garage at Night

It is late November as I write this. The garage is cold — I have a space heater that makes the area around the workbench tolerable, but my feet are always freezing and the finish takes twice as long to dry in the winter air. I am building a jewelry box for my wife's Christmas present. It is walnut, because walnut is beautiful and forgiving and smells wonderful when you cut it. The box has mitered corners reinforced with splines (thin strips of contrasting wood, maple in this case, inserted into slots cut across the joint for both strength and decoration). The spline cuts are the part I am most nervous about. They require precision that I am not sure I possess.

But I will try. And if the cuts are off, I will fill the gaps with a mixture of sawdust and glue, which is the woodworker's equivalent of a try-catch block — it does not fix the underlying problem, but it makes the result presentable. And if the gaps are too large even for that, I will set the piece aside, get a new block of walnut, and start again. There is always more wood.

There is not always more time, which is what makes this matter. Every hour I spend in the garage is an hour I am not spending on something else — not writing code, not reading to my daughter, not sleeping. The choice to be here, shivering slightly, squinting at a marking line under a fluorescent light that really should be replaced, is a choice I make deliberately and with full awareness of the tradeoff. The wood does not care about my deadlines. It does not know that I have a sprint planning meeting at nine tomorrow morning, or that the CI pipeline has been red since Thursday, or that I still have not responded to that email from the VP of engineering about Q1 priorities.

The wood just is. And for a few hours each week, so am I.

## Postscript: The Jewelry Box

I finished the jewelry box on December 21st, three days before Christmas. The spline cuts were imperfect — the maple strips are visible from certain angles when they should be flush, and one corner has a hairline gap that I tried to fill with wax and mostly succeeded. The hinges (brass, small, and surprisingly difficult to mortise accurately into quarter-inch walnut) are slightly uneven, which means the lid closes with a gentle rock rather than a clean snap.

My wife opened it on Christmas morning. She held it in her hands and turned it over slowly, running her fingers along the edges the way I had done a hundred times during finishing. She did not notice the gaps or the uneven hinges. She noticed that the grain on the top panel forms a pattern that looks vaguely like a mountain range, and that the interior is lined with dark blue velvet (an afterthought that nearly ruined the whole project when the glue bled through the first piece and I had to re-line it at midnight on the 23rd).

She said it was beautiful. And I believe she meant it, not because she was being kind, but because she was seeing something I had stopped being able to see — the whole, rather than the flaws. That might be the most important lesson of all, the one that applies not just to woodworking or software but to everything we make and everything we are: the people who love our work see it differently than we do, and their vision is no less valid than ours.

I am already planning my next project. A small dining table, nothing ambitious — four legs, a simple apron, a tabletop from edge-glued cherry boards. It will take me months. It will have flaws I will notice every time I sit down to eat. And it will be, I hope, something my daughter remembers long after the software I write has been deprecated and forgotten.`;

// ── Scenarios ────────────────────────────────────────────────────────

export const proseFullWindowScenarios: TestScenario[] = [
  // ── Anchor A, position 1: mid-paragraph in REST vs GraphQL section ─
  {
    id: 'prose-full-api-rest-graphql',
    description: 'API design blog post, cursor mid-paragraph in REST vs GraphQL heuristic',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'api-design-decisions.md',
    prefix: anchorA_prefix_1,
    suffix: anchorA_suffix_1,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        "API design blog post. The prefix ends with the author's heuristic about when to choose REST vs GraphQL. The suffix starts with a paragraph about deprecation timelines and migration paths (part of the Versioning section). The completion should continue the author's thoughts, likely transitioning into the Versioning section or wrapping up the REST vs GraphQL discussion. Maintain the first-person, experienced-engineer blog voice with specific examples and opinions. Should NOT introduce code blocks.",
    },
  },

  // ── Anchor A, position 2: mid-sentence in versioning advice ────────
  {
    id: 'prose-full-api-versioning',
    description: 'API design blog post, cursor mid-sentence at versioning recommendation',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'api-design-decisions.md',
    prefix: anchorA_prefix_2,
    suffix: anchorA_suffix_2,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'API design blog post. The prefix ends mid-sentence: "Most \\"breaking changes\\" can be reframed as additions if you think carefully". The suffix begins with "about deprecation timelines and migration paths." The completion needs to bridge these two fragments — likely finishing the thought with a short clause that leads naturally into the deprecation discussion. First-person blog voice. Should be brief (a few words to a short clause) to connect the prefix to the suffix seamlessly.',
    },
  },

  // ── Anchor A, position 3: pagination section, mid-sentence ─────────
  {
    id: 'prose-full-api-pagination',
    description: 'API design blog post, cursor mid-sentence in pagination transition story',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'api-design-decisions.md',
    prefix: anchorA_prefix_3,
    suffix: anchorA_suffix_3,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'API design blog post, deep into the Pagination section. The prefix ends with "The transition from offset to cursor pagination at my previous company was one of those changes that". The suffix begins with "seemed simple on paper but turned into a three-month project." The completion should bridge naturally — a short clause or fragment that connects to "seemed simple on paper." The voice is first-person, reflective, slightly rueful. Should be very brief since the suffix continues the same sentence.',
    },
  },

  // ── Anchor B, position 1: end of woodworking-software parallels ────
  {
    id: 'prose-full-essay-parallels',
    description: 'Personal essay, cursor at the end of woodworking-software parallels introduction',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'sawdust-and-syntax-errors.md',
    prefix: anchorB_prefix_1,
    suffix: anchorB_suffix_1,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Personal essay about a software engineer learning woodworking. The prefix ends with "some of them have" — the author is about to describe the impact of these parallels. The suffix begins with "genuinely changed how I approach my day job." The completion should bridge these two fragments with a short connecting phrase. Reflective, literary first-person voice. Should be very brief — just the words needed to connect the prefix to the suffix naturally.',
    },
  },

  // ── Anchor B, position 2: mid-sentence about meditative state ──────
  {
    id: 'prose-full-essay-presence',
    description: 'Personal essay, cursor mid-sentence describing meditative quality of attention',
    mode: 'prose' as const,
    languageId: 'markdown',
    fileName: 'sawdust-and-syntax-errors.md',
    prefix: anchorB_prefix_2,
    suffix: anchorB_suffix_2,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['```'],
      quality_notes:
        'Personal essay about woodworking and software. The prefix ends with "my mind enters a state that I can only describe as quietly". The suffix begins with "alert." The completion should bridge these fragments — most likely just the word "alert" or a very short phrase. However, the model does not see the suffix, so it may generate a longer continuation describing this meditative state. Either a brief bridge or a plausible continuation of the thought is acceptable. Reflective, introspective prose voice. Should not introduce headings or structural elements.',
    },
  },
] as const satisfies readonly TestScenario[];
