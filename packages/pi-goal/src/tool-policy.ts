import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const GOAL_COMPLETE_TOOL = "goal_complete";
export const GOAL_BLOCKED_TOOL = "goal_blocked";
export const GOAL_WAIT_TOOL = "goal_wait";
export const GOAL_TOOL_NAMES = [GOAL_COMPLETE_TOOL, GOAL_BLOCKED_TOOL, GOAL_WAIT_TOOL] as const;
const REQUIRED_GOAL_TOOL_NAMES = [GOAL_COMPLETE_TOOL, GOAL_BLOCKED_TOOL] as const;

export function goalToolsAvailable(pi: Pick<ExtensionAPI, "getActiveTools">) {
  const active = new Set(pi.getActiveTools());
  return REQUIRED_GOAL_TOOL_NAMES.every((name) => active.has(name));
}

/**
 * Explicit Goal activation may restore only Goal's own helper tools after a
 * restrictive allowlist removed them. Other tools remain untouched.
 */
export function activateGoalTools(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">) {
  const active = pi.getActiveTools();
  const activeNames = new Set(active);
  const missing = GOAL_TOOL_NAMES.filter((name) => !activeNames.has(name));
  if (missing.length === 0) {
    assertGoalToolsAvailable(pi);
    return;
  }

  pi.setActiveTools([...active, ...missing]);
  try {
    assertGoalToolsAvailable(pi);
  } catch (error) {
    const current = pi.getActiveTools();
    const next = current.filter(
      (name) => activeNames.has(name) || !GOAL_TOOL_NAMES.includes(name as (typeof GOAL_TOOL_NAMES)[number]),
    );
    if (next.length !== current.length) pi.setActiveTools(next);
    throw error;
  }
}

export function assertGoalToolsAvailable(pi: Pick<ExtensionAPI, "getActiveTools">) {
  if (goalToolsAvailable(pi)) return;
  throw new Error(
    "goal_complete and goal_blocked are unavailable; include them in the active tool allowlist or leave the restrictive tool mode first.",
  );
}
