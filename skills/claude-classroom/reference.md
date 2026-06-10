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

## v2.7.4 — long jobs aren't an excuse to stop ("the eval will ping me")
v2.7.3's NO FAKE MONITORING didn't name the most common trigger: a session kicks off a
42-min background eval/A-B/test and stops with "the eval will ping me when both arms
finish; I'll analyze, land, deploy then" — idle for 42 min, "2 shells still running."
Added a "LONG JOBS" brief line + SKILL clause: kick the job off in the background, then
IMMEDIATELY do other INDEPENDENT work this turn (next experiment, prep the landing diff,
another lever, write the verification); actively re-CHECK the job's output file each cycle
(read/tail the log). "It'll notify me when done" = dead-wait; "when X finishes I'll
analyze/land/deploy" = narration. Only the final gate (the number you don't have yet)
waits — everything around it you build NOW. Dogfooded.

## v2.7.3 — no fake monitoring: execute on the board, don't narrate or sleep-wait
User: sessions say "I'll answer the question / I'll send a message / I'll periodically check
the classroom," then `sleep` or just stop — believing they're still monitoring when they're
idle and dead. Root misconception: a session thinks it has a background loop. It doesn't.
Added a "NO FAKE MONITORING" directive to the brief + a top SKILL callout:
- You have NO background loop — when your turn ends you're IDLE until re-triggered, so
  `sleep`-waiting / "I'll keep watching / circle back" is a hallucination.
- EXECUTE, don't narrate: never say "I'll message X / I'll check the board" — run the actual
  `msg`/`ask`/`survey`/`status`/`finish` command THIS turn and verify on the board. Checking
  the classroom = running the command, not promising to.
- The only real "keep going" is the Stop-hook loop (active project): act → end turn → hook
  re-engages → re-run `survey`/`since` to actually check → act again. Blocked on a teammate →
  do other work + re-check next cycle, never sleep. Nothing left → `classroom done`, don't fake-monitor.
- Stop hook message now explicitly forbids `sleep`/"monitor" and says "RUN the commands now and
  re-check the board with survey/since." Dogfooded.

## v2.7.2 — fix the edit-guard false "operation stopped by hook" (solo sessions)
User: "Operation stopped by hook when it shouldn't be." Root cause: when
CLAUDE_CODE_SESSION_ID isn't exported, Bash `claim`/`enroll` resolve identity via the
grandparent-pid fallback (`local-<hash>`) while the PreToolUse edit-guard used the real
`session_id` from stdin — so the guard saw the session's OWN claim as "another live
session" and DENIED its own edit. Fixes:
- The guard now resolves ownership via `sessionId(args)` (same as Bash) and treats both
  that id AND the stdin real id as "me" — own claims are never a conflict.
- A deny now requires a GENUINELY DISTINCT concurrent session, verified via
  `detectPeers` (keys off real transcript files, immune to id drift). A SOLO session has
  no peer → can NEVER be blocked by its own or a stale claim. Default stays `deny` but it
  only fires with a real peer; `warn`/`off` still available.
Verified: solo+drifted-id → ALLOWED; genuine 2-transcript conflict → DENY; own file → ALLOWED.

## v2.7.1 — build-don't-narrate: kill research/planning theater + "self-running loop" stops
v2.7.0 wasn't enough: on a big task, sessions did elaborate research/repo-mining/scorecards/
knowledge-recording/coordination, declared "the loop is live, I'll come back with numbers,"
and STOPPED before building/testing anything — and still asked the founder to "label turns"
and "send the repo." Two hard rules added to the brief (lines 2-3, after PRIME DIRECTIVE) +
SKILL top callout:
- **PROGRESS = a shipped, TESTED change.** Research/plans/scorecards/knowledge/decrees/board
  coordination/spawning helpers are SETUP, not progress; stopping after them is failure. The
  moment you have a candidate change, build+test it against the baseline THIS turn, keep it
  only if it measurably wins, do the next. "There is no self-running loop — YOU are the loop";
  never say "it's self-sustaining / I'll come back with numbers" and stop; don't "wait for
  background agents" — build alongside them.
- **Make EVERYTHING objective, then test.** Any which-is-better/what-scope/does-this-match-your-
  taste → define a proxy metric (prod outputs / rubric as ground truth), measure, keep the
  winner. Don't ask the founder to label/rank/choose/send what you can derive/scrape/proxy.
  Only real stops: genuinely irreversible actions + an unobtainable credential.
