import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockPi } from "../../../test/support.js";
import { activateGoalTools, assertGoalToolsAvailable, goalToolsAvailable } from "../src/tool-policy.js";

test("Goal tool availability accepts an already active helper set without mutation", () => {
  const mock = createMockPi({ activeTools: ["read", "goal_complete", "goal_blocked"] });
  let activeToolWrites = 0;
  const setActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
  mock.rawPi.setActiveTools = (tools) => {
    activeToolWrites += 1;
    setActiveTools(tools);
  };

  assert.equal(goalToolsAvailable(mock.pi), true);
  assert.doesNotThrow(() => assertGoalToolsAvailable(mock.pi));
  activateGoalTools(mock.pi);
  assert.equal(activeToolWrites, 1);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "goal_complete", "goal_blocked", "goal_wait"]);
});

test("explicit Goal activation adds only missing Goal helper tools", () => {
  const mock = createMockPi({ activeTools: ["read", "bash", "scrape"] });
  let activeToolWrites = 0;
  const setActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
  mock.rawPi.setActiveTools = (tools) => {
    activeToolWrites += 1;
    setActiveTools(tools);
  };

  assert.equal(goalToolsAvailable(mock.pi), false);
  assert.doesNotThrow(() => activateGoalTools(mock.pi));
  assert.equal(activeToolWrites, 1);
  assert.deepEqual(mock.rawPi.getActiveTools(), [
    "read",
    "bash",
    "scrape",
    "goal_complete",
    "goal_blocked",
    "goal_wait",
  ]);
  assert.equal(goalToolsAvailable(mock.pi), true);
});

test("activation still rejects when a required Goal helper remains unavailable", () => {
  const mock = createMockPi({ activeTools: ["read", "bash"] });
  const setActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
  mock.rawPi.setActiveTools = (tools) => setActiveTools(tools.filter((name) => name !== "goal_blocked"));

  assert.throws(() => activateGoalTools(mock.pi), /goal_blocked are unavailable/u);
  assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);
});
