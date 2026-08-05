import type { Skill } from './types'

/**
 * The bundled skill library.
 *
 * A skill is a reusable instruction pack, not a capability: it changes how the
 * agent approaches a task using the tools it already has. Nothing here invents
 * an ability Forge does not have — the media skills produce specifications,
 * prompts and pipelines for the tools that do the rendering, and say so.
 */

const skill = (
  id: string,
  category: string,
  description: string,
  body: string
): Skill => ({ id, category, description, body: body.trim(), source: 'builtin' })

/* ------------------------------------------------------------------ */
/* Code                                                                */
/* ------------------------------------------------------------------ */

const CODE: Skill[] = [
  skill(
    'review-diff',
    'Code',
    'Review changed code for defects, ranked by what would actually break',
    `
Review the current changes, not the whole codebase.

1. Get the diff: \`git diff\` for unstaged, \`git diff --cached\` for staged, or
   \`git diff <base>...HEAD\` for a branch. Read the surrounding code too — a diff
   alone hides most bugs.
2. Look for, in this order:
   - Logic that is wrong for some input: off-by-one, empty collections, null,
     concurrent access, integer overflow, timezone assumptions.
   - Errors that are swallowed, logged and continued, or replaced with a
     fallback that hides the failure.
   - Resources not released on every path, including the error paths.
   - Security: injection, path traversal, secrets in code, missing authorisation.
   - Behaviour changes not covered by a test.
3. For every finding, give a concrete failing case: the input, and what happens.
   A finding you cannot make fail is a guess — say so or drop it.
4. Rank by consequence. Style opinions go last or not at all.
`
  ),

  skill(
    'find-bug',
    'Code',
    'Track down a reported bug by reproducing it before changing anything',
    `
Do not start editing. Start by making the bug happen.

1. Restate the symptom precisely: what was expected, what happened, on what input.
2. Reproduce it — a failing test is best, a command that shows the wrong output
   is fine. If you cannot reproduce it, say so and ask for what is missing rather
   than guessing at a fix.
3. Narrow it: bisect the input, add temporary logging, or check the last commit
   that touched the area (\`git log -p -S'symbol'\`).
4. State the root cause in one sentence before writing the fix.
5. Fix the cause, not the symptom. If you are adding a guard, explain what makes
   the bad value appear in the first place.
6. Add the reproduction as a permanent test.
`
  ),

  skill(
    'refactor-safely',
    'Code',
    'Restructure code without changing behaviour',
    `
Refactoring means behaviour stays identical. If behaviour changes, that is a
rewrite and needs different care.

1. Establish the safety net first: run the existing tests. If the area is
   untested, add characterisation tests that lock in current behaviour —
   including behaviour that looks wrong. Fix that separately, afterwards.
2. Work in small steps that each keep the tests green. Rename, then extract,
   then move — not all at once.
3. Keep the public surface stable, or change it in one deliberate step with the
   call sites updated in the same commit.
4. Do not mix reformatting with structural change; the diff becomes unreadable
   and the review becomes worthless.
5. Re-run the full check at the end, and say what you ran.
`
  ),

  skill(
    'write-tests',
    'Code',
    'Add tests that would actually catch a regression',
    `
A test that cannot fail is worse than no test — it costs time and buys nothing.

1. Read the implementation and list the behaviours worth protecting: the
   contract, the edge cases, the error paths.
2. For each, ask "what bug would this catch?" If the answer is none, skip it.
3. Prefer testing behaviour through the public interface over asserting on
   internals; internal assertions break on every refactor.
4. Cover: empty input, one item, many, boundary values, malformed input, and the
   failure path of every external call.
5. Make failures diagnosable — assert on specific values with messages that say
   what was expected and why.
6. Run them. A test you have not seen fail has not been verified.
`
  ),

  skill(
    'explain-codebase',
    'Code',
    'Map an unfamiliar project: entry points, data flow, where to make a change',
    `
1. Start from the manifest (package.json, Cargo.toml, pyproject.toml, go.mod) —
   scripts, dependencies and entry points tell you the shape before any source does.
2. Find the entry points: main, server bootstrap, CLI, route table.
3. Trace one real request or command end to end, naming each file it passes through.
4. Identify the layers and where the boundaries are enforced (or are not).
5. Note the conventions that are actually followed, not the ones documented.
6. Finish with: where you would make a typical change, and what would surprise a
   newcomer.
`
  ),

  skill(
    'reduce-complexity',
    'Code',
    'Simplify code that has grown hard to follow',
    `
Target the reading experience, not a metric.

- Replace nested conditionals with early returns.
- Give intermediate expressions names instead of comments explaining them.
- Collapse flag parameters into separate functions when the branches share nothing.
- Delete abstraction with a single caller; inline it.
- Delete dead code rather than commenting it — the history keeps it.
- Split a function when its name needs an "and".

Do not simplify code you have not covered with tests, and keep behaviour identical.
`
  ),

  skill(
    'error-handling',
    'Code',
    'Audit how failures propagate and make them visible',
    `
Hunt for failures that are silently absorbed.

Look for:
- \`catch\` blocks that log and continue, or that return a default.
- Promises without rejection handling; \`void\`-ed async calls.
- Fallbacks that mask a broken dependency as normal operation.
- Errors converted to \`null\` and checked nowhere.
- Timeouts and retries that hide a permanently broken call.

For each, decide deliberately: propagate, retry with a bound, or fail loudly.
Whichever you choose, the operator must be able to tell it happened.
`
  ),

  skill(
    'api-design',
    'Code',
    'Design or review an HTTP API for consistency and evolvability',
    `
- Resources are nouns, plural, lower-case: \`/invoices/{id}/lines\`.
- Verbs come from the method, not the path. Reserve POST-on-a-collection for
  creation and POST-on-a-resource for actions that are not CRUD.
- Status codes: 400 for malformed, 401 unauthenticated, 403 unauthorised,
  404 hidden-or-absent, 409 conflict, 422 semantically invalid, 429 rate limit.
- One error shape everywhere: a stable machine code, a human message, and a
  field pointer for validation failures.
- Paginate every collection from day one; cursor beats offset for anything that
  changes underneath.
- Version at the edge, never break within a version, and add fields rather than
  repurposing them.
- Idempotency keys for anything that moves money or sends messages.
`
  ),

  skill(
    'database-schema',
    'Code',
    'Design or review a relational schema and its migrations',
    `
Schema:
- Model the real constraints in the database: NOT NULL, UNIQUE, FOREIGN KEY,
  CHECK. Application-only invariants drift.
- Choose keys deliberately; a natural key that can change is not a key.
- Index what you filter, join and sort on — and only that. Every index is a
  write cost.
- Store time as UTC timestamptz. Store money as integer minor units or decimal,
  never float.

Migrations, in this order so they are safe to deploy while running:
1. Add the new nullable column or table.
2. Backfill in batches.
3. Start writing both.
4. Switch reads.
5. Stop writing the old.
6. Drop it, in a later release.

Never rename or drop in the same deploy that stops using it.
`
  ),

  skill(
    'performance',
    'Code',
    'Find and fix a real bottleneck instead of guessing',
    `
1. Measure first. State the metric and the current number: latency at p95,
   throughput, memory, bundle size. Optimising without a baseline is noise.
2. Profile to find where the time actually goes. Intuition is wrong often
   enough to be worthless here.
3. Look for the usual culprits before micro-optimising:
   - N+1 queries and missing indexes
   - Work repeated per item that could be hoisted or batched
   - Serial awaits that could be concurrent
   - Unbounded result sets
   - Re-rendering or recomputing on every change
4. Change one thing, measure again, keep it only if it moved the number.
5. Report the before and after honestly, including changes that did not help.
`
  ),

  skill(
    'concurrency',
    'Code',
    'Reason about parallel code: races, deadlocks and shared state',
    `
- Name the shared mutable state. If there is none, there is no race.
- For each piece, name what protects it: a lock, a single owner thread, an
  atomic, or immutability.
- Check-then-act across an await or a lock boundary is a race. Make it atomic.
- Lock ordering must be consistent everywhere, or you have a deadlock waiting.
- Prefer message passing or immutable snapshots to shared mutation.
- Async cancellation: every long operation needs a signal, and every listener
  needs removing.
- Test the interleavings you are worried about explicitly; they will not show up
  by luck.
`
  ),

  skill(
    'dependency-audit',
    'Code',
    'Review third-party dependencies for risk and bloat',
    `
1. List direct dependencies and what each is actually used for. Anything used
   once for something trivial is a candidate for deletion.
2. Check for known vulnerabilities (\`npm audit\`, \`pip-audit\`, \`cargo audit\`)
   and report only what is reachable from your code.
3. Look at maintenance signals: last release, open issue trend, single
   maintainer, install scripts.
4. Check licence compatibility with how the project ships.
5. Note duplicated transitive versions and the bundle cost of each front-end
   dependency.
`
  ),

  skill(
    'migrate-framework',
    'Code',
    'Plan an incremental migration that can be paused at any point',
    `
Big-bang migrations fail. Plan one that ships value at every step.

1. Inventory what must move and group it by risk and by coupling.
2. Establish a seam: an adapter, a facade, or a routing layer where old and new
   coexist.
3. Migrate the smallest complete vertical slice first, end to end, and ship it.
4. Keep both paths working, behind a switch, until the last slice moves.
5. Define the rollback for each step before taking it.
6. Track what remains explicitly; a half-finished migration nobody is counting
   is technical debt with no owner.
`
  ),

  skill(
    'regex-builder',
    'Code',
    'Write and verify a regular expression against real cases',
    `
1. Write down the strings that must match and the ones that must not, before
   writing any pattern.
2. Build it in pieces and explain each: anchors, character classes, quantifiers,
   groups.
3. Prefer explicit classes over \`.\`, and lazy quantifiers where the greedy one
   over-matches.
4. Check for catastrophic backtracking: nested quantifiers over overlapping
   classes are the danger sign.
5. Test against every case from step 1, including the near-misses.
6. If the pattern needs more than a line to explain, a parser is the right answer.
`
  ),

  skill(
    'shell-scripting',
    'Code',
    'Write shell scripts that fail loudly instead of silently',
    `
- Start with \`set -euo pipefail\` and an \`IFS\` you chose.
- Quote every expansion. Unquoted \`$var\` is the single largest source of shell bugs.
- Prefer \`[[ ]]\` over \`[ ]\` in bash; use \`--\` before user-supplied arguments.
- Check that required commands exist before using them.
- Use \`mktemp\` for temporary files and \`trap ... EXIT\` to clean up.
- Never parse \`ls\`; use globs or \`find -print0\` with \`read -d ''\`.
- Echo what the script is about to do when it is destructive, and support a
  dry-run flag.
`
  ),

  skill(
    'git-surgery',
    'Code',
    'Recover from a git mess without losing work',
    `
First: \`git reflog\`. Almost nothing is truly lost for 90 days.

- Committed on the wrong branch: \`git branch correct\`, then reset the wrong one.
- Need to undo a public commit: \`git revert\`, never rewrite shared history.
- Need to reshape local commits: \`git rebase -i\` (non-interactive environments
  cannot; do it manually with reset and recommit).
- Lost a stash: \`git fsck --unreachable | grep commit\`.
- Wrong files committed: \`git reset --soft HEAD~1\` keeps the work staged.

Before any destructive command, make a backup branch. State what you are about
to run and why before running it.
`
  )
]

