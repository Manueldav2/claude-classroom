# claude-classroom — design reference

Turns "multiple Claude Code sessions on one repo" from a hazard into a team.

## The problem
Independent Claude Code sessions on the same codebase clobber each other's
edits, duplicate work, and create merge conflicts. They have no shared memory of
who is doing what.

## The idea
A tiny **shared board** every session reads and writes, plus a protocol
(enroll → survey → claim → isolate → atomic-commit → sync → land → release).
Coordination is honest signalling between cooperating agents, not OS locks.

## Why the storage location is clever
State lives in `<git-common-dir>/claude-classroom` (i.e. `.git/claude-classroom`).
All worktrees of one repo share the same git common dir, so the board is
automatically visible across every worktree + the main checkout, and is **never
committed** (it's inside `.git`). No config, no setup, no pollution.

## Why it's concurrency-safe
Designed so concurrent sessions never corrupt shared state:
- **One file per session** (`members/<sid>.json`) — each session writes only its
  own file, so there is no write contention on membership.
- **Claims are atomic `mkdir` locks** (`claims/<sha1(path)>/`) — `mkdir` is an
  atomic test-and-set on every POSIX filesystem (we don't rely on `flock`, which
  macOS lacks).
- **A global advisory lock** wraps the multi-step claim "scan-then-acquire" so two
  sessions can't both pass a prefix-overlap check and both acquire. Stale locks
  (>10s) are auto-stolen, so a crashed session can't wedge the board.
- **The event feed is append-only JSONL** (`events.log`) using `O_APPEND`, atomic
  for the small writes we make.
- **Liveness is TTL-based** (30 min) + explicit `done`. A session unseen past the
  TTL is reaped and its claims freed, so nothing blocks forever. (PID-based
  liveness is intentionally avoided: the helper is a short-lived subprocess whose
  PID isn't the session's.)

## Identity
Session id comes from `$CLAUDE_CODE_SESSION_ID` (set by Claude Code in every
session, including each `claude -p` headless run). Override with `--sid` for
testing. Never passed by hand in normal use.

## Claim semantics
Claims are **prefix-aware**: claiming `src/` conflicts with `src/auth.js` and vice
versa. Claims are keyed by *logical* repo-relative path, so a claim made from one
worktree/branch conflicts with a claim on the same file from another branch —
which is exactly what prevents two branches from editing one file and colliding
at merge time.

## Worktree strategy
For anything bigger than a tiny atomic fix, or whenever another session is active
nearby, `split` creates `../<repo>.worktrees/<branch>` on a fresh branch. Each
session gets its own working directory and index → no filesystem collisions.
`land` then rebases + ff-merges (or PRs) back to main.

## Commands
`enroll · profile · survey · claim · contest · release · delegate · offers/inbox ·
take · finish · drop · sync · split · land · status/board · peers · heartbeat ·
done/leave · reap · whoami · doctor · help`
Run: `node ~/.claude/skills/claude-classroom/classroom.js <cmd>`

## v1.2 — negotiation, delegation, peer detection
- **Context profiles.** `enroll`/`profile` capture `--expertise` and `--headroom`
  (0-100 context-budget left), shown on the board so the crew can reason about
  who should do what.
- **Reasoned claims + `contest`.** Claims carry `--confidence` (0-100) and a
  `--rationale`. A better-positioned session can `contest`; higher confidence
  wins, ties keep the incumbent (no thrash). The loser is notified via the event
  feed and yields. Collaborative, not territorial.
- **Delegation queue.** `delegate "<task>" --reason --effort` posts work a
  high-context session chooses NOT to do — to preserve its own budget for work
  only it can do well. Others `offers` → `take` → `finish`. Tasks taken by a
  session that dies revert to open (reaper).
- **Peer detection (`peers`).** Reads Claude Code's session transcripts under
  `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` (recently-modified = live) for
  the repo top-level and every worktree, cross-referencing session ids against
  enrolled members. Detects sessions that never ran the skill, so a coordinated
  session stays defensive (atomic surgical edits, no `git add -A`, re-read before
  edit) even when peers don't coordinate. Auto-runs inside `enroll`/`survey`.
- **Worktree node_modules auto-link.** `split` symlinks the source checkout's
  node_modules (root + every workspace package) into the new worktree so it's
  immediately buildable/testable. Opt out with `--no-link`.

## v1.4 — team conventions + announce-before-commit
- **Conventions registry.** `decree "<rule>"` records a standing team norm
  ("always use 4.1-mini, never nano") that shows at the TOP of every
  `enroll`/`survey` board, so a rule the user gives one session reaches them all.
  `conventions` lists them; `revoke <id>` removes. Solves the "I told one session
  X and another did the opposite" problem.
- **Announce-before-commit consensus.** `propose "<intent>" [--files ..]` posts an
  intended commit; `propose` auto-warns if the intent looks like it violates a
  convention (keyword heuristic). Other live sessions `object <id> --reason ..`
  (from context they hold) or `approve <id>`; the proposer runs `proposal <id>`
  before committing and addresses objections. `withdraw <id> --committed` closes
  it. Soft/advisory — for shared config, conventions, interface changes; not
  every edit.

## v1.5 — coordination by default, with teeth
- **`install` / `uninstall`.** Hooks so EVERY session in the repo is coordinated
  without opting in:
  - **SessionStart** → auto-enrolls + injects context (conventions, knowledge,
    who's active). Proven: a real `claude -p` with no classroom mention reported
    its peer + the team convention.
  - **UserPromptSubmit** (`since`) → surfaces new board activity each turn
    (objections on your proposals, contests, your tasks taken, new conventions).
  - **git pre-commit** (`precommit-check`) → BLOCKS committing a file another live
    session holds. Escape: `git commit --no-verify`. Chains any existing hook.
  Hooks live in `<repo>/.claude/settings.local.json` (per-machine) + `.git/hooks`.
- **Shared knowledge base.** `learn` / `knowledge` / `forget` — durable findings
  every new session inherits.
- **Task dependencies.** `delegate --blocked-by <id>`; blocked tasks hidden from
  `suggest`, un-takeable until the dep `finish`es, then auto-unblock.
- **`watch`** — live refreshing board dashboard.

## v2.3 — long-running completion, self-compaction, overseer model
- **Projects.** `project "<goal>" --done "<criteria>"` sets a persistent goal;
  `goal` shows backlog progress (open/doing/done); `project done` completes (guards
  on remaining tasks). SKILL §M: build → verify (tests/evals/e2e + review) → repeat
  until empty + green; idle = pull the next task, don't stop.
- **Self-compaction.** `checkpoint "<where I am>" --next --files [--handoff]` saves
  task + claims + next-steps to the board (claims survive compaction); `/compact`;
  then `resume` reloads everything (+ active project + new activity). `--handoff`
  also posts the work as an open task so a teammate can continue. The per-turn
  UserPromptSubmit hook reads **real context usage** from the transcript (latest
  turn's input+cache tokens ≈ live prompt size; infers a 200k vs 1M limit from the
  model, `CLASSROOM_CONTEXT_LIMIT` overrides), auto-sets the agent's headroom from
  it, and at ≥~88% full fires a 🔴 "compact yourself NOW" directive (checkpoint →
  /compact → resume) so the session self-compacts before degrading — no asking, no
  Stop hook. Gentler reminder under 25%. The dashboard headroom now reflects reality.
- **Overseer model.** `escalate "<q>"` to the human — engine enforces **one open
  escalation at a time** (others must resolve among themselves / wait); `escalations`
  lists open ones; `answer <id> "<direction>"` closes + notifies. SKILL §O: decide
  small stuff, get empirical evidence (run/eval/e2e), escalate only big direction.
- **Holistic watch + legend.** Dashboard now shows a 🚨 NEEDS-YOU banner (open
  escalation), a 🎯 project line with backlog counts, a BOARD strip
  (claims/tasks/reviews/rules/operators/messages), and a permanent KEY explaining
  every glyph. checkpoints/escalations are mesh-synced.

## v2.2 — peer review + a wildly-better watch
- **Peer review.** `review "<what>" [--to a] [--branch b]` requests a review,
  auto-routed to the area's operator (ownerMatch) or a fresh session; `reviews`
  lists what's waiting on you; `verdict <id> approve|changes|reject --ran "vitest
  108✓, e2e green" --notes "…"` records the verdict (and **what tests/evals/e2e were
  run**) and notifies the author. `land` now tells you to run tests/evals/e2e + get
  an approving verdict before merging. Requests/verdicts ride the message channel,
  so they show up in `since` and the chatter feed.
- **Upgraded `watch`.** Animated (braille spinner + pulsing dots + per-agent color
  dots in the header), `💬` badge on agents pinged in the last 5 min, and a live
  **CHATTER feed** merging messages + notes — `FROM ─▶ TO  text` for DMs, `FROM 📝
  text` for notes — persona-colored with timestamps. `renderDashboard(meSid, tick)`;
  watch passes an incrementing tick.

## v2.1 — codebase ownership / domain operators
- A session declares the areas it operates: `own "backend/auth, payments, src/api/**"`
  (or `--owns` on enroll/profile). `owners` lists who runs what; shown on the
  dashboard (`⬡ operates: …`).
- `ownerMatch()` scores a member against a path/area (exact / path-prefix / topic).
  `fitScore` and therefore `suggest`, `pull`, and mission partitioning now rank
  **ownership above generic expertise** — a `payments` task routes to the payments
  operator even if someone else has more headroom. Verified.
- `whoknows <area>` finds the operator; `ask "<area>" "<question>"` routes a
  question to that operator (delivered next turn via the message hook; they reply
  with `msg`). No clear owner → broadcast to all.

## v2.0 — missions, messaging, distribution, interop
- **Group missions.** `mission "<goal>"` broadcasts a goal; the initiator partitions
  it and `delegate --to <agent> --after-commit` assigns pieces by fit, taking one
  share itself. Assignees see `📌 ASSIGNED to you … start after your current commit`
  via the turn hook. Dogfooded: a real lead session split a Settings feature into
  UI→nova, DB→sage, API→itself, by expertise.
- **Direct messaging.** `msg <@agent|sid|all> "…"` → delivered to the recipient at
  their next turn (via `since`). `resolveSid` matches persona name / short id / sid.
- **Work-stealing.** `pull` takes the best-fit unblocked task for the caller.
- **Land queue.** `landq` serializes landing to main (one session at a time, stale
  lock auto-stolen after 10m); `landq release`/`status`.
- **Cross-machine `mesh`.** Syncs the file-per-record board over a shared git branch
  (`claude-classroom-board`) using an isolated `.mesh-repo` helper clone; two-way
  newer-wins union; `mesh on` auto-syncs on enroll/heartbeat. Dogfooded across two
  clones + a bare remote: a session on machine B was REFUSED a claim held on
  machine A. (Claims are nested `claims/<hash>/meta.json` — the sync walks subdirs.)
- **Interop `adopt`.** Installs auto-enroll hooks into every git worktree, so agents
  spawned by Claude Squad / Crystal / Conductor auto-join.
- **`report`** (who-did-what timeline, markdown) and **`html`** (browser dashboard
  export via ANSI→HTML).

## Verified behaviour (dogfooded with real `claude -p` sessions)
- 3 concurrent sessions on one shared working dir each enrolled, saw the others,
  split into worktrees, claimed distinct files, made atomic commits, synced, and
  departed — then all three branches merged to main with **zero conflicts** and
  the merged code passed all runtime assertions.
- 2 sessions racing for the **same file**: one won the claim, the other detected
  the refusal, did not force, and **rerouted** its work to a different file — so
  only one branch ever modified the contended file.

## Limits
- Shared only across **worktrees of one repo** (they share `.git`). Separate
  clones don't see each other.
- Claims are protocol-enforced advisory locks; they work because every session
  runs this skill.

## Extending
The engine is one dependency-free Node file (`classroom.js`). Add a subcommand by
adding a `COMMANDS.<name>` function. Data model is plain files under the coord
dir — inspectable with `status --json`.
