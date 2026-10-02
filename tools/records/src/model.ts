/**
 * The shape of ExpenseWise's records: requirements and how they trace to features,
 * decisions, code and checks, plus the backlog. The records are the source of truth for
 * what is required; the code is the source of truth for what exists. `integrity.ts` checks
 * that the two agree, and the pages in `render/` are views of these records.
 */

/** MoSCoW. It ranks requirements; the backlog's P1–P3 ranks work, on purpose a different scale. */
export type Priority = 'Must' | 'Should' | 'Could' | "Won't";

/** Roadmap phases (docs/07-roadmap.md). P0 is Foundations. */
export type Phase = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

/**
 * Verified: built, and an automated check fails if it breaks. Implemented: built, and
 * nothing automated proves it. Partial: built with a known shortfall, named by a gap or a
 * backlog item. Planned: agreed, not built. Deferred: set aside by decision.
 */
export type Status = 'Verified' | 'Implemented' | 'Partial' | 'Planned' | 'Deferred';

/** A feature can also be built and waiting in an open pull request. */
export type FeatureStatus = Status | 'In review';

export type Persona = 'Alex' | 'Jordan' | 'Sam' | 'Riley';

export type Severity = 'High' | 'Medium' | 'Low';

export interface Objective {
  /** BO-n */
  readonly id: string;
  readonly title: string;
  /** How we would know it is met. */
  readonly measure: string;
  readonly sources: readonly string[];
  readonly personas: readonly Persona[];
  /** Requirement areas that serve it. */
  readonly areas: readonly string[];
}

export interface Area {
  /** CAP, SEC, … */
  readonly code: string;
  readonly kind: 'FR' | 'NFR';
  readonly name: string;
  readonly blurb: string;
}

/**
 * Where a requirement comes from. A string of one of these forms, each checked:
 * `ADR-0017` (the file exists), `D-15` (in the decision register), or a doc key and a
 * section that appears in that doc, such as `journeys §4.6`, `arch AP5`, `design DP3`,
 * `vision C5`, `risks R4`, `roadmap inc 1`, `delivery §7.5`, `capmap P1`. A requirement
 * that comes straight from the product owner cites `owner 2026-10-02`, the day it was given.
 */
export type SourceRef = string;

/**
 * An automated check. `db/tenancy` names a test file (see `checks.ts` for the aliases),
 * `db/tenancy › sees only its own organization` names one test in it, and `ci:security`
 * names a CI job. Every one must resolve, and the named test must exist.
 */
export type CheckRef = string;

export interface Requirement {
  /** FR-AREA-nn or NFR-AREA-nn. Numbers are permanent; a dropped requirement is retired. */
  readonly id: string;
  /** What must be true, in one or two sentences. */
  readonly text: string;
  readonly sources: readonly SourceRef[];
  readonly priority: Priority;
  readonly phase: Phase;
  readonly status: Status;
  /** Capability-map cells it delivers, as `Area · Capability`. Functional requirements only. */
  readonly capabilities?: readonly string[];
  readonly features?: readonly string[];
  readonly checks?: readonly CheckRef[];
  /** Non-functional requirements: the mechanism that enforces it. */
  readonly enforcedBy?: string;
  /** Open gaps (GAP-nn) or backlog items (#n) that make it Partial. */
  readonly shortfalls?: readonly string[];
  /** Backlog items that will deliver it, while Planned. */
  readonly backlog?: readonly number[];
  readonly note?: string;
}

export type FeatureGroup =
  | 'Access and organizations'
  | 'Receipts'
  | 'Expenses, trips and reports'
  | 'Domain rules'
  | 'Platform and operations';

export interface Feature {
  /** F-nn */
  readonly id: string;
  readonly title: string;
  readonly group: FeatureGroup;
  /** product: a person uses it. foundation: rules or plumbing a product feature will use. */
  readonly kind: 'product' | 'foundation' | 'operations';
  readonly phase: Phase;
  readonly status: FeatureStatus;
  /** The pull request that shipped it. */
  readonly delivered?: string;
  /** The open pull request, while In review. */
  readonly review?: number;
  readonly decisions?: readonly string[];
  /** Repository paths that build it. Each must exist. */
  readonly code?: readonly string[];
  /** API operations it serves, as `GET /v1/receipts`. Every operation in openapi.json is claimed once. */
  readonly api?: readonly string[];
  /** Web routes it serves, as `/receipts/[id]`. Every page in apps/web is claimed once. */
  readonly screens?: readonly string[];
  /** Workflow function ids. Every function is claimed once. */
  readonly workflows?: readonly string[];
  /** Feature flags. Every flag in the registry is claimed once. */
  readonly flags?: readonly string[];
  readonly checks?: readonly CheckRef[];
  readonly shortfalls?: readonly string[];
  /** The backlog item that builds it, while Planned. */
  readonly backlog?: number;
  readonly note?: string;
}

export interface Gap {
  /** GAP-nn. Not Gn: G1–G6 are the quality gates. */
  readonly id: string;
  readonly title: string;
  readonly affects: readonly string[];
  readonly severity: Severity;
  readonly evidence: string;
  readonly fix: string;
  /** The backlog item that closes it. Open gap, open item; closed gap, done item. */
  readonly backlog: number;
  readonly closed?: { readonly date: string; readonly note: string };
}

export interface Question {
  /** Qn */
  readonly id: string;
  readonly title: string;
  readonly ask: string;
  readonly why: string;
  readonly recommendation?: string;
  readonly affects: readonly string[];
  readonly answer?: { readonly date: string; readonly text: string };
}

export interface ChangeLogEntry {
  /** YYYY-MM-DD. Newest first. */
  readonly date: string;
  readonly change: string;
  readonly by: string;
}

export type BacklogType =
  'Feature' | 'Gap' | 'Security' | 'Ops' | 'Decision' | 'Verify' | 'Tech debt';

/** What an item waits on. `none` means Claude can start it now. */
export type Blocker =
  | { readonly kind: 'none'; readonly note?: string }
  | { readonly kind: 'owner'; readonly ask: string }
  | { readonly kind: 'items'; readonly items: readonly number[]; readonly then?: string };

export interface BacklogItem {
  /** Permanent. A closed item keeps its number in Done. */
  readonly num: number;
  readonly title: string;
  readonly type: BacklogType;
  readonly detail: string;
  /** P1 next · P2 this month · P3 this quarter. */
  readonly priority: 'P1' | 'P2' | 'P3';
  /** S hours · M about a day · L days. */
  readonly effort: 'S' | 'M' | 'L';
  /** What it costs to leave it. */
  readonly severity: Severity;
  readonly blocker: Blocker;
  readonly source?: string;
  /** Requirements, features and gaps it moves. */
  readonly affects?: readonly string[];
  readonly done?: { readonly date: string; readonly in: string };
}