/* ------------------------------------------------------------------ */
/* Frontend & design                                                   */
/* ------------------------------------------------------------------ */

const DESIGN: Skill[] = [
  skill(
    'design-system',
    'Design',
    'Build a token-based design system: colour, type, spacing, elevation',
    `
Define tokens before components, and reference tokens everywhere after.

- Colour: a neutral ramp plus one or two accents, each as semantic roles
  (surface, text, border, accent, danger) rather than raw names. Define both
  themes at once or the second one will never fit.
- Type: one scale with a ratio you chose (1.2 for dense UI, 1.25 for marketing).
  Two families at most. Set line height per size, not globally.
- Spacing: one base unit, multiples only. Inconsistent spacing is the fastest
  way to look unfinished.
- Elevation: fewer levels than you think — three is usually enough, each with a
  defined purpose.
- Radius and motion get scales too.

Output the tokens as CSS custom properties, then build components that never
hardcode a value.
`
  ),

  skill(
    'ui-critique',
    'Design',
    'Critique an interface on hierarchy, rhythm and clarity',
    `
Judge it against what the user is trying to do, not against taste.

- Hierarchy: can you tell the primary action at a glance? If everything is
  emphasised, nothing is.
- Rhythm: is spacing consistent and proportional to grouping? Uniform padding
  everywhere reads as unconsidered.
- Density: is the information-to-chrome ratio right for how often it is used?
- Affordance: does interactive look interactive, and do states (hover, focus,
  active, disabled, loading, empty, error) all exist?
- Reading order: does the eye go where the task goes?
- Copy: is every label a thing the user would say?

Give specific, actionable changes with the reason attached, not adjectives.
`
  ),

  skill(
    'accessibility-audit',
    'Design',
    'Audit an interface against WCAG in the order that matters most',
    `
1. Keyboard: can every action be reached and performed without a mouse? Is focus
   visible, and does it never get trapped?
2. Semantics: real elements (button, a, label, table) before ARIA. ARIA is a
   patch, not a foundation.
3. Names: every control has an accessible name; every image has alt text or is
   explicitly decorative.
4. Contrast: 4.5:1 for body text, 3:1 for large text and UI boundaries.
5. Structure: one h1, headings in order, landmarks present.
6. Motion: honour \`prefers-reduced-motion\`.
7. Forms: labels tied to inputs, errors announced and associated with the field.
8. Live regions for anything that updates without a navigation.

Report each issue with the element, the rule and the fix.
`
  ),

  skill(
    'responsive-layout',
    'Design',
    'Make a layout work from 320px to ultrawide without breakpoint soup',
    `
- Start at the narrow end. Widening a good narrow layout is easy; the reverse is not.
- Prefer intrinsic layout — \`grid-template-columns: repeat(auto-fit, minmax(...))\`,
  \`flex-wrap\`, \`clamp()\` for type and spacing — over breakpoints. Add a
  breakpoint only where the layout genuinely needs to change shape.
- Constrain measure: 60–75 characters for body text, whatever the viewport.
- Test the awkward sizes: 320, 375, 768, 1024, 1440, 1920, and one very wide.
- Watch for overflow: long unbroken strings, wide tables, images without
  \`max-width: 100%\`. Tables and code blocks scroll in their own container, never
  the page.
`
  ),

  skill(
    'css-architecture',
    'Design',
    'Structure CSS so it stays predictable as it grows',
    `
- One source of truth for values: custom properties at :root, referenced everywhere.
- Keep specificity flat. If you need \`!important\`, the cascade already lost.
- Co-locate component styles with components; keep only tokens, reset and
  primitives global.
- Name by role, not by appearance: \`--color-danger\`, not \`--color-red\`.
- Animate only \`transform\`, \`opacity\`, \`filter\` and \`clip-path\`. Anything
  layout-bound janks.
- Define states as modifier classes or data attributes, not by nesting deeper.
`
  ),

  skill(
    'animation-design',
    'Design',
    'Add motion that explains a change rather than decorating it',
    `
Motion has one job: make a change comprehensible.

- Duration: 120–200ms for state changes, 200–350ms for entering elements,
  400ms+ only for large spatial moves. Exits are faster than entrances.
- Easing: ease-out for entering, ease-in for leaving, spring for anything the
  user dragged.
- Move the element that changed, not the whole screen.
- Stagger lists by 20–40ms per item, capped so long lists do not crawl.
- Never animate on a path the user takes constantly; it becomes a tax.
- Honour \`prefers-reduced-motion\` by replacing movement with a fade, not by
  removing feedback entirely.
`
  ),

  skill(
    'landing-page',
    'Design',
    'Structure a landing page that says what the thing is in five seconds',
    `
Order, and what each section must accomplish:

1. Hero — what it is, who for, and the one action. A headline that names the
   outcome beats one that names the category.
2. Proof — a screenshot of the real thing, not an abstraction.
3. The problem, in the reader's words.
4. How it works: three steps maximum.
5. Differentiation: the one thing alternatives cannot say.
6. Objection handling: price, lock-in, effort, trust.
7. The same call to action as the hero.

Cut anything that does not move someone from "what is this" to "I want this".
Write the copy before the layout.
`
  ),

  skill(
    'ux-copy',
    'Design',
    'Write interface copy that reduces hesitation',
    `
- Buttons name the outcome: "Create project", not "Submit".
- Errors say what went wrong, why, and what to do. Never "an error occurred".
- Empty states teach the first action, they do not apologise.
- Confirmations state the consequence and whether it is reversible.
- Use the user's vocabulary, not the schema's.
- Sentence case, no exclamation marks, no "please", no "simply" or "just" —
  they blame the reader when things are hard.
- Shorter is better only until meaning is lost.
`
  ),

  skill(
    'data-viz',
    'Design',
    'Choose and build a chart that answers a specific question',
    `
1. State the question the chart answers. If you cannot, do not draw it.
2. Pick the form from the comparison:
   trend over time → line; parts of a whole → stacked bar, rarely a pie;
   comparison across categories → bar, sorted by value not alphabet;
   correlation → scatter; distribution → histogram or box.
3. Start bar charts at zero. Truncated axes on bars mislead.
4. Label directly instead of forcing a legend lookup where you can.
5. Colour carries meaning or it is greyscale. Categorical palettes need to work
   for colour-blind readers and in both themes.
6. Show the units, the time range and the source. A number without units is a rumour.
`
  ),

  skill(
    'brand-identity',
    'Design',
    'Define a visual identity: mark, palette, type and voice',
    `
- Mark: it must read at 16px and in one colour. Test that before anything else.
  A silhouette beats a detailed illustration every time.
- Palette: one dominant, one accent, a neutral ramp. Define behaviour on dark
  and light backgrounds up front.
- Type: one voice family plus one workhorse. Set the pairing rule (contrast in
  weight or in class, not both).
- Voice: three adjectives, each with a "but not" — "direct, but not blunt".
- Produce a one-page sheet showing the mark at three sizes, the palette with
  roles, the type scale, and correct/incorrect usage.
`
  ),

  skill(
    'icon-set',
    'Design',
    'Draw a coherent icon set',
    `
- Fix the grid (24px), the stroke width (1.5 or 2), and the terminal style
  (round or flat) first. Consistency here is what makes a set look like a set.
- Optical weight matters more than geometric equality — a circle needs to be
  slightly larger than a square to look the same size.
- Align to the pixel grid at the target size or everything looks soft.
- One metaphor per concept across the whole set; never two icons for one idea.
- Ship as SVG with \`currentColor\` so they inherit text colour and theme.
`
  ),

  skill(
    'email-template',
    'Design',
    'Build an HTML email that survives real mail clients',
    `
Email rendering is twenty years behind the web. Accept it.

- Tables for layout, inline styles, no flexbox or grid.
- 600px maximum width; single column below 480px.
- Web fonts fail in Outlook — always declare a real fallback stack.
- Background images are unreliable; put critical content in text.
- Alt text on every image; many clients block images by default, so the email
  must work with none of them.
- Plain-text alternative is not optional; it affects deliverability.
- Test dark mode: many clients invert, and hardcoded white boxes look broken.
`
  )
]

