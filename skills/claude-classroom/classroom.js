#!/usr/bin/env node
'use strict';

/*
 * claude-classroom — coordination engine for multiple Claude Code sessions
 * working on the same repository.
 *
 * Zero dependencies (Node built-ins only). Concurrency-safe by construction:
 *   - every session owns exactly one members/<sid>.json (no write contention)
 *   - path claims are atomic mkdir locks (claims/<hash>/)
 *   - the event feed is an append-only JSONL log (O_APPEND atomic small writes)
 *
 * Shared state lives in the git *common dir* (`.git/claude-classroom`), which
 * is automatically shared across every worktree of the same repo and is never
 * committed. Sessions in separate clones do not share state (documented limit).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TTL_MS = 30 * 60 * 1000; // a member is "live" if seen within 30 minutes
const VERSION = '2.1.0';

// ---------------------------------------------------------------------------
// tiny arg parser:  node classroom.js <cmd> [positionals...] [--flag val] [--bool]
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [], cmd: argv[0] || 'help' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------
function git(args, opts = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      ...opts,
    }).trim();
  } catch {
    return null;
  }
}

let _repo = null;
function repo() {
  if (_repo) return _repo;
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const isGit = !!commonDir;
  const topLevel = isGit ? git(['rev-parse', '--show-toplevel']) : null;
  const branch = isGit ? git(['rev-parse', '--abbrev-ref', 'HEAD']) : null;
  _repo = { isGit, commonDir, topLevel, branch };
  return _repo;
}

function coordDir() {
  const r = repo();
  if (r.isGit) return path.join(r.commonDir, 'claude-classroom');
  // fallback for non-git dirs: temp area keyed by a hash of cwd
  const h = crypto.createHash('sha1').update(process.cwd()).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), 'claude-classroom', h);
}

const DIRS = () => {
  const root = coordDir();
  return {
    root,
    members: path.join(root, 'members'),
    claims: path.join(root, 'claims'),
    tasks: path.join(root, 'tasks'),
    proposals: path.join(root, 'proposals'),
    decisions: path.join(root, 'decisions'),
    knowledge: path.join(root, 'knowledge'),
    messages: path.join(root, 'messages'),
    missions: path.join(root, 'missions'),
    events: path.join(root, 'events.log'),
  };
};

function ensureDirs() {
  const d = DIRS();
  for (const k of ['members', 'claims', 'tasks', 'proposals', 'decisions', 'knowledge', 'messages', 'missions']) {
    fs.mkdirSync(d[k], { recursive: true });
  }
  if (!fs.existsSync(d.events)) fs.writeFileSync(d.events, '');
  return d;
}

// ---------------------------------------------------------------------------
// identity / time
// ---------------------------------------------------------------------------
function sessionId(args) {
  const raw =
    args.sid || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLASSROOM_SID;
  if (raw) return String(raw);
  // last resort: a stable-ish id derived from tty+ppid, else random
  return 'anon-' + crypto.randomBytes(4).toString('hex');
}
const shortId = (sid) => String(sid).replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
const safeName = (sid) => String(sid).replace(/[^A-Za-z0-9_.-]/g, '_');
const now = () => Date.now();
const parseList = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);
const clampPct = (v) => Math.max(0, Math.min(100, Math.round(Number(v)) || 0));

// the simplest command to watch the dashboard — short wrapper if it's on PATH.
function watchCmd() {
  for (const c of ['/opt/homebrew/bin/classroom', '/usr/local/bin/classroom', path.join(os.homedir(), '.local/bin/classroom')]) {
    try { if (fs.existsSync(c)) return 'classroom watch'; } catch {}
  }
  return 'node ~/.claude/skills/claude-classroom/classroom.js watch';
}

function rel(ts) {
  const s = Math.max(0, Math.round((now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 48) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// global advisory lock for multi-step critical sections (e.g. claim scan+acquire).
// mkdir is atomic; a lock older than staleMs is assumed orphaned and stolen.
function withLock(fn, { timeoutMs = 4000, staleMs = 10000 } = {}) {
  const d = ensureDirs();
  const lock = path.join(d.root, '.lock');
  const start = Date.now();
  let held = false;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      held = true;
      break;
    } catch {
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() - start > timeoutMs) break; // proceed best-effort rather than deadlock
      sleep(20);
    }
  }
  try {
    return fn();
  } finally {
    if (held) try { fs.rmSync(lock, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// path normalization (repo-relative, posix, no trailing slash)
// ---------------------------------------------------------------------------
function normPath(p) {
  const r = repo();
  let abs = path.resolve(process.cwd(), p);
  let relPath = r.topLevel ? path.relative(r.topLevel, abs) : abs;
  if (relPath === '') relPath = '.';
  relPath = relPath.split(path.sep).join('/');
  relPath = relPath.replace(/\/+$/, '');
  return relPath || '.';
}

function pathsOverlap(a, b) {
  if (a === b) return true;
  return a.startsWith(b + '/') || b.startsWith(a + '/');
}

function claimKey(normalized) {
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// members
// ---------------------------------------------------------------------------
function readMembers() {
  const d = DIRS();
  let files = [];
  try {
    files = fs.readdirSync(d.members).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => readJSON(path.join(d.members, f)))
    .filter(Boolean);
}

// liveness reflects REAL session activity, not just "ran a classroom command".
// A session heads-down coding still touches its Claude transcript, so we treat
// the more recent of (lastSeen, transcript mtime) as the heartbeat. Cached ~1.5s
// so `watch` stays cheap but fresh.
let _peerMap = null, _peerMapAt = 0;
function peerMtimes() {
  if (_peerMap && Date.now() - _peerMapAt < 1500) return _peerMap;
  _peerMap = new Map();
  _peerMapAt = Date.now();
  try { for (const p of detectPeers(60 * 60 * 1000)) _peerMap.set(p.sid, p.mtimeMs); } catch {}
  return _peerMap;
}
function effectiveSeen(m) {
  return Math.max(m.lastSeen || 0, peerMtimes().get(m.sid) || 0);
}
function isLive(m) {
  if (!m) return false;
  if (m.status === 'left') return false;
  return now() - effectiveSeen(m) <= TTL_MS;
}

function writeMember(m) {
  const d = ensureDirs();
  m.lastSeen = now();
  atomicWrite(path.join(d.members, safeName(m.sid) + '.json'), JSON.stringify(m, null, 2));
  return m;
}

function getMember(sid) {
  const d = DIRS();
  return readJSON(path.join(d.members, safeName(sid) + '.json'));
}

function touch(sid) {
  const m = getMember(sid);
  if (m) writeMember(m);
}

// ---------------------------------------------------------------------------
// claims
// ---------------------------------------------------------------------------
function readClaims() {
  const d = DIRS();
  let dirs = [];
  try {
    dirs = fs.readdirSync(d.claims);
  } catch {
    return [];
  }
  const out = [];
  for (const k of dirs) {
    const meta = readJSON(path.join(d.claims, k, 'meta.json'));
    if (meta) out.push({ key: k, ...meta });
  }
  return out;
}

function liveMemberMap() {
  const map = new Map();
  for (const m of readMembers()) map.set(m.sid, m);
  return map;
}

function releaseClaimDir(key) {
  const d = DIRS();
  try {
    fs.rmSync(path.join(d.claims, key), { recursive: true, force: true });
  } catch {}
}

// remove dead members + their claims + orphaned claims
function reap() {
  ensureDirs();
  const d = DIRS();
  const members = readMembers();
  const live = new Set();
  let reaped = 0;
  for (const m of members) {
    if (isLive(m)) {
      live.add(m.sid);
    } else if (m.status === 'left' && now() - (m.lastSeen || 0) < 20 * 60 * 1000) {
      // keep recently-departed members ~20m so peer detection can tell they
      // WERE coordinated (their Claude transcript lingers a few minutes after
      // `done`) — without this they'd be mis-flagged as uncoordinated peers.
      continue;
    } else {
      try {
        fs.rmSync(path.join(d.members, safeName(m.sid) + '.json'), { force: true });
        reaped++;
      } catch {}
    }
  }
  for (const c of readClaims()) {
    if (!live.has(c.sid)) {
      releaseClaimDir(c.key);
      reaped++;
    }
  }
  // a delegated task taken by a now-dead session reverts to open so it
  // isn't lost — someone else can pick it up.
  for (const t of readTasks()) {
    if (t.status === 'taken' && !live.has(t.takenBy)) {
      writeTask({ ...t, status: 'open', takenBy: null, rationale: null });
      reaped++;
    }
  }
  return reaped;
}

// ---------------------------------------------------------------------------
// delegated tasks — work one session deliberately offers for another to take,
// typically to preserve its own context budget for work only it can do well
// ---------------------------------------------------------------------------
function readTasks() {
  const d = DIRS();
  let files = [];
  try { files = fs.readdirSync(d.tasks).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => readJSON(path.join(d.tasks, f))).filter(Boolean);
}
function writeTask(t) {
  const d = ensureDirs();
  atomicWrite(path.join(d.tasks, t.id + '.json'), JSON.stringify(t, null, 2));
  return t;
}
function getTask(id) {
  const all = readTasks();
  return all.find((t) => t.id === id) || all.find((t) => t.id.startsWith(id)) || null;
}
function newTaskId() {
  return 't' + crypto.randomBytes(3).toString('hex');
}
// a task is blocked while any dependency still exists unfinished.
function taskBlocked(t, all) {
  if (!t.blockedBy || !t.blockedBy.length) return false;
  return t.blockedBy.some((dep) => {
    const d = all.find((x) => x.id === dep || x.id.startsWith(dep));
    return !!d && d.status !== 'done' && d.status !== 'dropped';
  });
}

// ---------------------------------------------------------------------------
// shared conventions (decisions) — team norms one session sets that ALL must
// follow ("always use model X, never Y"). Surfaced on every board/survey so a
// rule told to one session reaches the others.
// ---------------------------------------------------------------------------
function readDecisions() {
  const d = DIRS();
  let files = [];
  try { files = fs.readdirSync(d.decisions).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => readJSON(path.join(d.decisions, f))).filter(Boolean);
}
function writeDecision(x) {
  const d = ensureDirs();
  atomicWrite(path.join(d.decisions, x.id + '.json'), JSON.stringify(x, null, 2));
  return x;
}

// ---------------------------------------------------------------------------
// proposals — "I'm about to commit/do X; any objections?" A soft consensus gate:
// other live sessions can object (from context they hold) or approve before the
// action lands.
// ---------------------------------------------------------------------------
function readProposals() {
  const d = DIRS();
  let files = [];
  try { files = fs.readdirSync(d.proposals).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => readJSON(path.join(d.proposals, f))).filter(Boolean);
}
function writeProposal(p) {
  const d = ensureDirs();
  atomicWrite(path.join(d.proposals, p.id + '.json'), JSON.stringify(p, null, 2));
  return p;
}
function getProposal(id) {
  const all = readProposals();
  return all.find((p) => p.id === id) || all.find((p) => p.id.startsWith(id)) || null;
}
function newId(prefix) {
  return prefix + crypto.randomBytes(3).toString('hex');
}

// ---------------------------------------------------------------------------
// shared knowledge base — durable findings every new session inherits, so the
// crew doesn't re-derive the same context (the real lever for cheap parallelism)
// ---------------------------------------------------------------------------
function readKnowledge() {
  const d = DIRS();
  let files = [];
  try { files = fs.readdirSync(d.knowledge).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => readJSON(path.join(d.knowledge, f))).filter(Boolean)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
function writeKnowledge(x) {
  const d = ensureDirs();
  atomicWrite(path.join(d.knowledge, x.id + '.json'), JSON.stringify(x, null, 2));
  return x;
}

// all events (parsed) — used by `since` for per-session notifications.
function allEvents() {
  const d = DIRS();
  let text = '';
  try { text = fs.readFileSync(d.events, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// flag conventions an intent text might violate (cheap keyword heuristic so the
// crew is reminded; real judgement is the sessions' job).
function conventionFlags(text) {
  const low = (text || '').toLowerCase();
  const hits = [];
  for (const c of readDecisions()) {
    const rule = (c.text || '').toLowerCase();
    // pull "never/avoid/don't/no <X>" targets and see if the intent mentions X
    const negs = rule.match(/(?:never|avoid|don'?t|no|not)\s+(?:use\s+)?([a-z0-9.\-_/]+)/g) || [];
    for (const n of negs) {
      const target = n.replace(/.*\s/, '');
      if (target.length >= 3 && low.includes(target)) hits.push({ rule: c.text, target, by: c.by });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------
function logEvent(sid, kind, msg, extra = {}) {
  const d = ensureDirs();
  const m = getMember(sid);
  const line =
    JSON.stringify({
      ts: now(),
      sid,
      short: shortId(sid),
      name: m && m.name ? m.name : null,
      kind,
      msg: msg || '',
      ...extra,
    }) + '\n';
  fs.appendFileSync(d.events, line);
}

function recentEvents(n = 12) {
  const d = DIRS();
  let text = '';
  try {
    text = fs.readFileSync(d.events, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').filter(Boolean);
  return lines
    .slice(-n)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------
function label(m) {
  const tag = m.name ? `${m.name} (${shortId(m.sid)})` : shortId(m.sid);
  return tag;
}

// ---------------------------------------------------------------------------
// the human dashboard — agents as characters, not a data dump
// ---------------------------------------------------------------------------
const RESET = '\x1b[0m', BOLD = '\x1b[1m', DIM = '\x1b[2m';
const fg = (n) => `\x1b[38;5;${n}m`;
const trunc = (s, n) => { s = String(s); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s; };

// stable persona (name + avatar + colour) derived from a session id
const PERSONAS = [
  { n: 'Atlas', e: '🦊', t: 'the steady' }, { n: 'Sage', e: '🦉', t: 'the wise' },
  { n: 'Echo', e: '🐺', t: 'the relentless' }, { n: 'Orion', e: '🦅', t: 'the hunter' },
  { n: 'Vega', e: '🦌', t: 'the bright' }, { n: 'Juno', e: '🐯', t: 'the bold' },
  { n: 'Cosmo', e: '🐙', t: 'the tinkerer' }, { n: 'Quill', e: '🦦', t: 'the scribe' },
  { n: 'Titan', e: '🦬', t: 'the workhorse' }, { n: 'Zen', e: '🐢', t: 'the calm' },
  { n: 'Iris', e: '🦩', t: 'the stylist' }, { n: 'Pixel', e: '🐝', t: 'the precise' },
  { n: 'Nyx', e: '🦇', t: 'the night owl' }, { n: 'Draco', e: '🐉', t: 'the firestarter' },
  { n: 'Nova', e: '🦚', t: 'the spark' }, { n: 'Koda', e: '🐻', t: 'the loyal' },
];
const PALETTE = [39, 213, 208, 84, 201, 51, 220, 141, 203, 48, 111, 214, 170, 79, 215, 117];

function personaHash(sid) {
  return parseInt(crypto.createHash('sha1').update(sid).digest('hex').slice(0, 6), 16);
}
// assign a unique persona per sid for ONE render (probe past collisions so no
// two visible agents share a name); colour stays tied to the sid.
function assignPersonas(sids) {
  const used = new Set();
  const map = new Map();
  for (const sid of sids) {
    const h = personaHash(sid);
    let i = h % PERSONAS.length, tries = 0;
    while (used.has(PERSONAS[i].n) && tries < PERSONAS.length) { i = (i + 1) % PERSONAS.length; tries++; }
    used.add(PERSONAS[i].n);
    map.set(sid, { ...PERSONAS[i], color: PALETTE[h % PALETTE.length] });
  }
  return map;
}

// a short human phrase for what this agent most recently did / grabbed
function agentLatest(sid) {
  const verb = {
    claimed: 'grabbing', took: 'took the job', 'took-over': 'took over', 'contest-won': 'won',
    split: 'branched off →', finished: 'finished', released: 'wrapped up', note: '',
    proposed: 'proposing', decreed: 'set a rule', learned: 'noted', objected: 'pushed back',
  };
  const evs = allEvents();
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.sid !== sid || !(e.kind in verb)) continue;
    return (verb[e.kind] ? verb[e.kind] + ': ' : '') + e.msg;
  }
  return null;
}

function renderDashboard(meSid) {
  const r = repo();
  const W = Math.max(56, Math.min(process.stdout.columns || 92, 100));
  const members = readMembers().filter(isLive).sort((a, b) => effectiveSeen(b) - effectiveSeen(a));
  const liveSids = new Set(members.map((m) => m.sid));
  let ghosts = [];
  try { ghosts = detectPeers(TTL_MS).filter((g) => g.sid !== meSid && !liveSids.has(g.sid)); } catch {}
  const pmap = assignPersonas([...members.map((m) => m.sid), ...ghosts.map((g) => g.sid)]);
  const L = [];
  L.push('');
  L.push('  ' + BOLD + '🎓  CLAUDE CLASSROOM' + RESET + DIM + '   ·   ' + (r.topLevel ? path.basename(r.topLevel) : '—') + RESET
    + '   ' + BOLD + fg(220) + members.length + (members.length === 1 ? ' agent' : ' agents')
    + (ghosts.length ? '  +' + ghosts.length + ' detected' : ' live') + RESET);
  L.push('  ' + DIM + '─'.repeat(W) + RESET);
  if (!members.length) {
    L.push(''); L.push('   ' + DIM + 'nobody in class right now — open a session to begin.' + RESET); L.push('');
  }
  for (const m of members) {
    const base = pmap.get(m.sid);
    const p = { emoji: base.e, color: base.color, trait: base.t, name: ((m.name && m.name.trim()) ? m.name.trim() : base.n).toUpperCase() };
    const col = fg(p.color);
    const bar = col + '┃' + RESET;
    const seen = effectiveSeen(m);
    const age = now() - seen;
    const dot = age < 180000 ? fg(82) + '●' + RESET : age < 900000 ? fg(220) + '●' + RESET : DIM + '○' + RESET;
    const you = m.sid === meSid ? DIM + '  (you)' + RESET : '';
    L.push('  ' + bar);
    L.push('  ' + bar + '  ' + p.emoji + '  ' + col + BOLD + p.name + RESET + ' ' + DIM + p.trait + RESET
      + '  ' + DIM + '· ' + shortId(m.sid) + RESET
      + '   ' + dot + ' ' + DIM + rel(seen) + RESET + you);
    const meta = [];
    if (m.branch) meta.push(m.branch);
    if (m.expertise && m.expertise.length) meta.push(m.expertise.slice(0, 3).join(', '));
    meta.push('headroom ' + (m.headroom ?? 100) + '%');
    L.push('  ' + bar + '     ' + DIM + trunc(meta.join('  ·  '), W - 8) + RESET);
    if (m.owns && m.owns.length) L.push('  ' + bar + '     ' + DIM + '⬡ operates: ' + trunc(m.owns.join(', '), W - 18) + RESET);
    const task = (m.task && m.task !== '(auto-enrolled)') ? m.task : 'getting oriented…';
    L.push('  ' + bar + '     ' + col + '“' + trunc(task, W - 12) + '”' + RESET);
    const latest = agentLatest(m.sid);
    if (latest) L.push('  ' + bar + '     ' + DIM + '▸ ' + trunc(latest, W - 12) + RESET);
  }
  if (ghosts.length) {
    L.push('');
    L.push('  ' + DIM + "· · ·  also active here, not enrolled (won't see claims)  · · ·" + RESET);
    for (const g of ghosts) {
      const gb = pmap.get(g.sid);
      const gp = { emoji: gb.e, name: gb.n.toUpperCase() };
      L.push('  ' + DIM + '┃  ' + gp.emoji + '  ' + gp.name + '  · ' + shortId(g.sid)
        + '   ○ ' + rel(g.mtimeMs) + '   — run /claude-classroom to join' + RESET);
    }
  }
  L.push('');
  L.push('  ' + DIM + '─'.repeat(W) + RESET);
  const convs = readDecisions();
  const foot = [];
  if (convs.length) foot.push(fg(220) + '📐 ' + convs.length + (convs.length === 1 ? ' rule' : ' rules') + RESET);
  const claims = readClaims().filter((c) => members.some((m) => m.sid === c.sid)).length;
  if (claims) foot.push(fg(203) + '🔒 ' + claims + ' held' + RESET);
  foot.push(DIM + '⌃C to exit' + RESET);
  L.push('  ' + foot.join(DIM + '   ·   ' + RESET));
  L.push('');
  return L.join('\n');
}

function renderBoard(meSid) {
  const r = repo();
  const members = readMembers().filter(isLive);
  const claims = readClaims().filter((c) => members.some((m) => m.sid === c.sid));
  const lines = [];
  lines.push('═══════════════════ CLAUDE CLASSROOM ═══════════════════');
  lines.push(`repo: ${r.topLevel || process.cwd()}`);
  lines.push(`board: ${coordDir()}`);
  const decisions = readDecisions();
  if (decisions.length) {
    lines.push('');
    lines.push(`TEAM CONVENTIONS (${decisions.length}) — ALL sessions must follow:`);
    for (const c of decisions) lines.push(`  • ${c.text}${c.scope ? '  (' + c.scope + ')' : ''}`);
  }
  const kbCount = readKnowledge().length;
  if (kbCount) lines.push(`SHARED KNOWLEDGE: ${kbCount} fact(s) — run \`knowledge\` to read`);
  lines.push('');
  lines.push(`ACTIVE SESSIONS (${members.length}):`);
  if (members.length === 0) lines.push('  (none)');
  for (const m of members.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))) {
    const you = m.sid === meSid ? ' ← you' : '';
    const wt = m.worktree ? path.basename(m.worktree) : '?';
    const exp = (m.expertise && m.expertise.length) ? m.expertise.join(', ') : '—';
    lines.push(`  • ${label(m)}${you}`);
    lines.push(`      branch:${m.branch || '?'}  worktree:${wt}  seen:${rel(m.lastSeen)}`);
    lines.push(`      context: headroom ${m.headroom ?? 100}%  expertise: ${exp}`);
    lines.push(`      task: ${m.task || '(none set)'}`);
  }
  lines.push('');
  lines.push(`OPEN CLAIMS (${claims.length}):`);
  if (claims.length === 0) lines.push('  (none)');
  for (const c of claims) {
    const owner = members.find((m) => m.sid === c.sid);
    lines.push(`  🔒 ${c.path}  @confidence:${c.confidence ?? 50}`);
    lines.push(`      by:${owner ? label(owner) : shortId(c.sid)}  intent:${c.intent || '-'}  ${rel(c.createdAt)}`);
  }
  const everyTask = readTasks();
  const allTasks = everyTask.filter((t) => t.status === 'open' || t.status === 'taken');
  const openCount = allTasks.filter((t) => t.status === 'open').length;
  lines.push('');
  lines.push(`DELEGATED TASKS (${allTasks.length}, ${openCount} open):`);
  if (allTasks.length === 0) lines.push('  (none)');
  for (const t of allTasks) {
    if (t.status === 'open') {
      if (taskBlocked(t, everyTask)) {
        lines.push(`  ⛔ [${t.id}] (${t.effort}) ${t.title}  (blocked by ${(t.blockedBy || []).join(',')})`);
      } else {
        const addr = t.to ? `→ ${shortId(t.to)}` : '→ anyone';
        lines.push(`  ⇢ [${t.id}] (${t.effort}) ${t.title}  ${addr}`);
        if (t.reason) lines.push(`      from ${shortId(t.createdBy)}: ${t.reason}`);
      }
    } else {
      lines.push(`  ▸ [${t.id}] (${t.effort}) ${t.title}  — ${shortId(t.takenBy)} @fit ${t.fit ?? '?'}`);
    }
  }
  const props = readProposals().filter((p) => p.status === 'open' || p.status === 'objected');
  if (props.length) {
    lines.push('');
    lines.push(`OPEN PROPOSALS (${props.length}) — about to commit; object if you see a problem:`);
    for (const p of props) {
      lines.push(`  ❓ [${p.id}] ${shortId(p.by)}: ${p.intent}${p.status === 'objected' ? '  ⚠OBJECTED' : ''}`);
      for (const o of p.objections) lines.push(`      ✗ ${shortId(o.by)}: ${o.reason}`);
    }
  }
  const ev = recentEvents(8);
  lines.push('');
  lines.push('RECENT ACTIVITY:');
  if (ev.length === 0) lines.push('  (none)');
  for (const e of ev) {
    const who = e.name ? `${e.name}/${e.short}` : e.short;
    lines.push(`  [${rel(e.ts)}] ${who} ${e.kind}: ${e.msg}`);
  }
  lines.push('═════════════════════════════════════════════════════════');
  return lines.join('\n');
}

function gitSurvey() {
  const r = repo();
  if (!r.isGit) return '(not a git repository)';
  const lines = [];
  const branches = git([
    'for-each-ref', '--sort=-committerdate', 'refs/heads',
    '--format=%(refname:short)\t%(committerdate:relative)\t%(subject)',
  ]);
  lines.push('BRANCHES (most recent first):');
  if (branches) for (const b of branches.split('\n').slice(0, 12)) {
    const [name, when, subj] = b.split('\t');
    lines.push(`  ${name}  —  ${when}  —  ${subj || ''}`);
  }
  const log = git(['log', '--all', '-n', '12', '--pretty=%h %an %ar  %s']);
  lines.push('');
  lines.push('RECENT COMMITS (all branches):');
  if (log) for (const l of log.split('\n')) lines.push('  ' + l);
  const wt = git(['worktree', 'list']);
  if (wt) {
    lines.push('');
    lines.push('WORKTREES:');
    for (const l of wt.split('\n')) lines.push('  ' + l);
  }
  const status = git(['status', '--porcelain=v1', '-b']);
  lines.push('');
  lines.push('LOCAL STATUS (this worktree):');
  if (status) for (const l of status.split('\n')) lines.push('  ' + l);
  else lines.push('  (clean)');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// node_modules linking — a fresh git worktree has no installed deps, so it
// can't build or test. For JS/TS projects we symlink the source checkout's
// node_modules (root + every workspace package) into the new worktree so it is
// immediately usable. Symlinks (not copies) keep it instant and disk-cheap.
// ---------------------------------------------------------------------------
function findNodeModules(root, maxDepth = 3) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.name === 'node_modules') { found.push(full); continue; } // never descend into one
      if (depth < maxDepth) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

function linkNodeModules(srcRoot, destRoot) {
  const links = [];
  for (const nm of findNodeModules(srcRoot)) {
    const rel = path.relative(srcRoot, nm);
    const dest = path.join(destRoot, rel);
    try {
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.symlinkSync(nm, dest);
      links.push(rel || 'node_modules');
    } catch {}
  }
  return links;
}

// ---------------------------------------------------------------------------
// peer detection — find OTHER Claude Code sessions active in this repo even if
// they never ran the classroom. Claude Code writes a transcript to
//   ~/.claude/projects/<cwd-with-nonalnum-as-dashes>/<session-id>.jsonl
// and touches it on every turn, so a recently-modified transcript under this
// repo's (or a worktree's) encoded dir is a live session. We cross-reference
// those session ids against enrolled members: matches are coordinated; the rest
// are uncoordinated peers who won't see your claims — so you must stay
// defensive (atomic, surgical edits).
// ---------------------------------------------------------------------------
function projectEncode(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function detectPeers(withinMs) {
  const r = repo();
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  const paths = new Set([process.cwd()]);
  if (r.topLevel) paths.add(r.topLevel);
  const wt = git(['worktree', 'list', '--porcelain']);
  if (wt) for (const line of wt.split('\n')) {
    if (line.startsWith('worktree ')) paths.add(line.slice('worktree '.length).trim());
  }
  const bySid = new Map();
  for (const p of paths) {
    const dir = path.join(projectsRoot, projectEncode(p));
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const sid = f.slice(0, -'.jsonl'.length);
      let st;
      try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
      if (now() - st.mtimeMs > withinMs) continue;
      const prev = bySid.get(sid);
      if (!prev || st.mtimeMs > prev.mtimeMs) bySid.set(sid, { sid, mtimeMs: st.mtimeMs, where: projectEncode(p) });
    }
  }
  return Array.from(bySid.values());
}

function peerReport(meSid, withinMin = 10) {
  const detected = detectPeers(withinMin * 60 * 1000).filter((p) => p.sid !== meSid);
  const members = readMembers();
  const liveMembers = new Set(members.filter(isLive).map((m) => m.sid));
  // known = every member on record, including recently-departed ('left') ones,
  // so a session that DID coordinate then left isn't mis-flagged.
  const knownMembers = new Set(members.map((m) => m.sid));
  return {
    withinMin,
    coordinated: detected.filter((p) => liveMembers.has(p.sid)),
    uncoordinated: detected.filter((p) => !knownMembers.has(p.sid)),
  };
}

// One-line awareness banner printed after the board on enroll/survey.
function printPeerBanner(meSid) {
  const { uncoordinated, withinMin } = peerReport(meSid);
  if (!uncoordinated.length) return;
  console.log('');
  console.log(`⚠ ${uncoordinated.length} Claude Code session(s) are active in this repo but NOT enrolled in the classroom`);
  for (const p of uncoordinated) {
    console.log(`    • ${shortId(p.sid)}  (seen ${rel(p.mtimeMs)}, last ${withinMin}m)  — won't see your claims`);
  }
  console.log('  → Be defensive: make ATOMIC, surgical edits; never `git add -A`; re-read each file right before editing;');
  console.log('    prefer your own worktree; commit small. Ask them to run /claude-classroom so claims + delegation work both ways.');
}

// ---------------------------------------------------------------------------
// messages, missions, recipient resolution
// ---------------------------------------------------------------------------
function readMessages() {
  const d = DIRS();
  let files = [];
  try { files = fs.readdirSync(d.messages).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => readJSON(path.join(d.messages, f))).filter(Boolean).sort((a, b) => a.ts - b.ts);
}
function writeMessage(m) { const d = ensureDirs(); atomicWrite(path.join(d.messages, m.id + '.json'), JSON.stringify(m, null, 2)); return m; }
function writeMission(x) { const d = ensureDirs(); atomicWrite(path.join(d.missions, x.id + '.json'), JSON.stringify(x, null, 2)); return x; }

// resolve a token (sid, short id, or persona/display name) to a live member's sid.
function resolveSid(token) {
  if (!token) return null;
  const t = String(token).toLowerCase();
  if (['all', 'everyone', 'team', '*'].includes(t)) return 'all';
  const members = readMembers().filter(isLive);
  const pmap = assignPersonas(members.map((m) => m.sid));
  for (const m of members) {
    if (m.sid === token || m.sid.startsWith(token) || shortId(m.sid) === token) return m.sid;
    const nm = ((m.name && m.name.trim()) ? m.name.trim() : pmap.get(m.sid).n).toLowerCase();
    if (nm === t.replace(/^@/, '')) return m.sid;
  }
  return null;
}

// fit score of a member for a task (shared by suggest + work-stealing).
// how strongly a member "owns"/operates a given path or area (0..100).
function ownerMatch(member, target) {
  const owns = member.owns || [];
  if (!owns.length || !target) return 0;
  const t = String(target).toLowerCase();
  const tw = new Set(t.match(/[a-z0-9]{3,}/g) || []);
  let best = 0;
  for (const z of owns) {
    const zo = z.toLowerCase().replace(/[*]+$/, '').replace(/\/+$/, '').trim();
    if (!zo) continue;
    if (t === zo) best = Math.max(best, 100);
    else if (t.startsWith(zo + '/') || zo.startsWith(t + '/') || t.startsWith(zo)) best = Math.max(best, 90); // path zone
    else if (zo.includes('/') && t.includes(zo)) best = Math.max(best, 80);
    else if ((zo.match(/[a-z0-9]{3,}/g) || []).some((w) => tw.has(w))) best = Math.max(best, 65); // topic
  }
  return best;
}
function fitScore(member, task) {
  const tok = (s) => (s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const kw = new Set([...tok(task.title), ...tok(task.area)]);
  const exp = (member.expertise || []).map((e) => e.toLowerCase());
  let overlap = 0;
  for (const e of exp) for (const k of kw) if (e.includes(k) || k.includes(e)) overlap += 1;
  const head = (member.headroom ?? 100) / 100;
  const base = (overlap * 40 + 10) * (0.5 + 0.5 * head);
  // owning the area/path is the strongest fit signal — route it to the operator.
  const own = Math.max(ownerMatch(member, task.area), ownerMatch(member, task.title)) * (0.6 + 0.4 * head);
  return Math.max(0, Math.min(100, Math.round(Math.max(base, own))));
}

// hook command string (absolute node + this script) — for install/adopt.
function hookCmd(sub) {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(__filename)} ${sub}`;
}

// xterm-256 -> hex, and ANSI -> HTML (for the browser dashboard export).
function xtermHex(n) {
  const b = ['#000000','#cd3131','#0dbc79','#e5e510','#2472c8','#bc3fbc','#11a8cd','#e5e5e5','#666666','#f14c4c','#23d18b','#f5f543','#3b8eea','#d670d6','#29b8db','#ffffff'];
  if (n < 16) return b[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return '#' + v.toString(16).padStart(2, '0').repeat(3); }
  n -= 16; const lv = [0,95,135,175,215,255];
  return '#' + [lv[Math.floor(n/36)%6], lv[Math.floor(n/6)%6], lv[n%6]].map((x) => x.toString(16).padStart(2,'0')).join('');
}
function ansiToHtml(text) {
  const escp = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  let html = '';
  for (const line of text.replace(/\r/g,'').split('\n')) {
    let fg = null, bold = false, dim = false, buf = '';
    const flush = () => { if (!buf) return; const c = fg || (dim ? '#7d8590' : '#c9d1d9'); html += `<span style="color:${c};${bold?'font-weight:700':''}">${escp(buf)}</span>`; buf = ''; };
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\x1b' && line[i+1] === '[') { const m = line.slice(i).match(/^\x1b\[([0-9;]*)m/); if (m) { flush(); const cs = m[1].split(';').map(Number); for (let k=0;k<cs.length;k++){const x=cs[k]; if(x===0){fg=null;bold=false;dim=false;}else if(x===1)bold=true;else if(x===2)dim=true;else if(x===22){bold=false;dim=false;}else if(x===39)fg=null;else if(x===38&&cs[k+1]===5){fg=xtermHex(cs[k+2]);k+=2;}} i+=m[0].length-1; continue; } }
      buf += line[i];
    }
    flush(); html += '\n';
  }
  return `<!doctype html><meta charset="utf8"><title>Claude Classroom</title><style>body{margin:0;background:#010409;padding:24px}pre{margin:0;font:15px/1.5 ui-monospace,Menlo,monospace;background:#0d1117;border:1px solid #21262d;border-radius:12px;padding:16px 20px;color:#c9d1d9;white-space:pre;display:inline-block}</style><pre>${html}</pre>`;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
const COMMANDS = {};

COMMANDS.enroll = (args) => {
  ensureDirs();
  reap();
  const r = repo();
  // Run-once-forever: the first time the skill is used in a repo, wire up the
  // hooks so every FUTURE session auto-joins without anyone invoking anything.
  if (r.isGit && !args['no-autoinstall'] && !isInstalled()) {
    try { COMMANDS.install({ _: [], 'no-precommit': !!args['no-precommit'], auto: true }); } catch {}
  }
  const sid = sessionId(args);
  let m = getMember(sid) || {
    sid,
    startedAt: now(),
    host: os.hostname(),
  };
  m.name = args.name || m.name || null;
  if (args.task) m.task = args.task;
  if (args.expertise) m.expertise = parseList(args.expertise);
  else if (!m.expertise) m.expertise = [];
  if (args.owns) m.owns = parseList(args.owns);
  else if (!m.owns) m.owns = [];
  if (args.headroom !== undefined) m.headroom = clampPct(args.headroom);
  else if (m.headroom === undefined) m.headroom = 100;
  if (args.note) m.contextNote = String(args.note);
  m.pid = process.pid;
  m.host = os.hostname();
  m.cwd = process.cwd();
  m.worktree = r.topLevel || process.cwd();
  m.branch = r.branch || null;
  m.status = 'active';
  writeMember(m);
  logEvent(sid, 'enrolled', m.task ? `working on: ${m.task}` : 'joined the classroom');
  console.log(renderBoard(sid));
  console.log('');
  console.log(`✔ enrolled as ${label(m)}   (sid=${sid})`);
  const others = readMembers().filter((x) => isLive(x) && x.sid !== sid);
  if (others.length) {
    console.log(`⚠ ${others.length} other enrolled session(s) are live. SURVEY before editing, and CLAIM files first.`);
  }
  console.log(`👀 Watch the live dashboard anytime:  ${watchCmd()}`);
  printPeerBanner(sid);
  meshAuto();
};

COMMANDS.survey = (args) => {
  ensureDirs();
  reap();
  const sid = sessionId(args);
  touch(sid);
  console.log(renderBoard(sid));
  console.log('');
  console.log(gitSurvey());
  // conflict pre-check for paths the caller intends to touch
  const wants = args._.length ? args._ : (args.paths ? String(args.paths).split(',') : []);
  if (wants.length) {
    const norm = wants.map(normPath);
    const members = readMembers();
    const conflicts = [];
    for (const c of readClaims()) {
      if (c.sid === sid) continue;
      const owner = members.find((m) => m.sid === c.sid);
      if (!isLive(owner)) continue;
      for (const w of norm) if (pathsOverlap(w, c.path)) conflicts.push({ w, c, owner });
    }
    console.log('');
    console.log('PRE-CHANGE CONFLICT CHECK:');
    if (!conflicts.length) console.log('  ✔ none of your target paths are claimed by another live session.');
    for (const x of conflicts) {
      console.log(`  ✗ ${x.w} overlaps claim "${x.c.path}" held by ${label(x.owner)} (intent: ${x.c.intent || '-'})`);
    }
  }
  printPeerBanner(sid);
};

COMMANDS.claim = (args) => {
  ensureDirs();
  reap();
  const sid = sessionId(args);
  const m = getMember(sid);
  if (!m) {
    console.error('✗ not enrolled. Run `enroll` first.');
    process.exit(2);
  }
  touch(sid);
  const wants = args._.map(normPath);
  if (!wants.length) {
    console.error('✗ usage: claim <path> [path...] --intent "why"');
    process.exit(2);
  }
  const intent = args.intent || '';
  const confidence = clampPct(args.confidence ?? 50);
  const rationale = args.rationale || '';
  // the scan-then-acquire must be atomic across sessions, else two sessions
  // can each pass the prefix-overlap scan and both acquire (different keys).
  const result = withLock(() => {
    const members = readMembers();
    const conflicts = [];
    for (const c of readClaims()) {
      if (c.sid === sid) continue;
      const owner = members.find((x) => x.sid === c.sid);
      if (!isLive(owner)) continue;
      for (const w of wants) if (pathsOverlap(w, c.path)) conflicts.push({ w, c, owner });
    }
    if (conflicts.length && !args.force) return { ok: false, conflicts };
    const d = DIRS();
    const acquired = [];
    for (const w of wants) {
      const dir = path.join(d.claims, claimKey(w));
      try { fs.mkdirSync(dir); } catch { /* self / stale — overwrite meta below */ }
      atomicWrite(path.join(dir, 'meta.json'), JSON.stringify({ path: w, sid, intent, confidence, rationale, createdAt: now() }, null, 2));
      acquired.push(w);
    }
    return { ok: true, acquired };
  });

  if (!result.ok) {
    console.error('✗ CLAIM REFUSED — overlap with live session(s):');
    for (const x of result.conflicts) {
      const conf = x.c.confidence ?? 50;
      console.error(`   ${x.w}  ⨯  "${x.c.path}" held by ${label(x.owner)} @confidence:${conf}`);
      console.error(`       their intent: ${x.c.intent || '-'}${x.c.rationale ? `  | why them: ${x.c.rationale}` : ''}`);
    }
    console.error(`   → If you genuinely have better context, make your case:`);
    console.error(`       contest ${result.conflicts.map((x) => x.w).join(' ')} --confidence <0-100> --rationale "why you'd do this better"`);
    console.error('     Otherwise: pick different files, negotiate via `sync "..."`, or `delegate` it. (--force only in emergencies)');
    process.exit(1);
  }
  logEvent(sid, 'claimed', `${result.acquired.join(', ')}${intent ? ' — ' + intent : ''} (confidence ${confidence})`, { paths: result.acquired });
  console.log(`✔ claimed (${result.acquired.length}) @confidence ${confidence}: ${result.acquired.join(', ')}`);
};

