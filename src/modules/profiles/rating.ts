/**
 * Per-sport profile configs + onboarding scoring, ported from rating.go.
 *
 * One module, many sports: each sport is just a `*.profile.json` file dropped
 * into ./definitions. `loadRegistry()` reads them all once at startup and keys
 * them by `profile.sport`; look one up at request time based on the sport the
 * user chose.
 */

import fs from 'fs';
import path from 'path';

/* ---------- Types mirroring the profile JSON ---------- */

export interface Constants {
  BASE: number;
  FLOOR: number;
  CAP: number;
}

export interface Option {
  value: string;
  points?: number; // for anchor / additive
  factor?: number; // for rustMultiplier
  label?: string;
  /** Russian translation of `label`. Falls back to `label` when absent. */
  labelRu?: string;
}

export type QuestionRole =
  | 'anchor'
  | 'additive'
  | 'rustMultiplier'
  | 'attributeWeighting';

export interface Question {
  id: string;
  role: QuestionRole;
  /** Human prompt for the frontend (not used by scoring). */
  prompt?: string;
  /** Russian translation of `prompt`. Falls back to `prompt` when absent. */
  promptRu?: string;
  appliesBeforeRust?: boolean;
  affectsRating?: boolean;
  options: Option[];
}

export interface Onboarding {
  constants: Constants;
  questions: Question[];
}

export interface Tier {
  name: string;
  min: number | null; // null = open bottom (Iron)
  max: number | null; // null = open top (Challenger)
  divisions: number;
  openLeaderboard?: boolean;
}

export interface Profile {
  schemaVersion: string;
  sport: string;
  displayName: string;
  /** Russian translation of `displayName`. Falls back to `displayName` when absent. */
  displayNameRu?: string;
  archetype: string; // team | solo_1v1 | combat_weightclass | timed
  onboarding: Onboarding;
  tiers: Tier[];
  divisionLabels: string[];
  lpScale: number;
}

/** questionId -> chosen option value, e.g. { level: "amateur", recency: "now" }. */
export type Answers = Record<string, string>;

/** Result of onboarding: a starting Elo and where it lands. */
export interface Placement {
  elo: number;
  tier: string;
  division: string; // "" for the open apex tier
  lp: number;
}

export type Registry = Record<string, Profile>;

/* ---------- Loading: one loader, every sport ---------- */

function findOption(q: Question, value: string): Option | undefined {
  return q.options.find((o) => o.value === value);
}

/** Read a single profile file. */
export function loadProfile(file: string): Profile {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw) as Profile;
  } catch (err) {
    throw new Error(`parse ${file}: ${(err as Error).message}`);
  }
}

/**
 * Load every *.profile.json in a directory, keyed by profile.sport.
 * Called once at startup, then looked up by sport at request time.
 */
export function loadDir(dir: string): Registry {
  const reg: Registry = {};
  if (!fs.existsSync(dir)) return reg;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.profile.json')) continue;
    const p = loadProfile(path.join(dir, name));
    reg[p.sport] = p;
  }
  return reg;
}

// Load the shipped definitions once, lazily, so importing this module never
// throws and tests can run without touching the filesystem early.
let cached: Registry | null = null;
export function registry(): Registry {
  if (cached === null) {
    cached = loadDir(path.join(__dirname, 'definitions'));
  }
  return cached;
}

export function getProfile(sport: string): Profile | undefined {
  return registry()[sport];
}

/* ---------- Scoring ---------- */

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Run the onboarding pipeline:
 *
 *   core = (anchor + beforeRustAdditives - BASE) * rust
 *   raw  = BASE + core + afterRustAdditives
 *   elo  = clamp(raw, FLOOR, CAP)
 *
 * Role-driven, so it works for any sport whose questions use these roles.
 * Throws on an unknown option value (invalid answer).
 */
export function score(p: Profile, ans: Answers): Placement {
  const c = p.onboarding.constants;
  let anchor = c.BASE;
  let beforeRust = 0;
  let afterRust = 0;
  let rust = 1;

  for (const q of p.onboarding.questions) {
    const val = ans[q.id];
    if (val === undefined) continue; // skipped question

    const opt = findOption(q, val);
    if (!opt) {
      throw new Error(`question "${q.id}": unknown option "${val}"`);
    }

    switch (q.role) {
      case 'anchor':
        anchor = opt.points ?? 0;
        break;
      case 'additive':
        if (q.appliesBeforeRust) beforeRust += opt.points ?? 0;
        else afterRust += opt.points ?? 0;
        break;
      case 'rustMultiplier':
        rust = opt.factor ?? 1;
        break;
      case 'attributeWeighting':
        // no effect on rating; capture position elsewhere if needed
        break;
    }
  }

  const core = (anchor + beforeRust - c.BASE) * rust;
  const raw = c.BASE + core + afterRust;
  const elo = clamp(raw, c.FLOOR, c.CAP);
  return place(p, elo);
}

/** Map any Elo to tier + division + LP. Reused after games, not just onboarding. */
export function place(p: Profile, elo: number): Placement {
  for (const t of p.tiers) {
    const min = t.min ?? -Infinity;
    const max = t.max ?? Infinity;
    if (elo < min || elo >= max) continue;

    if (t.divisions <= 0) {
      // open apex: ranked by raw Elo on a leaderboard
      return { elo, tier: t.name, division: '', lp: 0 };
    }

    const width = (max - min) / t.divisions;
    let d = Math.floor((elo - min) / width);
    if (d >= t.divisions) d = t.divisions - 1;
    const lp = Math.floor((((elo - min) - d * width) / width) * p.lpScale);
    return { elo, tier: t.name, division: p.divisionLabels[d], lp };
  }
  return { elo, tier: '', division: '', lp: 0 }; // outside all tiers
}