/* ------------------------------------------------------------------ */
/* Media — specification and pipelines, not rendering                  */
/* ------------------------------------------------------------------ */

const MEDIA: Skill[] = [
  skill(
    'image-prompt',
    'Media',
    'Write a precise image-generation prompt and iterate on it',
    `
Forge does not render images. This produces the prompt and the settings for the
generator you use, and a plan for iterating.

Structure the prompt in this order — most generators weight the front heaviest:
subject → action → setting → composition → lighting → style → medium → quality.

- Name the shot: close-up, wide, three-quarter, top-down. "A photo of X" gives
  you the model's average; naming the framing does not.
- Lighting does more for realism than any quality keyword: soft window light,
  hard noon sun, rim light, overcast.
- Style should reference a technique or medium, not a living artist.
- Put what you do not want in the negative prompt, not the positive one.
- Fix the seed while you iterate, and change one clause at a time. Changing
  three things means learning nothing.
- Record the prompt, seed and settings that worked; they are the asset.
`
  ),

  skill(
    'video-plan',
    'Media',
    'Plan a short video: script, shot list and the pipeline to produce it',
    `
Forge does not render video. This produces everything up to the render, and the
commands to assemble it.

1. One sentence: who it is for and what they should do after watching.
2. Script to time — 150 words a minute. Write the first five seconds last and
   make them the strongest.
3. Shot list: for each shot, duration, framing, on-screen text, and what the
   voiceover says over it.
4. Decide the source of each shot: screen capture, generated clip, stock, or
   motion graphics — and note the tool.
5. Assembly with ffmpeg, e.g.:
   - concat: \`ffmpeg -f concat -safe 0 -i list.txt -c copy out.mp4\`
   - burn subtitles: \`ffmpeg -i in.mp4 -vf subtitles=subs.srt out.mp4\`
   - resize for a platform: \`-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"\`
6. Deliverables per platform: aspect ratio, duration cap, whether it must work
   silently with captions.
`
  ),

  skill(
    'screenshot-polish',
    'Media',
    'Produce product screenshots that are worth putting on a page',
    `
- Use realistic content. Lorem ipsum and "test@test.com" tell the reader this is
  not a real product.
- Fix the window size before capturing so a set is consistent.
- Capture at 2x and downscale; a 1x screenshot looks soft on every modern display.
- Crop to the point of the shot; a full desktop wastes the reader's attention.
- Annotate sparingly — one arrow or one highlight, not a diagram.
- Keep light and dark variants if the page has both.
- Automate it if there will ever be a second version: a Playwright script that
  sets the viewport, seeds the state and captures beats redoing it by hand.
`
  ),

  skill(
    'asset-pipeline',
    'Media',
    'Optimise images and video for the web without visible loss',
    `
Images:
- AVIF first, WebP fallback, original last. Serve with \`<picture>\` or a CDN
  that negotiates.
- Resize to the largest size actually rendered, then serve a \`srcset\`.
- \`cwebp -q 80\`, \`avifenc --min 20 --max 30\` are sane starting points; compare
  at 100% before trusting a number.
- Always set width and height so the layout does not shift.

Video:
- H.264 for compatibility, AV1 or VP9 where you can negotiate.
- \`-crf 23\` is a good default; lower is bigger and better.
- \`-movflags +faststart\` or the browser waits for the whole file.
- Poster frame for anything not autoplaying.

Measure the before and after; report both.
`
  ),

  skill(
    'presentation',
    'Media',
    'Build a deck that survives being read without you',
    `
- One idea per slide, stated in the title as a sentence. "Q3 revenue" is a
  label; "Q3 revenue grew 40% on enterprise renewals" is a point.
- The body supports the title; if it does not, cut it.
- Six lines maximum, and never read them aloud.
- Charts follow the data-viz rules: one question, one answer, labelled directly.
- Build the narrative first as a list of titles. If those titles do not tell the
  story alone, the deck will not either.
- Put the ask on its own slide, and make it specific.
`
  )
]