COMMANDS.release = (args) => {
  ensureDirs();
  const sid = sessionId(args);
  touch(sid);
  const all = readClaims().filter((c) => c.sid === sid);
  let targets = all;
  if (args._.length) {
    const norm = args._.map(normPath);
    targets = all.filter((c) => norm.includes(c.path));
  }
  for (const c of targets) releaseClaimDir(c.key);
  logEvent(sid, 'released', targets.map((c) => c.path).join(', ') || '(nothing)');
  console.log(`✔ released ${targets.length} claim(s): ${targets.map((c) => c.path).join(', ') || '(none)'}`);
};

COMMANDS.sync = (args) => {
  ensureDirs();
  const sid = sessionId(args);
  touch(sid);
  const msg = args._.join(' ') || args.msg || '';
  if (!msg) {
    console.error('✗ usage: sync "your standup note / finding / intent"');
    process.exit(2);
  }
  logEvent(sid, 'note', msg);
  console.log(`✔ posted to the board: ${msg}`);
};

COMMANDS.profile = (args) => {
  ensureDirs();
  const sid = sessionId(args);
  const m = getMember(sid);
  if (!m) { console.error('✗ not enrolled. Run `enroll` first.'); process.exit(2); }
  if (args.expertise) m.expertise = parseList(args.expertise);
  if (args.owns) m.owns = parseList(args.owns);
  if (args.headroom !== undefined) m.headroom = clampPct(args.headroom);
  if (args.note) m.contextNote = String(args.note);
  writeMember(m);
  const exp = (m.expertise || []).join(', ') || '—';
  logEvent(sid, 'profile', `headroom:${m.headroom ?? 100}% expertise:[${exp}]`);
  console.log(`✔ profile — headroom ${m.headroom ?? 100}%  expertise: ${exp}${m.contextNote ? '  note: ' + m.contextNote : ''}`);
};

