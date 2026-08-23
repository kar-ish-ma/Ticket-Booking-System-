---
name: explain
description: Explain a file, function or mechanism in this codebase in plain language, as if teaching it. Use when the user wants to understand code that already exists, or is preparing to defend a design decision in a review or interview.
argument-hint: [file, function or mechanism, e.g. "the atomic acquire" or "holds.service.ts"]
---

Explain `$ARGUMENTS` to me as if you were teaching it, not documenting it. I need to be able to
defend this design out loud without notes.

Structure your answer exactly like this:

1. **The problem it solves** — one paragraph, no code. What goes wrong in a system that doesn't
   have this? Give me the concrete failure: two people, one seat, what each of them sees.
2. **The shape of the solution** — the approach in 3–5 sentences, still no code.
3. **The code, walked through** — paste the actual code and annotate it line by line where it
   matters. Skip the boring lines. Dwell on the ones that carry the weight.
4. **The non-obvious part** — the single thing a competent developer would get wrong here, and
   why. This is usually the most valuable section; don't rush it.
5. **What the naive version looks like and how it fails** — show the tempting wrong version, then
   describe the exact interleaving of two requests that breaks it. Be specific about ordering.
6. **Questions I should expect** — 3–4 questions a reviewer might ask about this, each with a
   two-sentence answer. Include at least one you'd consider hostile or sceptical.

Rules:
- Assume I know JavaScript, React and Express, plus SQL basics, but not distributed systems vocabulary. Define terms like
  "row lock", "predicate re-evaluation", "idempotent" the first time you use them, briefly, inline.
- Use a concrete worked example with real names and times — "Priya requests A5 at 10:00:00.000,
  Rahul requests A5 at 10:00:00.003" — not "client 1" and "client 2".
- If any part of the current implementation is weaker than what you're describing, say so plainly
  rather than explaining the idealised version.

Do not modify any code. This is a reading task.