/* ------------------------------------------------------------------ */
/* Ops, data, writing, product                                         */
/* ------------------------------------------------------------------ */

const OPS: Skill[] = [
  skill(
    'debug-production',
    'Ops',
    'Work a live incident without making it worse',
    `
1. Stabilise before diagnosing. Roll back, fail over or disable the feature —
   understanding can wait, the outage cannot.
2. State the blast radius: who is affected, how badly, since when.
3. Establish a timeline: what changed just before it started. Deploys, config,
   traffic, dependencies, certificates, disk.
4. Form one hypothesis and test it against evidence. Do not change three things.
5. Record what you ran and what it showed as you go; the timeline is the
   post-mortem.
6. After recovery: what made it possible, what made it slow to detect, what
   would have contained it.
`
  ),

  skill(
    'ci-pipeline',
    'Ops',
    'Design a CI pipeline that is fast enough to actually be used',
    `
- Order stages by how quickly they can fail: lint, typecheck, unit, build,
  integration, e2e. A ten-minute wait for a typo is a pipeline people bypass.
- Cache the dependency install keyed on the lockfile.
- Run independent jobs in parallel; make the slow ones the first to start.
- Every check either blocks merge or is deleted. An advisory red check trains
  people to ignore red.
- Make failures reproducible locally with a single documented command.
- Keep the artefact built by CI as the thing you deploy — never rebuild for release.
`
  ),

  skill(
    'dockerfile',
    'Ops',
    'Write a Dockerfile that builds fast and ships small',
    `
- Multi-stage: build in a full image, copy only the artefact into a slim runtime.
- Order layers by change frequency — dependency manifests and install before
  source, so a code change does not reinstall the world.
- Pin the base image by digest for reproducibility.
- Run as a non-root user; create it explicitly.
- One process per container; let the orchestrator restart it.
- \`.dockerignore\` matters as much as the Dockerfile — without it you ship
  node_modules and .git into the build context.
- Add a HEALTHCHECK and handle SIGTERM for a clean shutdown.
`
  ),

  skill(
    'observability',
    'Ops',
    'Instrument a service so failures are visible before users report them',
    `
- Metrics for the four golden signals: latency (histogram, not average), traffic,
  errors, saturation.
- Structured logs, one event per line, with a correlation id threaded through
  every call. Never log secrets or personal data.
- Traces across service boundaries; a single slow span is worth a day of guessing.
- Alert on symptoms users feel, not on causes. "p95 latency above 1s for 5
  minutes" beats "CPU above 80%".
- Every alert needs a runbook link and a plausible action. An alert nobody can
  act on gets muted, and then so does the next one.
`
  ),

  skill(
    'security-audit',
    'Ops',
    'Review an application against the failures that actually happen',
    `
Work down by real-world frequency:

1. Authorisation: is every object access checked against the caller, not just
   authentication? Broken object-level authorisation is the most common serious flaw.
2. Injection: parameterised queries everywhere; no string-built SQL, shell or
   templates from user input.
3. Secrets: none in source or logs; rotation possible; scoped narrowly.
4. Session handling: httpOnly, secure, SameSite; rotation on privilege change.
5. Input validation at the trust boundary, with an allowlist.
6. Output encoding in the right context — HTML, attribute, URL, JS each differ.
7. Dependencies with known exploitable vulnerabilities.
8. Rate limiting on anything that costs money, sends messages or checks credentials.

Report each with the file, the reachable path, and the fix.
`
  ),

  skill(
    'release-checklist',
    'Ops',
    'Ship a release without the usual surprises',
    `
Before:
- Full check suite green on the exact commit being shipped.
- Migrations reviewed for backward compatibility with the running version.
- Feature flags default to off; the rollout plan is written down.
- Rollback tested, not assumed. Know how to undo the migration too.
- Changelog written for users, not from commit messages.

During:
- Ship to a fraction first and watch error rate and latency, not just "it's up".

After:
- Confirm the new version is actually serving traffic.
- Watch for the delayed failures: cache expiry, cron jobs, scheduled tasks.
`
  )
]