// Reasoned negotiation: challenge an existing claim when you genuinely have
// better context. Higher confidence wins; ties keep the incumbent (no thrash).
COMMANDS.contest = (args) => {
  ensureDirs();
  reap();
  const sid = sessionId(args);
  const me = getMember(sid);
  if (!me) { console.error('✗ not enrolled. Run `enroll` first.'); process.exit(2); }
  touch(sid);
  const wants = args._.map(normPath);
  if (!wants.length) { console.error('✗ usage: contest <path>... --confidence <0-100> --rationale "why you would do this better"'); process.exit(2); }
  const myConf = clampPct(args.confidence ?? 60);
  const rationale = args.rationale || '';
  const outcomes = withLock(() => {
    const members = readMembers();
    const d = DIRS();
    const res = [];
    for (const w of wants) {
      let target = null;
      for (const c of readClaims()) {
        if (c.sid === sid) continue;
        if (!isLive(members.find((x) => x.sid === c.sid))) continue;
        if (pathsOverlap(w, c.path)) { target = c; break; }
      }
      if (!target) {
        const dir = path.join(d.claims, claimKey(w));
        try { fs.mkdirSync(dir); } catch {}
        atomicWrite(path.join(dir, 'meta.json'), JSON.stringify({ path: w, sid, intent: args.intent || '', confidence: myConf, rationale, createdAt: now() }, null, 2));
        res.push({ w, result: 'acquired' });
        continue;
      }
      const holderConf = target.confidence ?? 50;
      const holder = members.find((x) => x.sid === target.sid);
      if (myConf > holderConf) {
        atomicWrite(path.join(d.claims, target.key, 'meta.json'), JSON.stringify({ path: target.path, sid, intent: args.intent || '', confidence: myConf, rationale, createdAt: now() }, null, 2));
        res.push({ w, result: 'won', target, holder, holderConf });
      } else {
        res.push({ w, result: 'yielded', target, holder, holderConf });
      }
    }
    return res;
  });
  for (const o of outcomes) {
    if (o.result === 'acquired') {
      console.log(`✔ ${o.w}: was unclaimed — acquired @confidence ${myConf}.`);
      logEvent(sid, 'claimed', `${o.w} (uncontested, confidence ${myConf})`, { paths: [o.w] });
    } else if (o.result === 'won') {
      console.log(`✔ ${o.w}: WON from ${label(o.holder)} (${myConf} > ${o.holderConf}) — it's yours now.`);
      logEvent(sid, 'contest-won', `took "${o.target.path}" from ${shortId(o.target.sid)} (${myConf}>${o.holderConf})${rationale ? ' — ' + rationale : ''}`, { paths: [o.target.path], from: o.target.sid });
    } else {
      console.log(`✗ ${o.w}: YIELDED to ${label(o.holder)} (${myConf} ≤ ${o.holderConf}). They keep it — defer, pick another file, or accept a delegated piece.`);
      logEvent(sid, 'contest-lost', `yielded "${o.target.path}" to ${shortId(o.target.sid)} (${myConf}≤${o.holderConf})`, { paths: [o.target.path] });
    }
  }
};

