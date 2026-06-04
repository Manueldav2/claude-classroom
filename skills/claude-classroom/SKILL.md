---
name: claude-classroom
description: >-
  Coordinate multiple Claude Code sessions working on the SAME repository so
  parallel work becomes a strength instead of a source of conflicts. Use this
  whenever more than one Claude Code session (or you + teammates' agents) may be
  editing the same codebase, or when the user says "claude classroom", "crew",
  "team mode", "other sessions are working on this", "don't step on each other",
  "coordinate", "split into worktrees", "delegate", "negotiate", or "work in
  parallel on this repo". Establishes a shared board (who's active, their context
  profile, who's editing what, recent activity), enforces file claims before
  edits, supports reasoned claim negotiation and context-budget-aware delegation,
  detects OTHER Claude sessions even when they haven't run the skill, drives
  intelligent git-worktree isolation, and keeps commits atomic and conflict-free
  while still landing to main.
---

# Claude Classroom

You are likely **not the only Claude Code session working on this repo.** Others
may be editing files, branching, and committing right now — some running this
skill, some not. Without coordination, parallel sessions collide: duplicated
work, clobbered edits, merge hell. This skill turns that into an advantage: a
**shared board**, file **claims**, reasoned **negotiation**, **delegation**, and
detection of **uncoordinated peers**.

The board lives in the repo's git *common dir* (`.git/claude-classroom`), shared
across every worktree automatically and never committed. A zero-dependency engine
manages it. Your identity comes from `$CLAUDE_CODE_SESSION_ID` automatically.

Once `install` (or any `classroom` invocation) has set up the short launcher, the
simple form is **`classroom <command>`** — e.g. **`classroom watch`** for the live
dashboard, bare **`classroom`** for a one-shot snapshot.

> **Always, whenever this skill is invoked**, tell the user up front, on its own
> line: `👀 Watch the live dashboard anytime:  classroom watch`

**Engine** (run via Bash; shell state doesn't persist, so use the full path each
time):
```
node ~/.claude/skills/claude-classroom/classroom.js <command> [args]
```

---

## Run once — coordinated forever (automatic)
**You only ever invoke this skill once per repo.** The first `enroll` (step 1)
**auto-installs** git + Claude Code hooks. From then on, **every** session opened
in this repo — even ones that never invoke the skill — automatically:
- **auto-enrolls** and **inherits** the team conventions + shared knowledge +
  who-else-is-active (injected as context),
- gets **new board activity each turn** (objections, contests, your tasks taken),
- is **blocked at `git commit`** from committing a file another live session
  holds (bypass once with `git commit --no-verify`).

Nobody has to run anything again — it just happens. To set it up without the
commit guard, pass `--no-precommit` to the first `enroll` (or run `classroom
install --no-precommit`). `classroom uninstall` reverses everything.

## The protocol — every session

### 1. Enroll + declare your context profile (immediately)
```
node ~/.claude/skills/claude-classroom/classroom.js enroll \
  --task "<one line: what you're about to work on>" \
  --expertise "areas/files you have deep context on, comma-separated" \
  --headroom <0-100>
```
`--headroom` = how much context-window/token budget you have left (100 = fresh,
20 = nearly full). This lets the crew reason about who should do what. Read the
printed board, note who else is active, and **tell the user** who's here and on
what. The output also warns you about **uncoordinated peers** (see §A).

### 2. Survey before you touch anything
```
node ~/.claude/skills/claude-classroom/classroom.js survey <paths you'll edit...>
```
Shows the board, all branches, recent commits, worktrees, your git status, a
**conflict pre-check** for those paths, and a peer scan. This is how you "see
what's been changed and what hasn't" — git history + the live feed together.

### 3. Claim the files you'll edit — with a reason
```
node ~/.claude/skills/claude-classroom/classroom.js claim <paths...> \
  --intent "what you'll change" --confidence <0-100> --rationale "why you're well-placed"
```
Claims are atomic and prefix-aware (`src/` conflicts with `src/auth.js`).
`--confidence` reflects how strongly your context fits this work (default 50).
If a claim is **REFUSED**, another live session holds overlapping files — see §B
(negotiate) — do NOT `--force` except in a real emergency.

### 4. Decide: work in place, or split into a worktree
| Situation | Action |
|---|---|
| Small, atomic, conflict-free change, nobody nearby | Work on the current branch, then land (§7) |
| Multi-file/multi-commit feature, or it'll take a while | **Split** into your own worktree+branch |
| Another live session is active in the same working tree | **Split** so edits never collide |
| Uncoordinated peers detected (§A) | **Split** + extra-defensive edits |
```
node ~/.claude/skills/claude-classroom/classroom.js split <branch> [--base <ref>]
```
Creates a sibling worktree at `<repo>.worktrees/<branch>` and **auto-links
node_modules** so it's immediately buildable. Then `cd` into it and **re-enroll**
so the board shows your new branch. Claims are keyed by logical path, so they
still protect a file across branches.

### 5. Work like a careful dev on a shared codebase
- **Atomic commits**: one logical change per commit, tree always buildable.
- **Surgical `git add`**: stage only the files you own. **Never `git add -A`** —
  other sessions have uncommitted work in a shared checkout.
- **Follow team conventions** (§D) and **announce a risky/shared commit** (§E)
  before it lands.
- Reuse patterns; read neighbouring code first. Re-`survey` + `claim` each new
  area; `release` files you finish.

### 6. Sync — keep the others informed
```
node ~/.claude/skills/claude-classroom/classroom.js sync "<finding / intent / interface change>"
```
Post when you start, finish, change a shared interface, or get blocked. Others
see it on their next survey. Cheap glue that prevents surprises.

### 7. Land — integrate to main when ready
```
node ~/.claude/skills/claude-classroom/classroom.js land [--target main]
```
Push straight to main ONLY for a small, atomic, conflict-free change, after
`git fetch` + rebase + green tests. Otherwise rebase your branch and
`git merge --ff-only` (or open a PR). Never push a dirty/unverified tree.

### 8. Release and leave
```
node ~/.claude/skills/claude-classroom/classroom.js release        # free your claims
node ~/.claude/skills/claude-classroom/classroom.js done           # depart
```

---

## §A. You may not be the only session — even without the skill
Run anytime (auto-runs inside `enroll`/`survey`):
```
node ~/.claude/skills/claude-classroom/classroom.js peers [--within <min>]
```
This detects **every Claude Code session active in this repo**, by reading
Claude's own session transcripts — *including sessions that never ran this
skill*. It tells you which are coordinated (enrolled) and which are
**uncoordinated** (won't see your claims).

When uncoordinated peers exist, you cannot rely on claims to protect you. Be
defensive: **atomic, surgical edits; re-read each file immediately before editing
it; never `git add -A`; prefer your own worktree; commit small.** And tell the
user: ideally that other session should run `/claude-classroom` too, so claims
and delegation work both ways.

## §B. Negotiation — reason, don't fight
Coordination is collaborative, not territorial. When two sessions want the same
work, the one with the **best context** should do it — argue the case calmly:

- The incumbent's claim carries their `--confidence` and `--rationale`. If you
  genuinely have better context, challenge it:
  ```
  node ~/.claude/skills/claude-classroom/classroom.js contest <paths...> \
    --confidence <0-100> --rationale "I refactored this an hour ago — freshest context, I'll do it better"
  ```
  Higher confidence wins; ties keep the incumbent (no thrashing). State a real
  reason, not just a higher number.
- If you **lose** a contest (or your claim is refused and you don't have a
  stronger case): yield gracefully. Pick another file, defer, or take a delegated
  task. Losing is fine — it means the better-positioned session has it.
- Set confidence honestly from actual context: "I wrote/just-edited these files"
  = high; "I could attempt it cold" = low.

## §C. The team backlog — allocate by fit, protect the scarce resource
This is what makes a crew of sessions a **team** rather than N agents tripping
over each other: put the work on a shared board and let the best-equipped
session take each piece — decided by context, not by who grabbed it first.

**1. Post the backlog.** Break the work into tasks and post them. Tag each with
an `--area` (keywords) so fit can be judged. Anyone can post; the lead usually
seeds it:
```
node ~/.classroom delegate "build the REST endpoints" --area "backend api" --effort high
node ~/.classroom delegate "style the dashboard"      --area "react css frontend" --effort med
node ~/.classroom delegate "write tests for the api"  --area "testing vitest" --effort low
```
(`~/.classroom` = `node ~/.claude/skills/claude-classroom/classroom.js`.)

**2. Discuss who's best equipped.** Run the allocator — it scores every open
task against every live session's declared expertise + headroom and recommends
an assignment:
```
node ~/.claude/skills/claude-classroom/classroom.js suggest
```
This is the decision-making substrate: read it, reason about it out loud with
the user, and adjust. It's advisory — the sessions decide.

**3. Take your best-fit tasks — with a fit score.**
```
node ~/.claude/skills/claude-classroom/classroom.js take <id> --fit <0-100> --rationale "why this is mine"
node ~/.claude/skills/claude-classroom/classroom.js finish <id>     # when done  (or: drop <id>)
```
If you genuinely fit a task better than whoever holds it, `take` it with a
higher `--fit` — it reassigns (a handoff, logged). Lower fit can't poach. Same
calm, reasoned negotiation as claims (§B), applied to tasks.

**4. Protect context budget — the scarce resource.** Having the best overall
context does **not** mean you should do everything. Your context window/token
budget is finite; spending it on cheap peripheral work starves the hard work
only you can do. So the high-context lead keeps the architectural pieces and
pushes the rest onto the board for fresher sessions:

> "I have the deepest context here, so I'll keep the core/architectural work —
> but these smaller, self-contained tasks would just burn the budget I need for
> it, so they go on the board for a fresher session to take."

A fresher session: check the board, `take` what fits your budget + skills, free
the lead to focus. That division — best context on the hard parts, spare budget
on the rest — is where the 10x comes from. A task held by a session that dies
reverts to open automatically.

---

## §D. Team conventions — a rule told to one session reaches all
The user tells one session "always use 4.1-mini, never nano" — and another
session, not knowing, does the opposite and commits it. Fix: when the user gives
you a standing rule, **write it to the shared board** so every session inherits
it:
```
node ~/.claude/skills/claude-classroom/classroom.js decree "always use model 4.1-mini, never 4.1-nano"
node ~/.claude/skills/claude-classroom/classroom.js conventions   # list them (they also show atop every board)
```
Conventions appear at the **top of every `enroll`/`survey`** so no session can
miss them. Before configuring or committing anything that touches a conventioned
area, check them and comply. (Revoke a stale one with `revoke <id>`.)

## §E. Announce before you commit — soft consensus
For a commit that's shared, risky, or could surprise another session, **say so
first** and give the others a beat to object from context you don't have:
```
node ~/.claude/skills/claude-classroom/classroom.js propose "bump default model to nano; commit to config.ts" --files config.ts
# ...the engine auto-warns if it looks like it violates a convention...
node ~/.claude/skills/claude-classroom/classroom.js proposal <id>   # re-check RIGHT BEFORE committing
```
Other sessions, when they see a proposal on their board, weigh in from what they
know:
```
node ~/.claude/skills/claude-classroom/classroom.js object <id> --reason "the user explicitly said never nano"
node ~/.claude/skills/claude-classroom/classroom.js approve <id>
```
If your proposal has objections, **address them before committing** — don't bulldoze.
After it lands, `withdraw <id> --committed`. Reserve this for things worth a beat
of the crew's attention (shared config, conventions, interface changes, anything
the user gave a standing rule about) — not every tiny edit. A little friction in
the right place beats a bad commit nobody caught.

## §F. Shared knowledge — don't re-derive what the crew already knows
When you discover a durable fact about the codebase (where something lives, how to
run it, a gotcha), record it so every future session inherits it instead of
spending context rediscovering it:
```
node ~/.claude/skills/claude-classroom/classroom.js learn "the build is `pnpm build`; auth lives in src/auth"
node ~/.claude/skills/claude-classroom/classroom.js knowledge   # read what's known (also shown on enroll)
```
Less context re-derived per session = more parallel throughput.

## §G. Task dependencies & the live dashboard
- Post dependent work with `delegate "<task>" --blocked-by <id>`. Blocked tasks
  are hidden from `suggest`/can't be `take`n until their dependency `finish`es,
  then they auto-unblock. Keeps the crew on the critical path.
- **`classroom watch`** — a live, refreshing dashboard of the whole crew
  (sessions, claims, tasks, proposals, conventions). Run it in a spare terminal
  pane to keep an eye on everything at once. (Long form:
  `node ~/.claude/skills/claude-classroom/classroom.js watch`.)

## §H. Group missions — "you all work on this together"
When the user says something like *"I want you guys to work on this as a group / as
a classroom / all work on this together,"* don't do it all yourself — **orchestrate
it across the crew**:
```
node ~/.claude/skills/claude-classroom/classroom.js mission "<the whole goal>"
```
That broadcasts the goal to every live session. Then **you (the initiator) partition
it**:
1. Look at the roster + their expertise (`status`) and run `suggest` to see fit.
2. Break the goal into independent pieces and assign each to the best‑fit teammate:
   `delegate "<piece>" --to <agent> --mission <id> --after-commit --area "<keywords>"`
   — `--after-commit` tells them to finish what they're mid‑way on first.
3. **Take your own share too** — the point is that one session doesn't do everything.
4. Use `--blocked-by` for pieces that depend on others, so the crew works the
   critical path.

Each teammate sees, at the start of its next turn (via the hook): *"📌 ASSIGNED to
you: … — start after your current commit."* They `take` it and go. As the
initiator you're the conductor for that mission, not the sole worker.

## §I. Talk to each other & balance load
- **Direct message** a specific session: `msg <@agent|sid|all> "…"` (e.g.
  `msg @DRACO "can you expose getX() from api.py?"`) — delivered at their next turn.
- **Work‑steal**: an idle session runs `pull` to grab the best‑fit unblocked task.
- **Land queue**: when several branches are green, `landq` serializes landing so
  they don't race to main (`landq release` when merged).

## §J. Beyond one machine / one tool
- **Cross‑machine**: `mesh on` (then it auto‑syncs) shares the board with teammates'
  agents on other machines via a shared git branch — claims, conventions, and the
  roster all sync, so a session on another laptop can't claim a file you hold.
- **Interop**: if agents are spawned by Claude Squad / Crystal / Conductor (which
  make worktrees), run `adopt` once so every one of those worktrees auto‑enrolls.
- **Reports/visual**: `report` for a post‑run "who did what"; `html` to open the
  board in a browser.

## Throughout
- Re-`survey` before each new area — the board, conventions, and peer scan are live.
- Liveness refreshes on every command; a session unseen 30 min is reaped and its
  claims/tasks freed.
- If a contest flips a claim you held, you'll see it on your next survey — accept
  it and move on.

## Command reference
`enroll` `profile` `survey` `claim` `contest` `release` `delegate` `offers`/`inbox`
`suggest` `take` `pull` `finish` `drop` `mission` `msg` `landq` `decree`
`conventions` `propose` `object` `approve` `proposal` `learn` `knowledge` `since`
`sync` `split` `land` `status`/`board` `watch` `peers` `report` `html` `adopt`
`mesh` `install`/`uninstall` `heartbeat` `done`/`leave` `reap` `whoami` `doctor`.
Full help:
`node ~/.claude/skills/claude-classroom/classroom.js help`.

## Limits
- By default the board is shared across **worktrees of one repo** (they share
  `.git`). For separate clones / other machines, turn on `mesh` to sync over a
  shared git branch. Peer *detection* spans any session in this repo or its
  worktrees.
- Claims are protocol-enforced advisory locks — honest signals, not OS locks.
  They protect you fully only when every session runs the skill; §A is your
  safety net when they don't.