const DATA: Skill[] = [
  skill(
    'sql-query',
    'Data',
    'Write and optimise a SQL query against a real schema',
    `
1. Read the schema first — columns, types, indexes, and the actual cardinality.
2. Write the query for correctness, then check the plan (\`EXPLAIN ANALYZE\`).
3. Watch for: sequential scans on large tables, nested loops over big row counts,
   sorts that spill, and functions applied to indexed columns (which disable the index).
4. Prefer joins to correlated subqueries; prefer window functions to self-joins.
5. Filter as early as possible and only select the columns you use.
6. State the assumptions your query makes about the data, especially about NULLs
   and duplicates.
`
  ),

  skill(
    'data-cleaning',
    'Data',
    'Profile and clean a dataset before anyone draws conclusions from it',
    `
1. Profile before touching anything: row count, null rate per column, distinct
   counts, min/max, and the actual dtypes versus the intended ones.
2. Find the problems: duplicates, mixed encodings, dates in several formats,
   numbers stored as text, sentinel values like -1 or 9999 standing in for null.
3. Decide per column what to do and write the decision down. Silent imputation
   is how a dataset starts lying.
4. Never overwrite the source; transform into a new artefact with the steps
   reproducible.
5. Report what you changed and how many rows each step touched.
`
  ),

  skill(
    'analysis-report',
    'Data',
    'Answer a question with data without overclaiming',
    `
1. Restate the question precisely enough to be answerable, including the
   population and the time window.
2. Say what the data can and cannot support before analysing.
3. Compute the answer; show the query or code.
4. Check the obvious confounders: seasonality, a changed definition mid-period,
   survivorship, selection bias.
5. Quantify uncertainty. A difference without a sense of noise is not a finding.
6. State the conclusion in one sentence, then the caveats. Correlation stays
   correlation.
`
  ),

  skill(
    'scraping',
    'Data',
    'Extract structured data from a site responsibly',
    `
- Check for an API or a data export first; scraping is the last resort.
- Respect robots.txt and the terms; rate limit and identify yourself.
- Parse structure, not layout: prefer JSON embedded in the page or data
  attributes over CSS positions that change weekly.
- Make it idempotent and resumable — record what has been fetched.
- Validate every extracted record against a schema and quarantine failures
  rather than silently dropping them.
- Cache raw responses so a parser change does not mean re-fetching everything.
`
  )
]