// Delegation: offer work you could do but shouldn't — to preserve your own
// context budget for the parts only you are positioned to do well.
COMMANDS.delegate = (args) => {
  ensureDirs();
  const sid = sessionId(args);
  if (!getMember(sid)) { console.error('✗ not enrolled.'); process.exit(2); }
  touch(sid);
  const title = args._.join(' ').trim() || args.title || '';
  if (!title) { console.error('✗ usage: delegate "<task>" [--reason "why"] [--area x] [--effort low|med|high] [--to <sid>] [--mission <id>] [--after-commit]'); process.exit(2); }
  const blockedBy = args['blocked-by'] ? parseList(args['blocked-by']) : [];
  const to = args.to ? (resolveSid(args.to) || args.to) : null;
  const t = {
    id: newTaskId(), title, area: args.area || null, reason: args.reason || '',
    effort: args.effort || 'low', to, createdBy: sid,
    status: 'open', takenBy: null, rationale: null, blockedBy,
    mission: args.mission || null, afterCommit: !!args['after-commit'], createdAt: now(),
  };
  writeTask(t);
  logEvent(sid, 'delegated', `[${t.id}] ${title}${t.reason ? ' — ' + t.reason : ''}${blockedBy.length ? ' (blocked by ' + blockedBy.join(',') + ')' : ''}`, { task: t.id });
  console.log(`✔ delegated [${t.id}] "${title}" (effort:${t.effort}${t.to ? ', to ' + shortId(t.to) : ', open to anyone'}${blockedBy.length ? ', blocked by ' + blockedBy.join(',') : ''}).`);
  if (!blockedBy.length) console.log(`  Others see it via \`offers\` and claim it with \`take ${t.id}\`.`);
};

COMMANDS.offers = (args) => {
  ensureDirs();
  reap();
  const sid = sessionId(args);
  const all = readTasks();
  const open = all.filter((t) => t.status === 'open');
  const ready = open.filter((t) => !taskBlocked(t, all));
  const blocked = open.filter((t) => taskBlocked(t, all));
  console.log(`OPEN DELEGATED TASKS (${ready.length} ready${blocked.length ? `, ${blocked.length} blocked` : ''}):`);
  if (!ready.length) console.log('  (none ready)');
  for (const t of ready) {
    const addr = t.to ? (t.to === sid ? '→ for YOU' : `→ for ${shortId(t.to)}`) : '→ anyone';
    console.log(`  [${t.id}] (${t.effort}) ${t.title}  ${addr}`);
    console.log(`      from ${shortId(t.createdBy)}${t.area ? '  area:' + t.area : ''}${t.reason ? '  reason: ' + t.reason : ''}`);
  }
  for (const t of blocked) console.log(`  ⛔ [${t.id}] ${t.title}  (blocked by ${(t.blockedBy || []).join(',')})`);
  console.log('  → take <id> to claim a ready one.');
};
COMMANDS.inbox = COMMANDS.offers;

COMMANDS.take = (args) => {
  ensureDirs();
  reap();
  const sid = sessionId(args);
  if (!getMember(sid)) { console.error('✗ not enrolled.'); process.exit(2); }
  touch(sid);
  const id = args._[0] || args.id;
  if (!id) { console.error('✗ usage: take <taskId> [--fit <0-100>] [--rationale "..."]'); process.exit(2); }
  const fit = clampPct(args.fit ?? 60);
  const rationale = args.rationale || '';
  const outcome = withLock(() => {
    const t = getTask(id);
    if (!t) return { err: 'no such task' };
    if (t.to && t.to !== sid) return { err: `task is addressed to ${shortId(t.to)}` };
    if (t.status === 'done' || t.status === 'dropped') return { err: `task is ${t.status}` };
    if (taskBlocked(t, readTasks())) return { err: `blocked by ${(t.blockedBy || []).join(',')} — finish those first` };
    if (t.status === 'taken' && t.takenBy !== sid) {
      // fit-based contest for the task: a clearly better-fit session takes over.
      const heldFit = t.fit ?? 50;
      if (fit <= heldFit) {
        return { err: `held by ${shortId(t.takenBy)} @fit ${heldFit}; your fit ${fit} isn't higher — make a stronger case or pick another task.` };
      }
      writeTask({ ...t, status: 'taken', takenBy: sid, fit, rationale, takenAt: now(), tookFrom: t.takenBy });
      return { t, tookFrom: t.takenBy, heldFit };
    }
    writeTask({ ...t, status: 'taken', takenBy: sid, fit, rationale, takenAt: now() });
    return { t };
  });
  if (outcome.err) { console.error('✗ ' + outcome.err); process.exit(1); }
  if (outcome.tookFrom) {
    logEvent(sid, 'took-over', `[${outcome.t.id}] ${outcome.t.title} from ${shortId(outcome.tookFrom)} (fit ${fit}>${outcome.heldFit})${rationale ? ' — ' + rationale : ''}`, { task: outcome.t.id });
    console.log(`✔ took over [${outcome.t.id}] from ${shortId(outcome.tookFrom)} (fit ${fit} > ${outcome.heldFit}) — better-fit reassignment.`);
  } else {
    logEvent(sid, 'took', `[${outcome.t.id}] ${outcome.t.title} (fit ${fit})`, { task: outcome.t.id });
    console.log(`✔ took [${outcome.t.id}] "${outcome.t.title}" @fit ${fit}. Now claim the files and do it.`);
  }
};

// suggest — the facilitation layer: score every open task against every live
// member's expertise + headroom and recommend an allocation. Advisory: sessions
// still `take` (with fit), and a better fit can contest — but this grounds the
// "who's best equipped?" discussion in the crew's declared context.
COMMANDS.suggest = (args) => {
  ensureDirs();
  reap();
  const members = readMembers().filter(isLive);
  const allT = readTasks();
  const tasks = allT.filter((t) => (t.status === 'open' && !taskBlocked(t, allT)) || (args.all && t.status === 'taken'));
  if (!members.length) { console.log('No live members to allocate to.'); return; }
  if (!tasks.length) { console.log('No ready tasks to allocate (all done or blocked). Post a backlog with `delegate "<task>" --area <x>`.'); return; }
  const load = new Map(); // soft load-balancing: discourage piling on one session
  console.log('SUGGESTED ALLOCATION  (ownership > expertise, scaled by headroom & load)');
  for (const t of tasks) {
    const scored = members.map((m) => {
      const own = Math.max(ownerMatch(m, t.area), ownerMatch(m, t.title));
      const fit = Math.max(0, Math.round(fitScore(m, t) - (load.get(m.sid) || 0) * 12));
      return { m, own, fit };
    }).sort((a, b) => b.own - a.own || b.fit - a.fit);
    const best = scored[0];
    load.set(best.m.sid, (load.get(best.m.sid) || 0) + 1);
    const why = best.own > 0 ? `OWNS this area` : (best.fit > 15 ? 'expertise fit' : 'no match — by free budget');
    console.log(`  [${t.id}] (${t.effort}) ${t.title}`);
    console.log(`      → ${label(best.m)}   fit≈${best.fit}   (${why}, headroom ${best.m.headroom ?? 100}%)`);
    const runners = scored.slice(1, 3).filter((s) => s.fit > 0).map((s) => `${shortId(s.m.sid)}:${s.fit}`).join('  ');
    if (runners) console.log(`        runners-up: ${runners}`);
  }
  console.log('  → Advisory. Each session: `take <id> --fit <n> --rationale "..."`. Disagree? higher fit wins.');
};

