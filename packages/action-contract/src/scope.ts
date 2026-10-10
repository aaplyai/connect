/**
 * The small vocabulary both sides of the action boundary share: the tenant
 * scope, who can act, and the words an action is described in.
 */

/** Tenant isolation boundary. Every key, query and call is scoped by it. */
export interface Scope {
  tenantId: string;
  appId: string;
  environmentId: string;
}

/** The kinds of actor an identity can be. `system` is the engine itself (timers, retries). */
export type ActorKind = "visitor" | "member" | "staff" | "workload" | "system";

/** The review a flow puts in front of an action: none, the person confirms, or someone else approves. */
export type Risk = "none" | "confirm" | "approval";

/** Why an action is sent: the step's own call, the undo of a write, or a read that settles an unknown write. */
export type ActionPurpose = "run" | "compensate" | "reconcile";

/** Whether an action only reads or may change something. */
export type ActionEffectKind = "read" | "write";

/** Whose account an action uses: the business's own, or the run's person's. */
export type ActingFor = "business" | "endUser";

/**
 * The kind of environment a call runs in. Production calls touch real
 * accounts; preview calls are a person trying a draft; test calls are
 * automated (CI, evaluations). A connection may declare the kind it serves,
 * and a performer refuses a call of another kind (see `environment.ts`).
 */
export type EnvironmentKind = "preview" | "production" | "test";

const RISK_RANK: Readonly<Record<Risk, number>> = { none: 0, confirm: 1, approval: 2 };

/** True for one of the three risk levels. */
export function isRisk(value: unknown): value is Risk {
  return value === "none" || value === "confirm" || value === "approval";
}

/** Whether `risk` is at least `floor` (`none` < `confirm` < `approval`). */
export function riskAtLeast(risk: Risk, floor: Risk): boolean {
  return RISK_RANK[risk] >= RISK_RANK[floor];
}