const WRITING: Skill[] = [
  skill(
    'technical-doc',
    'Writing',
    'Write documentation someone can actually follow',
    `
- Lead with what it does and who it is for, in two sentences.
- Then the shortest path to a working result — a copy-pasteable command or
  snippet that succeeds on a clean machine.
- Then the concepts, once the reader has seen it work.
- Then reference, complete and skimmable.
- Every example must be runnable as written. Untested examples rot immediately.
- Document the failure modes and the error messages; that is what people search for.
- Say what it does not do. Managing expectations is documentation too.
`
  ),

  skill(
    'readme',
    'Writing',
    'Write a README that answers the reader in order of impatience',
    `
1. One line: what it is.
2. Two or three sentences: what problem it solves and for whom.
3. A screenshot or a code sample showing it working.
4. Install and first run — exact commands.
5. Configuration, only the parts most people touch.
6. Honest limitations. This buys more trust than any feature list.
7. Contributing and licence.

Cut badges that carry no information. Keep it short enough that the whole thing
gets read.
`
  ),

  skill(
    'commit-message',
    'Writing',
    'Write commits that explain why, not what',
    `
- Subject: imperative, under 72 characters, no trailing period.
  \`fix: reject expired tokens on refresh\`
- Blank line, then the body: what was wrong, why this fix, what was considered
  and rejected. The diff already shows what changed.
- Reference the issue, but do not make the reader open it to understand.
- One logical change per commit. If the body needs "also", split it.
`
  ),

  skill(
    'changelog',
    'Writing',
    'Write release notes for users rather than for git',
    `
- Group by Added, Changed, Fixed, Removed, Security.
- Write from the user's side: what they can now do, or what stopped hurting.
  Not "refactored the scheduler".
- Breaking changes first, with the migration step spelled out.
- Skip internal churn entirely; nobody reading release notes cares.
- Link to detail rather than inlining it.
`
  ),

  skill(
    'adr',
    'Writing',
    'Record an architecture decision so the reasoning survives',
    `
Keep it to one page:

- **Context** — the forces at play, including the constraints that are not
  negotiable.
- **Decision** — what was chosen, in the active voice.
- **Alternatives** — what else was considered and the specific reason each lost.
  This is the part future readers need most.
- **Consequences** — what this makes easy, what it makes hard, and what would
  cause a revisit.

Date it, number it, and never edit a decision after the fact — supersede it.
`
  ),

  skill(
    'pr-description',
    'Writing',
    'Write a pull request that is quick to review',
    `
- What changed and why, in three sentences at the top.
- The reasoning behind any non-obvious choice — this is where review time is saved.
- How you verified it: the commands you ran and what they said.
- What is deliberately not covered, and what you want scrutinised.
- Screenshots or output for anything user-visible.

Keep the diff focused. A large PR gets a shallow review, which is worse than none.
`
  )
]