COMMANDS.finish = (args) => {
  ensureDirs();
  const sid = sessionId(args);
  touch(sid);
  const id = args._[0] || args.id;
  if (!id) { console.error('✗ usage: finish <taskId>'); process.exit(2); }
  const t = getTask(id);
  if (!t) { console.error('✗ no such task'); process.exit(1); }
  writeTask({ ...t, status: 'done', doneBy: sid, doneAt: now() });
  logEvent(sid, 'finished', `[${t.id}] ${t.title}`, { task: t.id });
  console.log(`✔ finished [${t.id}] "${t.title}".`);
  const after = readTasks();
  const freed = after.filter((x) => x.status === 'open'
    && (x.blockedBy || []).some((b) => t.id === b || t.id.startsWith(b))
    && !taskBlocked(x, after));
  for (const u of freed) {
    logEvent(sid, 'unblocked', `[${u.id}] ${u.title}`, { task: u.id });
    console.log(`  ▸ unblocked [${u.id}] "${u.title}" — now ready to take.`);
  }
};

COMMANDS.drop = (args) => {
  ensureDirs();
  const sid = sessionId(args);
  touch(sid);
  const id = args._[0] || args.id;
  if (!id) { console.error('✗ usage: drop <taskId>'); process.exit(2); }
  const t = getTask(id);
  if (!t) { console.error('✗ no such task'); process.exit(1); }
  if (t.createdBy === sid) {
    writeTask({ ...t, status: 'dropped', droppedBy: sid, droppedAt: now() });
    console.log(`✔ cancelled [${t.id}].`);
  } else {
    writeTask({ ...t, status: 'open', takenBy: null, rationale: null });
    console.log(`✔ returned [${t.id}] to the open pool.`);
  }
  logEvent(sid, 'dropped', `[${t.id}] ${t.title}`, { task: t.id });
};

// ---- team conventions (decisions everyone must follow) ----
COMMANDS.decree = (args) => {
  ensureDirs();
  const sid = sessionId(args);
  if (!getMember(sid)) { console.error('✗ not enrolled. Run `enroll` first.'); process.exit(2); }
  touch(sid);
  const text = args._.join(' ').trim() || args.text || '';
  if (!text) { console.error('✗ usage: decree "<convention everyone must follow>" [--scope <area>]'); process.exit(2); }
  const x = { id: newId('d'), text, scope: args.scope || null, by: sid, createdAt: now() };
  writeDecision(x);
  logEvent(sid, 'decreed', text, { decision: x.id });
  console.log(`✔ convention [${x.id}] set: "${text}"${x.scope ? ' (scope: ' + x.scope + ')' : ''}`);
  console.log('  Every session sees this on enroll/survey. Revoke with: revoke ' + x.id);
};

COMMANDS.conventions = (args) => {
  ensureDirs();
  const ds = readDecisions();
  console.log(`TEAM CONVENTIONS (${ds.length}) — all sessions must follow:`);
  if (!ds.length) console.log('  (none)');
  for (const c of ds) console.log(`  • [${c.id}] ${c.text}${c.scope ? '  (scope: ' + c.scope + ')' : ''}  — by ${shortId(c.by)}`);
};
COMMANDS.decrees = COMMANDS.conventions;

COMMANDS.revoke = (args) => {
  ensureDirs();
  const sid = sessionId(args); touch(sid);
  const id = args._[0] || args.id;
  if (!id) { console.error('✗ usage: revoke <conventionId>'); process.exit(2); }
  const d = DIRS();
  const x = readDecisions().find((c) => c.id === id || c.id.startsWith(id));
  if (!x) { console.error('✗ no such convention'); process.exit(1); }
  try { fs.rmSync(path.join(d.decisions, x.id + '.json'), { force: true }); } catch {}
  logEvent(sid, 'revoked', x.text, { decision: x.id });
  console.log(`✔ revoked convention [${x.id}].`);
};

// ---- announce-before-commit consensus ----
COMMANDS.propose = (args) => {
  ensureDirs(); reap();
  const sid = sessionId(args);
  if (!getMember(sid)) { console.error('✗ not enrolled. Run `enroll` first.'); process.exit(2); }
  touch(sid);
  const intent = args._.join(' ').trim() || args.intent || '';
  if (!intent) { console.error('✗ usage: propose "<what you\'re about to commit/do>" [--files a,b]'); process.exit(2); }
  const files = args.files ? parseList(args.files) : [];
  const p = { id: newId('p'), by: sid, intent, files, status: 'open', objections: [], approvals: [], createdAt: now() };
  writeProposal(p);
  logEvent(sid, 'proposed', `[${p.id}] ${intent}`, { proposal: p.id });
  console.log(`✔ proposed [${p.id}] "${intent}"`);
  for (const f of conventionFlags(intent)) {
    console.log(`  ⚠ may violate a team convention: "${f.rule}" (set by ${shortId(f.by)}) — reconsider before committing.`);
  }
  const others = readMembers().filter((m) => isLive(m) && m.sid !== sid);
  console.log(`  → ${others.length} other live session(s) may object/approve. Before you commit, run: proposal ${p.id}`);
};

COMMANDS.proposals = (args) => {
  ensureDirs(); reap();
  const open = readProposals().filter((p) => p.status === 'open' || p.status === 'objected');
  console.log(`OPEN PROPOSALS (${open.length}):`);
  if (!open.length) console.log('  (none)');
  for (const p of open) {
    console.log(`  [${p.id}] by ${shortId(p.by)}${p.status === 'objected' ? ' ⚠OBJECTED' : ''}: ${p.intent}`);
    for (const o of p.objections) console.log(`      ✗ ${shortId(o.by)}: ${o.reason}`);
  }
  console.log('  → object <id> --reason ".." | approve <id> | proposal <id>');
};

COMMANDS.object = (args) => {
  ensureDirs();
  const sid = sessionId(args); touch(sid);
  const id = args._[0] || args.id;
  if (!id) { console.error('✗ usage: object <proposalId> --reason "why"'); process.exit(2); }
  const reason = args.reason || args._.slice(1).join(' ') || '';
  const out = withLock(() => {
    const p = getProposal(id);
    if (!p) return { err: 'no such proposal' };
    if (p.status === 'committed' || p.status === 'withdrawn') return { err: `proposal already ${p.status}` };
    p.objections = [...p.objections.filter((o) => o.by !== sid), { by: sid, reason, at: now() }];
    p.status = 'objected';
    writeProposal(p);
    return { p };
  });
  if (out.err) { console.error('✗ ' + out.err); process.exit(1); }
  logEvent(sid, 'objected', `[${out.p.id}] ${reason}`, { proposal: out.p.id });
  console.log(`✔ objection recorded on [${out.p.id}]: ${reason}`);
};

COMMANDS.approve = (args) => {
  ensureDirs();
  const sid = sessionId(args); touch(sid);
  const id = args._[0] || args.id;
  if (!id) { console.error('✗ usage: approve <proposalId>'); process.exit(2); }
  const out = withLock(() => {
    const p = getProposal(id);
    if (!p) return { err: 'no such proposal' };
    p.approvals = Array.from(new Set([...(p.approvals || []), sid]));
    writeProposal(p);
    return { p };
  });
  if (out.err) { console.error('✗ ' + out.err); process.exit(1); }
  logEvent(sid, 'approved', `[${out.p.id}]`, { proposal: out.p.id });
  console.log(`✔ approved [${out.p.id}]`);
};

COMMANDS.proposal = (args) => {
  ensureDirs(); reap();
  const id = args._[0] || args.id;
  if (!id) { console.error('✗ usage: proposal <proposalId>'); process.exit(2); }
  const p = getProposal(id);
  if (!p) { console.error('✗ no such proposal'); process.exit(1); }
  console.log(`PROPOSAL [${p.id}] by ${shortId(p.by)} — status: ${p.status.toUpperCase()}`);
  console.log(`  intent: ${p.intent}`);
  if (p.files && p.files.length) console.log(`  files: ${p.files.join(', ')}`);
  console.log(`  objections (${p.objections.length}):`);
  for (const o of p.objections) console.log(`    ✗ ${shortId(o.by)}: ${o.reason}`);
  console.log(`  approvals: ${(p.approvals || []).map(shortId).join(', ') || '(none)'}`);
  if (p.objections.length) console.log('  → Address the objections before committing.');
  else console.log('  → No objections recorded. Clear to proceed (re-check right before committing).');
};

COMMANDS.withdraw = (args) => {
  ensureDirs();
  const sid = sessionId(args); touch(sid);
  const id = args._[0] || args.id;
  if (!id) { console.error('✗ usage: withdraw <proposalId> [--committed]'); process.exit(2); }
  const p = getProposal(id);
  if (!p) { console.error('✗ no such proposal'); process.exit(1); }
  const status = args.committed ? 'committed' : 'withdrawn';
  writeProposal({ ...p, status });
  logEvent(sid, status === 'committed' ? 'committed' : 'withdrew', `[${p.id}] ${p.intent}`, { proposal: p.id });
  console.log(`✔ proposal [${p.id}] ${status}.`);
};

// ---- shared knowledge base (#4) ----
COMMANDS.learn = (args) => {
  ensureDirs();
  const sid = sessionId(args);
  if (!getMember(sid)) { console.error('✗ not enrolled. Run `enroll` first.'); process.exit(2); }
  touch(sid);
  const text = args._.join(' ').trim() || args.text || '';
  if (!text) { console.error('✗ usage: learn "<durable fact future sessions should know>"'); process.exit(2); }
  const x = { id: newId('k'), text, by: sid, createdAt: now() };
  writeKnowledge(x);
  logEvent(sid, 'learned', text, { knowledge: x.id });
  console.log(`✔ knowledge [${x.id}] recorded: "${text}" — every new session inherits this.`);
};
COMMANDS.knowledge = (args) => {
  ensureDirs();
  const ks = readKnowledge();
  console.log(`SHARED KNOWLEDGE (${ks.length}):`);
  if (!ks.length) console.log('  (none)');
  for (const k of ks) console.log(`  • [${k.id}] ${k.text}  — ${shortId(k.by)}`);
};
COMMANDS.kb = COMMANDS.knowledge;
COMMANDS.forget = (args) => {
  ensureDirs();
  const sid = sessionId(args); touch(sid);
  const id = args._[0] || args.id;
  if (!id) { console.error('✗ usage: forget <knowledgeId>'); process.exit(2); }
  const k = readKnowledge().find((x) => x.id === id || x.id.startsWith(id));
  if (!k) { console.error('✗ no such knowledge'); process.exit(1); }
  try { fs.rmSync(path.join(DIRS().knowledge, k.id + '.json'), { force: true }); } catch {}
  logEvent(sid, 'forgot', k.text, { knowledge: k.id });
  console.log(`✔ forgot [${k.id}].`);
};

// ---- notifications: new board activity relevant to me (#3) ----
COMMANDS.since = (args) => {
  ensureDirs(); reap();
  const sid = sessionId(args);
  const me = getMember(sid);
  if (!me) return; // not enrolled — stay silent (safe for hook use)
  const sinceTs = me.lastEventSeen || me.startedAt || 0;
  const props = new Map(readProposals().map((p) => [p.id, p]));
  const tasks = new Map(readTasks().map((t) => [t.id, t]));
  const relevant = [];
  for (const e of allEvents()) {
    if (e.ts <= sinceTs || e.sid === sid) continue;
    let hit = null;
    if ((e.kind === 'objected' || e.kind === 'approved') && e.proposal && props.get(e.proposal)?.by === sid) {
      hit = `${e.kind === 'objected' ? '⚠ OBJECTION' : '👍 approval'} on YOUR proposal [${e.proposal}]: ${e.msg}`;
    } else if (e.kind === 'contest-won' && e.from === sid) {
      hit = `⚠ ${shortId(e.sid)} CONTESTED a file you claimed: ${e.msg}`;
    } else if ((e.kind === 'took' || e.kind === 'took-over') && e.task && tasks.get(e.task)?.createdBy === sid) {
      hit = `${shortId(e.sid)} took your delegated task: ${e.msg}`;
    } else if (e.kind === 'decreed') {
      hit = `📐 new team convention: ${e.msg}`;
    } else if (e.kind === 'learned') {
      hit = `💡 new shared knowledge: ${e.msg}`;
    } else if (e.kind === 'unblocked') {
      hit = `▸ task unblocked: ${e.msg}`;
    } else if (e.kind === 'proposed') {
      hit = `❓ ${shortId(e.sid)} proposes (object if you see a problem): ${e.msg}`;
    } else if (e.kind === 'mission') {
      hit = `📣 MISSION from ${shortId(e.sid)}: ${e.msg} — expect an assignment`;
    } else if (e.kind === 'delegated' && e.task && tasks.get(e.task)?.to === sid) {
      const t = tasks.get(e.task);
      hit = `📌 ASSIGNED to you: "${t.title}" [${t.id}]${t.afterCommit ? ' — start after your current commit' : ''}  → take ${t.id}`;
    }
    if (hit) relevant.push(hit);
  }
  // direct messages addressed to me (or everyone)
  for (const msg of readMessages()) {
    if (msg.ts <= sinceTs || msg.from === sid) continue;
    if (msg.to === sid || msg.to === 'all') relevant.push(`💬 from ${shortId(msg.from)}: ${msg.text}`);
  }
  me.lastEventSeen = now();
  writeMember(me);
  if (!relevant.length) { if (!args.quiet) console.log('(no new board activity)'); return; }
  console.log(`📋 CLASSROOM — ${relevant.length} new update(s) since you last checked:`);
  for (const r of relevant) console.log(`  • ${r}`);
};