- Stop hook now appends "NOTHING has shipped yet — research/plans aren't progress" when zero
  tasks are done, and pushes "build it and TEST it against the baseline this turn, then run the
  NEXT iteration yourself." Dogfooded: brief + Stop message verified.

## v2.7.0 — maximal agency: stop the passing-back-and-forth / laziness regression
User: the accumulated guardrails (stand-down, back-off, hand-off, escalate-gating) had
tilted sessions toward passivity — passing work around, recruiting instead of doing,
asking instead of deciding. Re-tilted the whole system to action-by-default, with every
stop/handoff mechanism reframed as a NARROW exception:
- **PRIME DIRECTIVE** injected as the FIRST line of every SessionStart brief + a top
  callout in SKILL.md: "You are a BUILDER, not a coordinator. Default to DOING the work
  yourself end-to-end (research → build → test → iterate → ship). Don't pass work around,
  recruit/hand off to dodge effort, stop early, or ask what you can decide/test/look up."
- **Objectify, don't ask** (also from this session's prior ask): turn "which approach /
  should I include X / what scope" into an experiment. New `baseline "<what>" --value
  --how` records the original result on the board (survives compaction, refuses silent
  overwrite); ship a change only if it BEATS the baseline. Brief + §O updated.
- **Delegate/recruit reframed**: §C + §P + the recruit guidance now say delegation is for
  PARALLELISM across already-live hands when you're saturated — NEVER to offload work you
  could do; "a crew of one means you build the whole thing." Active-project brief says
  "DO it yourself; don't delegate/recruit/ask to avoid it."
Dogfooded on the claude-classroom repo: brief renders PRIME DIRECTIVE + OBJECTIFY + do-it-
yourself first; Stop hook on a zero-task project drives "decompose + build", not stand-down.

## v2.6.4 — stop "just stopping": no compaction babysitting + stalled-handoff recovery
Two user reports: (1) sessions stop working to PREP for compaction (checkpoint/nag) instead
of just working until auto-compact — "make it not worry about compaction"; (2) a session at
its context limit `recruit`ed a worker that enrolled, said "claiming files now," then stalled
and produced nothing — and nobody caught it (the project had a goal but NO task, so the board
thought there was no work).
- **Compaction is now fully silent.** `hook-user-prompt` no longer prints "🔴 CONTEXT FULL —
  checkpoint now" / "⚠ headroom low" nags. It tracks real usage only to draw the dashboard ctx
  gauge. PreCompact auto-checkpoints + SessionStart re-injects, so sessions have ZERO compaction
  chores — they just keep working. (Re-enable a gentle one-liner with CLASSROOM_COMPACT_WARN=1.)
  `checkpoint` output no longer says "now you can /compact"; SKILL §N rewritten to "don't think
  about compaction at all."
- **recruit seeds a tracked task** from the project goal when the backlog is empty, so a worker
  takes concrete work; if it stalls (enrolls→claims→goes quiet) reap reopens it as abandoned →
  visible (`🧵 to finish`) + reclaimable, instead of dying silently.
- **Stop hook demands decomposition, never falsely stands down on an undecomposed goal.** Active
  project + zero tasks → "break the goal into tasks and BUILD it" (sig 'decompose'), not the
  v2.6.3 clean stand-down. Verified: zero-task project → decompose nudge; task exists → pull nudge.

## v2.6.3 — founder-gated stand-down (stop nagging when only the founder can unblock)
User report: a session finished everything it could autonomously (the rest needed LLM
keys + one irreversible-publish confirmation) but the Stop hook kept nagging it through
idle rounds because the project was still `active`. Now the loop distinguishes
autonomous work from founder-gated work and stands down cleanly:
- **`needs <id> [reason]` / `delegate --needs-founder`** mark a task as founder-gated
  (needs keys / a confirmation / a decision). Such tasks are EXCLUDED from `ready`/
  `abandoned`/`assigned` and from "is there crew work left?" — they never keep a
  session churning. Surfaced under `⏳ N for founder` (BOARD strip) + in `goal`.
- **Stop hook clean stand-down**: when no autonomous crew work remains (all open tasks
  are founder-gated or done, no pending reviews), the session wraps up in ONE step
  (release claims → `done`) and is told which items await the founder — instead of
  3 idle "be useful" rounds. Verified: 1 nudge then ALLOW STOP.
- **`project await "<what you need>"` / `project resume`**: stands the WHOLE crew down
  (status `awaiting` → Stop hook silent, since it only runs while status==='active');
  dashboard shows `⏸ AWAITING FOUNDER · needs: …`. The explicit "we've taken it as far
  as we can without you" signal.

## v2.6.2 — height-fit TUI + delivery guarantee (work/messages can't vanish)
Two user reports: (1) the `watch` TUI overflowed the terminal so the top (header +
agent names) scrolled off; (2) sessions don't actually work — they hand off to a
session that isn't running, or post-and-vanish ("low on context, I'll post it") and
nobody ever picks it up.
- **Height-fit dashboard**: renderDashboard now builds prioritized SECTIONS and fits
  them to terminal rows (`process.stdout.rows`, env LINES/COLUMNS fallback). Header +
  agent names ALWAYS render; agent cards collapse across 4 detail tiers (full→one-line)
  as the crew grows; lower sections (chatter, claims, ghosts, …) trim to "+N more" or
  drop, with counts preserved in the BOARD strip. `fitSection` guarantees each section
  never exceeds its budget (fixed an off-by-one). Verified fits at rows 20–60, no overflow.
- **Delivery guarantee** (work never aimed at a non-running session):
  - `msg`/`ask` to a non-live target → refused with who-IS-live + recruit hint
    (`offlineTargetHelp`, `resolveSidAny` distinguishes "no such session" vs "offline").
  - `delegate --to <non-live>` → falls back to OPEN-to-anyone (was a black hole: a task
    routed to a dead sid could never be pulled).
  - `pull` + Stop hook treat tasks routed to a non-live session as reclaimable.
  - Stop hook: clears the back-off on every fresh (non-`stop_hook_active`) stop so a
    session with real work is re-nudged each turn (can't drift off); catches
    post-and-vanish ("you posted X, nobody live is on it — take it back"); reclaims
    handoffs to offline sessions. Within-sequence anti-loop (v2.6.1) still prevents runaway.

## v2.6.1 — Stop-hook anti-loop + park (fixes a v2.6.0 regression)
A real user incident: the v2.6.0 Stop hook hard-blocked on an un-landed orphan branch
and fired 9× identically (it ignored `stop_hook_active`), demanding a merge the session
had correctly refused as destructive (would revert prod). Fixes:
- **Anti-loop**: hook-stop now reads `stop_hook_active` and tracks a per-session
  `stopRepeat`/`lastStopSig`/`releasedSig`. It blocks on the SAME demand at most
  `CLASSROOM_MAX_STOP_BLOCKS` (default 2) times, then RELEASES and stays quiet for
  that demand until the situation changes (a different action or it gets done).
  Progress (a new demand each turn) resets the counter — real work is never cut off.
- **Orphan branches are advisory, not a Stop-block**: landing someone else's branch
  can be destructive, so the Stop loop no longer forces it. Un-landed branches stay
  surfaced in loose-ends / dashboard / the `project done` gate (where a human decides).
- **`park <branch> [--reason]` / `unpark`**: mark a branch as intentionally-not-landing
  (parked.json on the board). Parked branches are excluded from loose-ends,
  `project done`, and the loop — the escape valve for "this work mustn't merge."

## v2.6.0 — edit-guard, finish-the-job, TUI upgrade (dogfooded on IDEX)
Built while dogfooding the skill to fix a real IDEX bug (the tab-restore feed bug:
SessionView.commitSubmission bailed on an empty line buffer, so arrow-key menu
answers never re-expanded the feed — fixed with a pure, unit-tested
`decideFeedOnSubmission` policy). The dogfooding surfaced + drove these tool changes:

- **PreToolUse edit-guard (`hook-pre-edit`)** — makes a clobber IMPOSSIBLE, not just
  discouraged. Before any Edit/Write/MultiEdit/NotebookEdit: another LIVE session
  holds the file (prefix-aware) → **deny** with an actionable reason; unclaimed →
  **auto-claim** for this session so the crew is protected even if it never ran
  `claim`; mine/no-board → allow. Modes via `CLASSROOM_EDIT_GUARD`: deny (default) ·
  warn · off. Registered in install + adopt, matcher `Edit|Write|MultiEdit|NotebookEdit`.
- **Symlink-robust paths** — `realpathSafe()` resolves symlinked repo roots (macOS
  /var→/private/var, symlinked checkouts) on the longest existing prefix so one
  logical file can't map to two claim keys (had silently let the guard skip a
  clobber). `normPath` uses it.
- **Finish-the-job / loose ends** — started work no longer rots when priorities
  shift. `reap()` flags dead-owner tasks `abandoned` (reopened, not lost);
  `loose-ends`/`unfinished` lists abandoned tasks + stalled taken tasks + **un-landed
  branches** (committed but never deployed); `pull` resumes abandoned work FIRST
  (+1000 fit); the Stop-loop routes idle sessions to finish abandoned tasks + land
  orphaned branches before going home; `project done` REFUSES while un-landed
  branches exist ("not done until deployed").
- **`take` no longer hard-locks on `--to`** — routed-to-a-departed-session task is
  adopted; routed-to-a-live-peer needs a fit-based takeover (mirrors `taken`).
- **TUI upgrade** — per-agent ctx **gauges** (color by headroom), 🔒 **CLAIMS
  collision map**, 📋 **BACKLOG** (effort chips + assignees + ↻ resume), 🔎 **REVIEW
  QUEUE**, project **progress bar**, 🧵 to-finish count, height-aware density,
  expanded KEY legend.

## v2.5.2 — stop asking the founder coordination/ratification questions
- Behavioral fix: sessions were asking the human to ratify a division of labor they'd
  already coordinated, or to pick between approaches they could test. SKILL.md now has
  a top "Golden rule" callout + a rewritten §O with a pre-ask checklist (can the crew
  decide? can evidence decide? did I already coordinate it?) and an explicit NOT-an-
  escalation list (division of labor / who-drives-what / "work together or split" /
  ratifying coordination / testable "which approach"). §P reinforces. The SessionStart
  brief now injects "DECIDE, don't defer" into every session (verified). Escalate is
  reserved for what the founder uniquely owns.

## v2.5.1 — identity robustness ("not enrolled" fix)
- Some Claude Code setups don't export `CLAUDE_CODE_SESSION_ID` to Bash, so the old
  random fallback gave a different id per call → enroll and later commands disagreed
  ("✗ not enrolled"). Fix: the fallback now seeds a **stable** id off node's
  *grandparent* pid (the long-lived Claude Code process — stable across tool calls;
  node's direct parent is the ephemeral per-call `bash -c`). Verified stable across
  separate calls.
- Plus **auto-enroll**: every command that needs membership now calls `autoEnroll(sid)`
  and joins on the spot instead of hard-failing — so `mission`/`claim`/etc. work even
  if you never ran `enroll`. (Identity precedence: `--sid` > `$CLAUDE_CODE_SESSION_ID`
  > `$CLASSROOM_SID` > stable grandparent-pid fallback.)

## v2.5 — autonomous work loop + recruiting
- **Stop hook** (`hook-stop`): while a project is active, blocks a session from
  stopping if there's work — directs it to finish/take/pull/review, pulls taskless
  sessions into the backlog, nudges idle ones to help (review/offer), and after a few
  idle checks (`CLASSROOM_IDLE_EXITS`, default 3) sends it home (`done`). Silent when
  no active project or already departed → normal stop. install/adopt register it.
  This is the "don't sit around; the human just gives the task" loop.
- **`recruit [n] [--model] [--safe]`**: spawns n detached `claude -p` worker sessions
  that enroll + grind the active project autonomously (bypassPermissions by default,
  acceptEdits with --safe; max-turns 300), then exit when done. "Summon more hands."
- SessionStart brief announces an active project and tells taskless sessions to work
  autonomously. (Tested: stop-hook blocks/idle-exits correctly; recruit spawns N.)

## v2.4 — fully automatic compaction (no /compact)
- A **PreCompact hook** (`hook-precompact`) auto-checkpoints task + claims + branch +
  uncommitted state to the board right before ANY compaction (manual or native
  auto-compact); preserves a recent manual checkpoint instead of clobbering it.
- The **SessionStart hook fires after a compaction** (source "compact") and
  re-injects the checkpoint (⏪ RESUMING…), so the session continues exactly where it
  was — no `/compact`, no manual checkpoint, no lost claims. install/adopt register
  PreCompact alongside SessionStart + UserPromptSubmit. The near-full nudge no longer
  says "run /compact" — it just says commit your current step; auto-compaction +
  auto-checkpoint + auto-resume handle the rest. Relies on Claude Code's native
  auto-compact (~95%; `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
  tune it for 1M models).

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
