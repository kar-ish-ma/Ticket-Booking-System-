---
name: explain
description: Explain a file, function or mechanism in this codebase in plain language, as if teaching it. Use when the user wants to understand code that already exists, or is preparing to defend a design decision in a review or interview.
argument-hint: [file, function or mechanism, e.g. "the atomic acquire"]
---

Explain `$ARGUMENTS` as if teaching it, not documenting it. I need to defend this design out loud without notes.

1. **The problem it solves** — one paragraph, no code. What goes wrong without it? Give the concrete failure: two people, one seat, what each sees.
2. **The shape of the solution** — 3–5 sentences, still no code.
3. **The code, walked through** — paste the actual code and annotate where it matters. Skip boring lines. Dwell on the ones carrying weight.
4. **The non-obvious part** — the single thing a competent developer would get wrong here, and why. Usually the most valuable section; don't rush it.
5. **The naive version and how it fails** — show the tempting wrong version, then the exact interleaving of two requests that breaks it. Be specific about ordering.
6. **Questions I should expect** — 3–4 a reviewer might ask, each with a two-sentence answer. Include at least one hostile or sceptical.

Rules:
- Assume I know JavaScript, React and Express, plus SQL basics, but not distributed-systems vocabulary. Define terms like "row lock", "predicate re-evaluation", "idempotent" briefly, inline, on first use.
- Use a concrete worked example with real names and times — "Priya requests A5 at 10:00:00.000, Rahul at 10:00:00.003" — not "client 1" and "client 2".
- If the current implementation is weaker than what you're describing, say so plainly.

Do not modify any code. This is a reading task.