// ---- live dashboard (#6) ----
COMMANDS.watch = (args) => {
  ensureDirs();
  const sid = sessionId(args);
  const interval = Math.max(1, (args.interval ? parseInt(args.interval, 10) : 3)) * 1000;
  const view = () => (args.plain ? renderBoard(sid) : renderDashboard(sid));
  if (args.once) { reap(); process.stdout.write(view() + '\n'); return; }
  // alternate screen + hidden cursor = a clean full-screen TUI with no
  // scrollback pollution (fixes the "rendered twice" stacking).
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  const cleanup = () => { try { process.stdout.write('\x1b[?25h\x1b[?1049l'); } catch {} process.exit(0); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  const draw = () => { reap(); process.stdout.write('\x1b[H\x1b[2J' + view()); };
  draw();
  setInterval(draw, interval);
};

// ---- enforcement: pre-commit claim guard (#2) ----
COMMANDS['precommit-check'] = (args) => {
  ensureDirs(); reap();
  const sid = sessionId(args);
  const staged = (git(['diff', '--cached', '--name-only']) || '').split('\n').filter(Boolean).map(normPath);
  if (!staged.length) process.exit(0);
  const members = readMembers();
  const problems = [];
  for (const c of readClaims()) {
    if (c.sid === sid) continue;
    const owner = members.find((x) => x.sid === c.sid);
    if (!isLive(owner)) continue;
    for (const f of staged) if (pathsOverlap(f, c.path)) problems.push({ f, c, owner });
  }
  if (problems.length) {
    console.error('✗ CLASSROOM pre-commit BLOCK — staged files are held by another live session:');
    for (const p of problems) console.error(`   ${p.f}  ⨯ held by ${label(p.owner)} (intent: ${p.c.intent || '-'})`);
    console.error('   → coordinate first (contest / sync / wait), or bypass once with:  git commit --no-verify');
    process.exit(1);
  }
  process.exit(0);
};

// ---- hooks: auto-enroll on session start (#1) + notify each turn (#3) ----
COMMANDS['hook-session-start'] = (args) => {
  ensureDirs(); reap();
  const sid = sessionId(args);
  let m = getMember(sid);
  if (!m) {
    const r = repo();
    m = {
      sid, startedAt: now(), host: os.hostname(), name: null, expertise: [], headroom: 100,
      pid: process.pid, cwd: process.cwd(), worktree: r.topLevel || process.cwd(),
      branch: r.branch || null, status: 'active', task: '(auto-enrolled)', lastEventSeen: now(),
    };
    writeMember(m);
    logEvent(sid, 'enrolled', 'auto-enrolled via SessionStart hook');
  }
  const others = readMembers().filter((x) => isLive(x) && x.sid !== sid);
  const out = [];
  out.push('# Claude Classroom (auto-enrolled)');
  out.push(`You are one of ${others.length + 1} Claude Code session(s) on this repo. You were auto-enrolled as ${shortId(sid)}.`);
  if (others.length) {
    out.push('Other live sessions:');
    for (const o of others) out.push(`  - ${shortId(o.sid)}: ${o.task || '(no task set)'}`);
  }
  const ds = readDecisions();
  if (ds.length) { out.push('TEAM CONVENTIONS you MUST follow:'); for (const c of ds) out.push(`  - ${c.text}`); }
  const kb = readKnowledge();
  if (kb.length) { out.push('Shared knowledge (inherited):'); for (const k of kb.slice(-10)) out.push(`  - ${k.text}`); }
  out.push('Before editing files, coordinate: `node ~/.claude/skills/claude-classroom/classroom.js survey <files>` then `claim` them, commit atomically, `sync` findings. Full protocol: the claude-classroom skill.');
  out.push(`Tell the user they can watch the live dashboard with:  ${watchCmd()}`);
  console.log(out.join('\n'));
};

COMMANDS['hook-user-prompt'] = (args) => {
  const sid = sessionId(args);
  if (!getMember(sid)) return;
  COMMANDS.since({ _: [], quiet: true });
};

// already wired up in this repo? (either the pre-commit marker or the settings hook)
function isInstalled() {
  const r = repo();
  if (!r.isGit) return true;
  try { const pc = path.join(r.commonDir, 'hooks', 'pre-commit'); if (fs.existsSync(pc) && fs.readFileSync(pc, 'utf8').includes('claude-classroom')) return true; } catch {}
  try { const sf = path.join(r.topLevel, '.claude', 'settings.local.json'); if (fs.existsSync(sf) && fs.readFileSync(sf, 'utf8').includes('classroom.js')) return true; } catch {}
  return false;
}

// ---- install / uninstall the hooks (#1/#2/#3) ----
COMMANDS.install = (args) => {
  const r = repo();
  if (!r.isGit) { console.error('✗ not a git repo — classroom hooks need git.'); process.exit(2); }
  const self = __filename;
  const node = process.execPath;
  const cmd = (sub) => `${JSON.stringify(node)} ${JSON.stringify(self)} ${sub}`;
  const marker = '# >>> claude-classroom';

  // 1) git pre-commit hook
  const hooksDir = path.join(r.commonDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const pc = path.join(hooksDir, 'pre-commit');
  let pcState = 'skipped (--no-precommit)';
  if (!args['no-precommit']) {
  if (fs.existsSync(pc) && fs.readFileSync(pc, 'utf8').includes(marker)) {
    pcState = 'already present';
  } else if (fs.existsSync(pc)) {
    const bak = pc + '.pre-classroom.bak';
    fs.copyFileSync(pc, bak);
    fs.writeFileSync(pc, `#!/bin/sh\n${marker}\n${cmd('precommit-check')} || exit 1\n. ${JSON.stringify(bak)}\n`);
    pcState = 'installed (chained your existing hook)';
  } else {
    fs.writeFileSync(pc, `#!/bin/sh\n${marker}\n${cmd('precommit-check')} || exit 1\n`);
    pcState = 'installed';
  }
  try { fs.chmodSync(pc, 0o755); } catch {}
  }

  // 2) SessionStart + UserPromptSubmit hooks in repo settings.local.json
  const settingsDir = path.join(r.topLevel, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  const sf = path.join(settingsDir, 'settings.local.json');
  let settings = {};
  if (fs.existsSync(sf)) { try { settings = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch {} }
  settings.hooks = settings.hooks || {};
  const addHook = (event, sub) => {
    settings.hooks[event] = settings.hooks[event] || [];
    if (!JSON.stringify(settings.hooks[event]).includes('classroom.js')) {
      settings.hooks[event].push({ hooks: [{ type: 'command', command: cmd(sub) }] });
    }
  };
  addHook('SessionStart', 'hook-session-start');
  addHook('UserPromptSubmit', 'hook-user-prompt');
  fs.writeFileSync(sf, JSON.stringify(settings, null, 2));

  // 3) short `classroom` launcher on PATH so `classroom watch` works anywhere
  let launcher = null;
  const wrapper = `#!/bin/sh\nif [ $# -eq 0 ]; then set -- status; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(__filename)} "$@"\n`;
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const lp = path.join(dir, 'classroom');
      fs.writeFileSync(lp, wrapper);
      fs.chmodSync(lp, 0o755);
      launcher = lp;
      break;
    } catch {}
  }

  if (args.auto) {
    console.log(`✓ classroom set up for this repo — every future session auto-joins from now on${args['no-precommit'] ? '' : ' (+ pre-commit guard)'}. One-time; \`classroom uninstall\` to undo.`);
    console.log(`  👀 watch the crew live:  ${launcher ? 'classroom watch' : watchCmd()}`);
    console.log('');
    return;
  }
  console.log('✔ Claude Classroom installed in this repo:');
  console.log(`  • git pre-commit hook  → ${pc}  (${pcState})`);
  console.log(`  • SessionStart + UserPromptSubmit hooks → ${sf}`);
  if (launcher) console.log(`  • short launcher → ${launcher}`);
  console.log('Now EVERY Claude Code session opened here auto-enrolls, inherits conventions + knowledge,');
  console.log('sees new board activity each turn, and is blocked from committing files another session holds.');
  console.log('');
  console.log(`👀 Watch the whole crew live:   ${launcher ? 'classroom watch' : watchCmd()}`);
  console.log('Uninstall: classroom uninstall');
};

COMMANDS.uninstall = (args) => {
  const r = repo();
  if (!r.isGit) { console.error('✗ not a git repo.'); process.exit(2); }
  const pc = path.join(r.commonDir, 'hooks', 'pre-commit');
  if (fs.existsSync(pc) && fs.readFileSync(pc, 'utf8').includes('claude-classroom')) {
    const bak = pc + '.pre-classroom.bak';
    if (fs.existsSync(bak)) { fs.copyFileSync(bak, pc); fs.rmSync(bak); } else { fs.rmSync(pc); }
  }
  const sf = path.join(r.topLevel, '.claude', 'settings.local.json');
  if (fs.existsSync(sf)) {
    try {
      const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
      if (s.hooks) {
        for (const ev of Object.keys(s.hooks)) {
          s.hooks[ev] = s.hooks[ev].filter((h) => !JSON.stringify(h).includes('classroom.js'));
          if (!s.hooks[ev].length) delete s.hooks[ev];
        }
        if (!Object.keys(s.hooks).length) delete s.hooks;
      }
      fs.writeFileSync(sf, JSON.stringify(s, null, 2));
    } catch {}
  }
  console.log('✔ Claude Classroom hooks uninstalled (auto-enroll, notifications, pre-commit guard removed).');
};

// ---- direct inter-agent messaging ----
COMMANDS.msg = (args) => {
  ensureDirs(); reap();
  const sid = sessionId(args);
  if (!getMember(sid)) { console.error('✗ not enrolled.'); process.exit(2); }
  touch(sid);
  const toTok = args._[0] || args.to;
  const text = (args.to ? args._.join(' ') : args._.slice(1).join(' ')).trim() || args.text || '';
  if (!toTok || !text) { console.error('✗ usage: msg <@agent|sid|all> "message"'); process.exit(2); }
  const to = resolveSid(toTok);
  if (!to) { console.error(`✗ no live agent matches "${toTok}". Run \`status\` to see names.`); process.exit(1); }
  const m = { id: newId('m'), from: sid, to, text, ts: now() };
  writeMessage(m);
  logEvent(sid, 'msg', `→ ${to === 'all' ? 'everyone' : shortId(to)}: ${text}`, { to });
  console.log(`✔ message sent to ${to === 'all' ? 'everyone' : shortId(to)} — they'll see it next turn.`);
};

// ---- work-stealing: grab the best-fit unblocked task for me ----
COMMANDS.pull = (args) => {
  ensureDirs(); reap();
  const sid = sessionId(args);
  const me = getMember(sid);
  if (!me) { console.error('✗ not enrolled.'); process.exit(2); }
  touch(sid);
  const all = readTasks();
  const open = all.filter((t) => t.status === 'open' && !taskBlocked(t, all) && (!t.to || t.to === sid));
  if (!open.length) { console.log('No ready tasks to pull. The backlog is clear.'); return; }
  const best = open.map((t) => ({ t, fit: fitScore(me, t) })).sort((a, b) => b.fit - a.fit)[0];
  console.log(`work-stealing best-fit task (fit ${best.fit}):`);
  COMMANDS.take({ ...args, _: [best.t.id], fit: best.fit, rationale: 'work-steal: best-fit available task' });
};

// ---- land queue: serialize landing to main so branches don't race ----
COMMANDS.landq = (args) => {
  ensureDirs();
  const sid = sessionId(args);
  if (!getMember(sid)) { console.error('✗ not enrolled.'); process.exit(2); }
  touch(sid);
  const d = DIRS();
  const lockDir = path.join(d.root, 'land.lock');
  const sub = args._[0] || 'acquire';
  if (sub === 'release') {
    const meta = readJSON(path.join(lockDir, 'meta.json'));
    if (meta && meta.sid === sid) { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {} logEvent(sid, 'land-release', 'released the land queue'); console.log('✔ released the land lock — next session can land.'); }
    else console.log('you do not hold the land lock.');
    return;
  }
  if (sub === 'status') {
    const meta = readJSON(path.join(lockDir, 'meta.json'));
    console.log(meta ? `land lock held by ${shortId(meta.sid)} since ${rel(meta.ts)}` : 'land lock is FREE.');
    return;
  }
  // acquire (steal if stale > 10 min)
  let held = false;
  try { fs.mkdirSync(lockDir); held = true; } catch {
    const meta = readJSON(path.join(lockDir, 'meta.json'));
    if (meta && meta.sid === sid) held = true;
    else if (meta && now() - meta.ts > 10 * 60 * 1000) { try { fs.rmSync(lockDir, { recursive: true, force: true }); fs.mkdirSync(lockDir); held = true; } catch {} }
    else { console.log(`⏳ land queue BUSY — ${meta ? shortId(meta.sid) : 'someone'} is landing (since ${meta ? rel(meta.ts) : '?'}). Wait, then \`landq\` again.`); process.exit(1); }
  }
  atomicWrite(path.join(lockDir, 'meta.json'), JSON.stringify({ sid, ts: now() }, null, 2));
  logEvent(sid, 'land-acquire', 'holds the land queue');
  console.log('✔ you hold the land lock — you are clear to land. Sequence:');
  COMMANDS.land(args);
  console.log('When merged & pushed:  classroom landq release');
};

// ---- group mission: broadcast a goal for the crew to split up ----
COMMANDS.mission = (args) => {
  ensureDirs(); reap();
  const sid = sessionId(args);
  if (!getMember(sid)) { console.error('✗ not enrolled.'); process.exit(2); }
  touch(sid);
  const goal = args._.join(' ').trim() || args.goal || '';
  if (!goal) { console.error('✗ usage: mission "<what the whole crew should accomplish together>"'); process.exit(2); }
  const x = { id: newId('M'), by: sid, goal, ts: now() };
  writeMission(x);
  const team = readMembers().filter((m) => isLive(m) && m.sid !== sid);
  writeMessage({ id: newId('m'), from: sid, to: 'all', text: `📣 MISSION [${x.id}]: ${goal} — splitting into pieces now; watch for your assignment.`, ts: now() });
  logEvent(sid, 'mission', `[${x.id}] ${goal}`, { mission: x.id });
  console.log(`✔ mission [${x.id}] broadcast to ${team.length} teammate(s).`);
  console.log('NOW partition it: break the goal into pieces and assign each to the best-fit teammate, e.g.');
  for (const m of team) console.log(`    classroom delegate "<piece for ${shortId(m.sid)}>" --to ${shortId(m.sid)} --mission ${x.id} --after-commit --area "<keywords>"`);
  console.log('  Take YOUR share too — don\'t do it all. Use `suggest` to match pieces to expertise.');
};

// ---- post-session report ----
COMMANDS.report = (args) => {
  ensureDirs();
  const ev = allEvents();
  const members = readMembers();
  const nameOf = (sid) => { const m = members.find((x) => x.sid === sid); return (m && m.name) ? m.name : shortId(sid); };
  const bySid = {};
  for (const e of ev) (bySid[e.sid] = bySid[e.sid] || []).push(e);
  const L = [];
  L.push('# Claude Classroom — run report');
  L.push(`Repo: ${repo().topLevel || process.cwd()}`);
  L.push('');
  L.push('## Who did what');
  for (const sid of Object.keys(bySid)) {
    const evs = bySid[sid];
    const c = (k) => evs.filter((e) => e.kind === k).length;
    const last = evs[evs.length - 1];
    L.push(`- **${nameOf(sid)}** (${shortId(sid)}) — ${c('claimed')} claim(s), ${c('finished')} task(s) done, ${c('contest-won')} contest win(s), ${c('note')} note(s). Last: ${last.kind} "${(last.msg || '').slice(0, 60)}"`);
  }
  const ds = readDecisions(); if (ds.length) { L.push(''); L.push('## Conventions set'); for (const d of ds) L.push(`- ${d.text}`); }
  const kb = readKnowledge(); if (kb.length) { L.push(''); L.push('## Knowledge captured'); for (const k of kb) L.push(`- ${k.text}`); }
  L.push(''); L.push('## Timeline');
  const t0 = ev.length ? ev[0].ts : 0;
  for (const e of ev) L.push(`- +${((e.ts - t0) / 60000).toFixed(1)}m  ${nameOf(e.sid)}  **${e.kind}**  ${(e.msg || '').slice(0, 80)}`);
  const out = L.join('\n') + '\n';
  if (args.out) { fs.writeFileSync(args.out, out); console.log('✔ wrote ' + args.out); } else process.stdout.write(out);
};

// ---- browser dashboard export ----
COMMANDS.html = (args) => {
  ensureDirs();
  const sid = sessionId(args);
  const html = ansiToHtml(renderDashboard(sid));
  const out = args.out || path.join(os.tmpdir(), 'classroom-board.html');
  fs.writeFileSync(out, html);
  console.log(`✔ wrote ${out}  —  open it:  open "${out}"`);
};

// ---- interop: adopt every worktree so tool-spawned agents auto-enroll ----
COMMANDS.adopt = (args) => {
  const r = repo();
  if (!r.isGit) { console.error('✗ not a git repo.'); process.exit(2); }
  const wt = git(['worktree', 'list', '--porcelain']) || '';
  const paths = [];
  for (const line of wt.split('\n')) if (line.startsWith('worktree ')) paths.push(line.slice('worktree '.length).trim());
  if (!paths.length) paths.push(r.topLevel);
  let n = 0;
  for (const p of paths) {
    const sf = path.join(p, '.claude', 'settings.local.json');
    try {
      fs.mkdirSync(path.dirname(sf), { recursive: true });
      let s = {};
      if (fs.existsSync(sf)) { try { s = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch {} }
      s.hooks = s.hooks || {};
      const add = (ev, sub) => { s.hooks[ev] = s.hooks[ev] || []; if (!JSON.stringify(s.hooks[ev]).includes('classroom.js')) s.hooks[ev].push({ hooks: [{ type: 'command', command: hookCmd(sub) }] }); };
      add('SessionStart', 'hook-session-start');
      add('UserPromptSubmit', 'hook-user-prompt');
      fs.writeFileSync(sf, JSON.stringify(s, null, 2));
      n++;
    } catch {}
  }
  console.log(`✔ adopted ${n} worktree(s) — any session opened in them auto-enrolls.`);
  console.log('  Covers agents spawned by Claude Squad / Crystal / Conductor (they create worktrees off this repo).');
};

// ---- cross-machine board over a shared git branch ----
const MESH_BRANCH = 'claude-classroom-board';
const MESH_DIRS = ['members', 'claims', 'tasks', 'proposals', 'decisions', 'knowledge', 'messages', 'missions'];
function tsOf(file) { try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); return o.lastSeen || o.updatedAt || o.ts || o.createdAt || 0; } catch { return 0; } }
function copyNewer(src, dst) {
  try {
    if (!fs.existsSync(dst)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); return true; }
    if (tsOf(src) > tsOf(dst)) { fs.copyFileSync(src, dst); return true; }
  } catch {}
  return false;
}
function listBoardFiles(root) {
  const out = [];
  const walk = (rel) => {
    let entries; try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel + '/' + e.name;
      if (e.isDirectory()) walk(r);          // claims are nested: claims/<hash>/meta.json
      else if (e.name.endsWith('.json')) out.push(r);
    }
  };
  for (const dir of MESH_DIRS) walk(dir);
  return out;
}
// Sync the board across machines via an isolated helper repo pushed to a shared
// git branch. Two-way newer-wins union of the file-per-record dirs.
function meshSync() {
  const r = repo();
  const url = r.isGit ? git(['remote', 'get-url', 'origin']) : null;
  if (!url) return { ok: false, why: 'no git remote (origin)' };
  const board = DIRS().root;
  const mr = path.join(board, '.mesh-repo');
  if (!fs.existsSync(path.join(mr, '.git'))) {
    fs.mkdirSync(mr, { recursive: true });
    git(['init', '-q'], { cwd: mr });
    git(['config', 'user.email', 'classroom@local'], { cwd: mr });
    git(['config', 'user.name', 'classroom'], { cwd: mr });
  }
  git(['remote', 'remove', 'origin'], { cwd: mr, stdio: ['ignore', 'ignore', 'ignore'] });
  git(['remote', 'add', 'origin', url], { cwd: mr });
  const onRemote = git(['ls-remote', '--heads', 'origin', MESH_BRANCH], { cwd: mr });
  let pulled = 0;
  if (onRemote) {
    if (git(['fetch', '-q', 'origin', MESH_BRANCH], { cwd: mr }) === null) return { ok: false, why: 'fetch failed' };
    git(['checkout', '-q', '-B', MESH_BRANCH, 'FETCH_HEAD'], { cwd: mr });
    for (const rel of listBoardFiles(mr)) if (copyNewer(path.join(mr, rel), path.join(board, rel))) pulled++;
  } else {
    git(['checkout', '-q', '-B', MESH_BRANCH], { cwd: mr });
  }
  for (const rel of listBoardFiles(board)) copyNewer(path.join(board, rel), path.join(mr, rel));
  git(['add', '-A'], { cwd: mr });
  git(['commit', '-q', '-m', 'classroom board sync', '--allow-empty'], { cwd: mr });
  // git() returns '' on success / null on error; don't ignore stdout (that returns null even on success).
  let res = git(['push', '-q', 'origin', `${MESH_BRANCH}:${MESH_BRANCH}`], { cwd: mr });
  if (res === null && onRemote) { // likely non-ff: re-merge once and retry
    git(['fetch', '-q', 'origin', MESH_BRANCH], { cwd: mr });
    git(['merge', '-q', '-X', 'theirs', 'FETCH_HEAD'], { cwd: mr, stdio: ['ignore', 'ignore', 'ignore'] });
    for (const rel of listBoardFiles(mr)) if (copyNewer(path.join(mr, rel), path.join(board, rel))) pulled++;
    res = git(['push', '-q', 'origin', `${MESH_BRANCH}:${MESH_BRANCH}`], { cwd: mr });
  }
  return { ok: true, pulled, pushed: res !== null };
}
COMMANDS.mesh = (args) => {
  ensureDirs();
  const sid = sessionId(args); touch(sid);
  const d = DIRS();
  const flag = path.join(d.root, 'mesh.enabled');
  const sub = args._[0];
  if (sub === 'on') { fs.writeFileSync(flag, '1'); console.log('✔ mesh ON — board will sync to the shared git branch on enroll/heartbeat.'); return; }
  if (sub === 'off') { try { fs.rmSync(flag, { force: true }); } catch {} console.log('✔ mesh OFF.'); return; }
  const res = meshSync(true);
  if (!res.ok) { console.error('✗ mesh: ' + res.why); process.exit(1); }
  console.log(`✔ mesh synced — pulled ${res.pulled} remote record(s), push ${res.pushed ? 'OK' : 'FAILED (retry / check remote)'}.`);
};
function meshAuto() {
  try {
    const d = DIRS();
    if (fs.existsSync(path.join(d.root, 'mesh.enabled'))) meshSync(false);
  } catch {}
}