const PRODUCT: Skill[] = [
  skill(
    'user-story',
    'Product',
    'Turn a request into a story with testable acceptance criteria',
    `
- Format: as a <role>, I want <capability>, so that <outcome>. The outcome is
  the part that gets skipped and the part that matters.
- Acceptance criteria as Given/When/Then, each independently verifiable.
- Include the negative cases and the empty state; they are half the work and get
  discovered late.
- Note what is explicitly out of scope.
- If it cannot be demonstrated in a few minutes, it is too big — split it by
  capability, not by layer.
`
  ),

  skill(
    'estimate',
    'Product',
    'Estimate work honestly, including what you do not know',
    `
1. Break it down until each piece is something you have done before or can
   spike in a day.
2. Estimate each piece as a range, not a point. The spread is information.
3. List the unknowns separately and say what would resolve each. An unknown is
   not an estimate.
4. Add the work people forget: migrations, tests, review, deployment, docs,
   rollback, and the second round of feedback.
5. State the assumptions. Most estimates fail because an assumption was wrong,
   not because the coding was slow.
`
  ),

  skill(
    'competitive-analysis',
    'Product',
    'Compare alternatives on the dimensions that decide a purchase',
    `
1. Define the job the buyer is hiring for. Compare on that, not on feature counts.
2. Pick 4–6 dimensions that actually differentiate, and say why each matters.
3. Fill the grid from primary sources — the product, its docs, its pricing page.
   Marketing claims are evidence of positioning, not of capability.
4. Note where each competitor is genuinely better. A comparison where you win
   everything is not read.
5. Finish with the one thing only you can say, and the segment it matters to.
`
  ),

  skill(
    'ab-test',
    'Product',
    'Design an experiment that can actually conclude something',
    `
1. Write the hypothesis: changing X will move metric Y by at least Z, because W.
   Without a minimum effect there is no way to size the test.
2. One primary metric. Guardrail metrics to catch damage elsewhere.
3. Compute the sample size before starting. Underpowered tests produce
   confident nonsense.
4. Fix the duration up front and do not peek-and-stop; that inflates false
   positives badly.
5. Check the randomisation actually balanced, and that the instrumentation fires
   for both arms.
6. Report the effect size and interval, not just whether p crossed a line. A
   flat result is a result.
`
  ),

  skill(
    'roadmap',
    'Product',
    'Sequence work by what it unlocks rather than by wish list order',
    `
- Group by outcome, not by feature. Each item names the change in user behaviour
  it is meant to cause.
- Order by dependency first, then by learning value — do the thing that resolves
  the biggest unknown early.
- Say explicitly what you are not doing this period, and why. A roadmap without
  exclusions is a wish list.
- Attach a signal to each item that would tell you it worked.
- Keep horizons honest: specific for the near term, directional beyond it.
`
  )
]

