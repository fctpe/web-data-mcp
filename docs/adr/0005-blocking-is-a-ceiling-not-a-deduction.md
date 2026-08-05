# ADR 0005: Blocking caps the quality score; it is not one weighted term among four

**Status:** accepted · 2026-08-04

## Context

The composite quality score started as a weighted sum of four signals — schema
pass rate (0.4 when a schema is present), field completeness, duplicate rate and
bot-wall rate — with blocking carrying 0.15.

That weighting made the headline feature unreachable. A page of pure Cloudflare
interstitial is not empty: it carries a `url` and several hundred characters of
prose, so it passes a permissive JSON Schema, reads as complete, is not a
duplicate of anything, and lands at **0.85** against the default 0.70 threshold.
A fully blocked batch therefore scored well above the retry threshold, and the
escalation ladder — residential proxies, then a browser crawler — never ran for
the exact page it was built for. At 0.15, blocking could not move the score past
the threshold no matter how much of the batch was walls.

The fixture that should have caught this was the 13-character string
`Access Denied`. It failed the schema's `minLength: 50`, so the test observed a
low score for an unrelated reason and passed. A green test proved nothing about
block detection, which had never been exercised.

## Decision

1. **Blocking is a ceiling, not a deduction.** The final score is
   `min(weighted, 1 - bot_wall_rate)`. A batch cannot score higher than the
   fraction of it that is actually content.
2. **Blocking gets its own retry trigger**, `suspected_block_rate > 0.2`,
   independent of the score — because a partly blocked batch still caps above the
   threshold (25 % walls caps at 0.75) and a quarter of pages being walls is
   exactly what a residential proxy is for.
3. **Exhausted retries name a bot wall as a bot wall** in the `isError` result,
   not as "low quality". A model told the content is thin will summarise the wall
   as if it were the page.
4. **The fixture must be long enough to reach the scorer.**
   `test/blocked-content.test.ts` attacks the scorer with a full-length block
   page *and asserts the fixture's own length*, so the test cannot silently go
   back to passing for the wrong reason.

## Consequences

- The score is no longer a pure weighted sum, and the ceiling is the term most
  likely to decide it. That is intended: the other three signals answer "is this
  data any good", and blocking answers "is this data".
- A dataset with a strict schema and a moderate wall rate can now fail on the
  ceiling while every other signal is healthy. The structured result reports
  `suspected_block_rate` alongside `score`, so a caller can tell which bound
  bit.
- Rule 4 generalises past this bug: any fixture that is supposed to trip a
  detector has to survive every earlier check in the pipeline, or it tests the
  earlier check.