// ---- codebase ownership / domain operators ----
COMMANDS.own = (args) => {
  ensureDirs();
  const sid = sessionId(args);
  const m = getMember(sid);
  if (!m) { console.error('✗ not enrolled. Run `enroll` first.'); process.exit(2); }
  touch(sid);
  const list = args._.flatMap((z) => parseList(z));
  if (!list.length) { console.log(`you operate: ${(m.owns || []).join(', ') || '(nothing declared)'}`); return; }
  m.owns = Array.from(new Set([...(m.owns || []), ...list]));
  writeMember(m);
  logEvent(sid, 'owns', `operator of: ${list.join(', ')}`);
  console.log(`✔ you're now the operator/expert for: ${m.owns.join(', ')}`);
  console.log('  Teammates route questions & area-tasks here. (`disown <area>` to drop one.)');
};
COMMANDS.disown = (args) => {
  ensureDirs(); const sid = sessionId(args); const m = getMember(sid);
  if (!m) { console.error('✗ not enrolled.'); process.exit(2); } touch(sid);
  const list = args._.flatMap((z) => parseList(z)).map((s) => s.toLowerCase());
  m.owns = (m.owns || []).filter((z) => !list.includes(z.toLowerCase()));
  writeMember(m);
  console.log(`✔ now operating: ${(m.owns || []).join(', ') || '(nothing)'}`);
};
COMMANDS.owners = (args) => {
  ensureDirs(); reap();
  const members = readMembers().filter(isLive);
  console.log('CODEBASE OPERATORS — who knows/owns what:');
  let any = false;
  for (const m of members) if ((m.owns || []).length) { any = true; console.log(`  ${label(m)}  →  ${m.owns.join(', ')}`); }
  if (!any) console.log('  (nobody has declared ownership yet — use `own "<area or path>"`)');
};
COMMANDS.whoknows = (args) => {
  ensureDirs(); reap();
  const target = args._.join(' ').trim();
  if (!target) { console.error('✗ usage: whoknows <area-or-path>'); process.exit(2); }
  const members = readMembers().filter(isLive);
  const ranked = members.map((m) => ({ m, own: ownerMatch(m, target), fit: fitScore(m, { title: target, area: target }) }))
    .filter((x) => x.own > 0 || x.fit > 15).sort((a, b) => b.own - a.own || b.fit - a.fit);
  if (!ranked.length) { console.log(`No clear operator for "${target}". Ask everyone:  classroom msg all "..."`); return; }
  console.log(`Best for "${target}":`);
  for (const x of ranked.slice(0, 3)) console.log(`  ${label(x.m)}  ${x.own ? `— OWNS it (match ${x.own})` : `— expertise fit ${x.fit}`}`);
  console.log(`  → ask:  classroom ask "${target}" "your question"   ·   delegate:  classroom delegate "<task>" --to ${shortId(ranked[0].m.sid)} --area "${target}"`);
};
COMMANDS.ask = (args) => {
  ensureDirs(); reap();
  const sid = sessionId(args);
  if (!getMember(sid)) { console.error('✗ not enrolled.'); process.exit(2); }
  touch(sid);
  const target = args._[0];
  const q = args._.slice(1).join(' ').trim() || args.q || '';
  if (!target || !q) { console.error('✗ usage: ask "<area-or-path>" "<question>"'); process.exit(2); }
  const members = readMembers().filter((m) => isLive(m) && m.sid !== sid);
  const ranked = members.map((m) => ({ m, own: ownerMatch(m, target), fit: fitScore(m, { title: target, area: target }) }))
    .sort((a, b) => b.own - a.own || b.fit - a.fit);
  const best = ranked[0];
  if (!best || (best.own === 0 && best.fit <= 15)) {
    writeMessage({ id: newId('m'), from: sid, to: 'all', text: `❓ [${target}] ${q}`, ts: now() });
    logEvent(sid, 'ask', `(no owner) ${target}: ${q}`);
    console.log(`No clear operator for "${target}" — asked the whole team. Replies via: msg ${shortId(sid)} "…".`);
    return;
  }
  writeMessage({ id: newId('m'), from: sid, to: best.m.sid, text: `❓ about ${target}: ${q}`, ts: now() });
  logEvent(sid, 'ask', `→ ${shortId(best.m.sid)} about ${target}`, { to: best.m.sid });
  console.log(`✔ asked ${label(best.m)} (${best.own ? 'operator of ' + target : 'best fit'}) — they answer next turn with  msg ${shortId(sid)} "…".`);
};

