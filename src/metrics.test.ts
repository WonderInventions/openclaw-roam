import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetRoamMetricsForTests,
  readRoamMetrics,
  recordRoamEvent,
} from "./metrics.js";

describe("metrics", () => {
  beforeEach(() => {
    __resetRoamMetricsForTests();
  });

  it("returns an empty snapshot when nothing has been recorded", () => {
    expect(readRoamMetrics()).toEqual({});
  });

  it("aggregates by reason across calls", () => {
    recordRoamEvent("drop:no-mention");
    recordRoamEvent("drop:no-mention");
    recordRoamEvent("drop:self-message");
    recordRoamEvent("dispatch:start");
    expect(readRoamMetrics()).toEqual({
      "drop:no-mention": 2,
      "drop:self-message": 1,
      "dispatch:start": 1,
    });
  });

  it("snapshot is a defensive copy (mutating the result does not affect counters)", () => {
    recordRoamEvent("drop:no-mention");
    const snap = readRoamMetrics();
    snap["drop:no-mention"] = 999;
    expect(readRoamMetrics()["drop:no-mention"]).toBe(1);
  });
});