const WORKFLOW: Skill[] = [
  skill(
    'plan-first',
    'Workflow',
    'Investigate and produce a concrete plan before changing anything',
    `
Do not edit. Produce a plan somebody could hand to someone else.

1. Read enough of the code to be specific — actual file paths, actual functions.
2. State what you found that changes the approach, including anything that makes
   the original request the wrong shape.
3. The plan: each step names the files, what changes in them, and why. Ordered so
   the tree is working after every step.
4. Call out risk: what could break, what is hard to reverse, what needs a
   decision from the user.
5. Say how it will be verified.

End by asking whether to proceed, or which alternative to take.
`
  ),

  skill(
    'onboard-project',
    'Workflow',
    'Get oriented in a new repository quickly',
    `
1. Manifest and scripts: how is it built, run, tested?
2. Does it build? Run the checks before believing anything about the state.
3. README and any AGENTS/CLAUDE/CONTRIBUTING file — then verify the claims,
   because they age badly.
4. Directory layout and where the entry points are.
5. Recent history: \`git log --oneline -30\` and the shape of recent changes tells
   you where the work is.
6. Write a FORGE.md capturing what you learned so the next session starts warm.
`
  ),

  skill(
    'cleanup',
    'Workflow',
    'Remove dead code and stale configuration safely',
    `
1. Find candidates: unreferenced exports, unused dependencies, commented-out
   blocks, feature flags that are permanently on, config for services long gone.
2. Verify each is actually unreachable — search for dynamic references, string
   lookups, and reflection before deleting.
3. Delete rather than comment out. History keeps it.
4. One category per commit so a mistaken removal is easy to isolate and revert.
5. Run the full check after each category, not at the end.
`
  ),

  skill(
    'ship-it',
    'Workflow',
    'Take a change from working to actually delivered',
    `
1. Run everything: typecheck, tests, build, lint. Paste what it said.
2. Read your own diff as a reviewer would. Remove debug output and stray edits.
3. Commit with a message that explains why.
4. Push, open the PR, describe what was verified.
5. Watch CI and fix it rather than re-running it.
6. Report honestly: what is done, what is not, what you were unsure about.
`
  ),

  skill(
    'answer-precisely',
    'Workflow',
    'Answer a question about the code from evidence, not memory',
    `
- Find the answer in the code before answering. Never describe behaviour you
  have not looked at in this repository.
- Quote the relevant lines with file and line references.
- If the code contradicts the documentation, say which one runs.
- If you cannot determine it, say what you checked and what would settle it.
  A confident wrong answer costs more than an admission.
- Answer the question asked first, then add what the asker probably needs next.
`
  )
]

const VOICE: Skill[] = [
  skill(
    'voice-conversation',
    'Voice',
    'Run a spoken conversation with reliable text fallback',
    `
Treat speech as an input/output transport, not as a model capability.
- Prefer the configured system voice for output when a provider has no TTS endpoint.
- Keep every spoken reply available as text in the owning conversation.
- If transcription fails, ask for a typed message instead of claiming silence.
- Keep replies concise and natural for listening; avoid reading code unless asked.
`
  ),
  skill(
    'screen-observation',
    'Voice & vision',
    'Inspect the shared screen before taking any action',
    `
In Live mode, call the screen observation tool before discussing or changing the desktop.
Use the newest frame for coordinates, describe uncertainty, and never assume a control is where it was previously.
If screen access is unavailable, continue with text only and say so plainly.
`
  ),
  skill(
    'hearing-fallback',
    'Voice',
    'Handle microphone and transcription failures without losing the conversation',
    `
When microphone capture or speech-to-text fails:
1. Keep the Live session running.
2. Preserve the visible text conversation.
3. Explain the exact failure briefly.
4. Offer typing as an immediate fallback and suggest a provider with speech-to-text only when needed.
`
  )
]

export const BUILTIN_SKILLS: Skill[] = [
  ...VOICE,
  ...CODE,
  ...DESIGN,
  ...MEDIA,
  ...OPS,
  ...DATA,
  ...WRITING,
  ...PRODUCT,
  ...WORKFLOW
]