COMMANDS.heartbeat = (args) => {
  const sid = sessionId(args);
  touch(sid);
  meshAuto();
  console.log('✔ heartbeat');
};

COMMANDS.status = (args) => {
  ensureDirs();
  reap();
  const sid = sessionId(args);
  if (args.json) {
    const members = readMembers().filter(isLive);
    const claims = readClaims().filter((c) => members.some((m) => m.sid === c.sid));
    console.log(JSON.stringify({ me: sid, members, claims, events: recentEvents(20) }, null, 2));
    return;
  }
  console.log(renderBoard(sid));
};
COMMANDS.board = COMMANDS.status;

COMMANDS.split = (args) => {
  ensureDirs();
  const r = repo();
  if (!r.isGit) {
    console.error('✗ not a git repo — cannot create a worktree.');
    process.exit(2);
  }
  const sid = sessionId(args);
  touch(sid);
  const branch = args._[0] || args.branch;
  if (!branch) {
    console.error('✗ usage: split <branch-name> [--task "..."] [--base <ref>]');
    process.exit(2);
  }
  const base = args.base || 'HEAD';
  const repoBase = path.basename(r.topLevel);
  const branchSafe = branch.replace(/[^A-Za-z0-9._-]/g, '-');
  const wtRoot = path.join(path.dirname(r.topLevel), repoBase + '.worktrees');
  const wtPath = path.join(wtRoot, branchSafe);
  fs.mkdirSync(wtRoot, { recursive: true });
  // branch may already exist
  const branchExists = git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]) !== null;
  let res;
  if (branchExists) {
    res = git(['worktree', 'add', wtPath, branch], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    res = git(['worktree', 'add', '-b', branch, wtPath, base], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  if (git(['rev-parse', '--is-inside-work-tree'], { cwd: wtPath }) !== 'true') {
    console.error('✗ failed to create worktree. Does it already exist? Try: git worktree list');
    process.exit(1);
  }
  logEvent(sid, 'split', `worktree ${branchSafe} on branch ${branch}`, { worktree: wtPath, branch });
  console.log(`✔ created worktree:`);
  console.log(`    path:   ${wtPath}`);
  console.log(`    branch: ${branch} (base ${base})`);

  // Make the worktree immediately buildable for JS/TS projects.
  let linked = [];
  if (!args['no-link'] && fs.existsSync(path.join(r.topLevel, 'node_modules'))) {
    linked = linkNodeModules(r.topLevel, wtPath);
    if (linked.length) {
      console.log(`    deps:   linked ${linked.length} node_modules dir(s) from the source checkout (worktree is ready to build/test)`);
    }
  }
  console.log('');
  console.log('NEXT — move your work into the worktree:');
  console.log(`  cd "${wtPath}"`);
  console.log('  node ~/.claude/skills/claude-classroom/classroom.js enroll   # re-enroll so the board shows your new branch');
  console.log('  …then claim files there and work. Your cwd persists across commands.');
  console.log('When done: commit atomically, then integrate (see `land`).');
};

COMMANDS.land = (args) => {
  const r = repo();
  if (!r.isGit) { console.error('✗ not a git repo.'); process.exit(2); }
  const sid = sessionId(args);
  touch(sid);
  const target = args.target || (git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']) ? 'main' : 'master');
  const branch = r.branch;
  const hasRemote = !!git(['remote']);
  const ahead = git(['rev-list', '--count', `${target}..HEAD`]) || '?';
  const behind = git(['rev-list', '--count', `HEAD..${target}`]) || '?';
  const dirty = git(['status', '--porcelain']);
  console.log('LANDING CHECKLIST');
  console.log(`  branch:        ${branch}`);
  console.log(`  target:        ${target}`);
  console.log(`  ahead/behind:  +${ahead} / -${behind} vs ${target}`);
  console.log(`  working tree:  ${dirty ? 'DIRTY — commit or stash first' : 'clean'}`);
  console.log(`  remote:        ${hasRemote ? 'yes' : 'none (local only)'}`);
  console.log('');
  console.log('RECOMMENDED SEQUENCE (run with judgment, verify tests/build pass):');
  const steps = [];
  if (dirty) steps.push('commit your atomic change(s) first');
  if (hasRemote) steps.push('git fetch origin');
  steps.push(`git rebase ${hasRemote ? 'origin/' + target : target}     # replay your commits on latest ${target}`);
  steps.push('run the project build/tests');
  steps.push(`switch to the ${target} checkout and:  git merge --ff-only ${branch}`);
  if (hasRemote) steps.push(`git push origin ${target}`);
  steps.push('classroom release   &&   classroom done');
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log('');
  console.log('Direct-to-main is OK only for a small, atomic, conflict-free change after rebase.');
  console.log('Otherwise open a PR for review.');
};

COMMANDS.done = (args) => {
  ensureDirs();
  const sid = sessionId(args);
  const all = readClaims().filter((c) => c.sid === sid);
  for (const c of all) releaseClaimDir(c.key);
  const m = getMember(sid);
  if (m) {
    m.status = 'left';
    m.lastSeen = now();
    writeMember(m);
  }
  logEvent(sid, 'left', 'released ' + all.length + ' claim(s) and departed');
  console.log(`✔ left the classroom. Released ${all.length} claim(s).`);
};
COMMANDS.leave = COMMANDS.done;

COMMANDS.peers = (args) => {
  ensureDirs();
  reap();
  const sid = sessionId(args);
  const withinMin = args.within ? Math.max(1, parseInt(args.within, 10) || 10) : 10;
  const { coordinated, uncoordinated } = peerReport(sid, withinMin);
  console.log(`PEER SCAN — Claude Code sessions active in this repo (last ${withinMin}m):`);
  console.log(`  coordinated (enrolled in this classroom): ${coordinated.length}`);
  for (const p of coordinated) console.log(`    ✔ ${shortId(p.sid)}  seen ${rel(p.mtimeMs)}`);
  console.log(`  UNCOORDINATED (NOT enrolled — won't see your claims): ${uncoordinated.length}`);
  for (const p of uncoordinated) console.log(`    ⚠ ${shortId(p.sid)}  seen ${rel(p.mtimeMs)}`);
  if (uncoordinated.length) {
    console.log('  → Stay defensive: atomic surgical edits, never `git add -A`, re-read each file right before editing,');
    console.log('    prefer your own worktree. Ask them to run /claude-classroom so coordination is mutual.');
  } else if (!coordinated.length) {
    console.log('  (no other live Claude Code sessions detected in this repo)');
  }
};

COMMANDS.reap = () => {
  const n = reap();
  console.log(`✔ reaped ${n} stale member/claim record(s).`);
};

COMMANDS.whoami = (args) => {
  const sid = sessionId(args);
  console.log(JSON.stringify({ sid, short: shortId(sid), coordDir: coordDir(), ...repo() }, null, 2));
};

COMMANDS.doctor = (args) => {
  const r = repo();
  console.log('claude-classroom doctor');
  console.log('  version:        ' + VERSION);
  console.log('  node:           ' + process.version);
  console.log('  cwd:            ' + process.cwd());
  console.log('  is git:         ' + r.isGit);
  console.log('  top level:      ' + (r.topLevel || '-'));
  console.log('  branch:         ' + (r.branch || '-'));
  console.log('  common dir:     ' + (r.commonDir || '-'));
  console.log('  coord dir:      ' + coordDir());
  console.log('  session id:     ' + sessionId(args));
  console.log('  env SID set:    ' + !!process.env.CLAUDE_CODE_SESSION_ID);
  try { ensureDirs(); console.log('  coord writable: yes'); }
  catch (e) { console.log('  coord writable: NO — ' + e.message); }
};

// Compact one-line classroom summary for the Claude Code status line. Reads
// only (never creates the board) so repos that never opted in show nothing.
COMMANDS.statusline = () => {
  let cwd = process.cwd();
  try {
    const input = fs.readFileSync(0, 'utf8');
    if (input) {
      const j = JSON.parse(input);
      cwd = (j.workspace && (j.workspace.current_dir || j.workspace.project_dir)) || j.cwd || cwd;
    }
  } catch {}
  try { process.chdir(cwd); } catch {}
  _repo = null;
  const r = repo();
  const base = r.isGit ? `${path.basename(r.topLevel)}${r.branch ? ' (' + r.branch + ')' : ''}` : path.basename(cwd);
  if (!r.isGit || !fs.existsSync(coordDir())) { process.stdout.write(base); return; }
  let members = [], claims = 0, tasks = 0, props = 0, convs = 0;
  try { members = readMembers().filter(isLive); } catch {}
  try { const live = new Set(members.map((x) => x.sid)); claims = readClaims().filter((c) => live.has(c.sid)).length; } catch {}
  try { const all = readTasks(); tasks = all.filter((t) => t.status === 'open' && !taskBlocked(t, all)).length; } catch {}
  try { props = readProposals().filter((p) => p.status === 'open' || p.status === 'objected').length; } catch {}
  try { convs = readDecisions().length; } catch {}
  const parts = [`🎓 ${members.length}👥`];
  if (claims) parts.push(`${claims}🔒`);
  if (tasks) parts.push(`${tasks}📋`);
  if (props) parts.push(`${props}❓`);
  if (convs) parts.push(`${convs}📐`);
  process.stdout.write(`${base}  ${parts.join(' ')}`);
};

COMMANDS.help = () => {
  console.log(`claude-classroom v${VERSION} — coordinate multiple Claude Code sessions on one repo

USAGE: node classroom.js <command> [args]   (sid comes from $CLAUDE_CODE_SESSION_ID)

  enroll  [--task ..] [--name ..] [--expertise a,b] [--owns area,path] [--headroom 0-100]  join
  profile [--expertise a,b] [--owns area,path] [--headroom 0-100] [--note ..]   declare fit/budget
  own "<area/path>..." | disown | owners   declare/list who operates which part of the codebase
  whoknows <area>  ·  ask "<area>" "<q>"   find the operator of an area · ask them a question
  survey  [<path>...]                     show board + git state; pre-check path conflicts
  claim   <path>... --intent ".." [--confidence 0-100] [--rationale ".."]  lock files (refuses overlap)
  contest <path>... --confidence 0-100 --rationale ".."   challenge a claim; higher confidence wins
  release [<path>...]                     release some/all of your claims
  delegate "<task>" [--reason ..] [--area ..] [--effort ..] [--to <sid>] [--blocked-by <id>]   post work
  offers | inbox                          list open delegated tasks (ready vs blocked)
  suggest [--all]                         recommend who's best equipped for each ready task (fit matrix)
  take <id> [--fit 0-100] [--rationale ..]   take a task; higher fit can take over a taken one
  finish <id> | drop <id>                 complete / cancel-or-return a delegated task
  decree  "<convention>" [--scope ..]     set a team norm ALL sessions must follow
  conventions                             list active team conventions   (revoke <id> to remove)
  propose "<intent>" [--files a,b]        announce "about to commit X; objections?"
  proposals                               list open proposals
  object <id> --reason ".." | approve <id>   weigh in on a proposal (from your context)
  proposal <id>                           check a proposal's status before you commit
  withdraw <id> [--committed]             close your proposal
  mission "<goal>"                        broadcast a group goal; then partition it across teammates
  msg     <@agent|all> "<text>"           direct message another session (seen next turn)
  pull                                    work-steal: take the best-fit unblocked task for you
  landq [release|status]                  serialize landing to main (one session lands at a time)
  sync    "<note>"                        post a standup note / finding to the shared feed
  split   <branch> [--base <ref>] [--no-link]   isolated worktree+branch (auto-links node_modules)
  land    [--target main]                 print the integrate-to-main checklist + ahead/behind
  learn "<fact>" | knowledge | forget <id>   shared knowledge base every new session inherits
  since                                   show new board activity relevant to you (used by the turn hook)
  peers   [--within <min>]                detect Claude sessions in this repo NOT using the classroom
  install [--no-precommit] | uninstall    hooks: auto-enroll every session (+ pre-commit claim guard)
  adopt                                   install auto-enroll hooks into ALL worktrees (Squad/Crystal/Conductor)
  mesh [on|off]                           sync the board across machines via a shared git branch
  report [--out f]  ·  html [--out f]     run report (who did what) · browser dashboard export
  watch   [--interval <s>] [--once] [--plain]   live agent dashboard (--plain = raw board)
  statusline                              compact one-liner for the Claude Code status line
  status | board   [--json]               show the board
  heartbeat                               refresh your liveness
  done | leave                            release claims and depart
  reap                                    drop stale sessions/claims/tasks
  whoami | doctor                         diagnostics

Shared state: <git-common-dir>/claude-classroom  (shared across all worktrees, never committed).`);
};

// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const fn = COMMANDS[args.cmd] || COMMANDS.help;
  try {
    fn(args);
  } catch (e) {
    console.error('✗ classroom error: ' + (e && e.message ? e.message : e));
    process.exit(1);
  }
}
main();
