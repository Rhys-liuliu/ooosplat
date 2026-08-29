import { Vec3 } from "playcanvas";
import { describe, expect, it } from "vitest";
import { plyDirectionToEngine } from "./CoordinateSystem";

describe("Gaussian PLY coordinate mapping", () => {
  it("uses the documented 180-degree Z rotation without mirroring handedness", () => {
    const x = plyDirectionToEngine(new Vec3(1, 0, 0));
    const y = plyDirectionToEngine(new Vec3(0, 1, 0));
    const z = plyDirectionToEngine(new Vec3(0, 0, 1));

    expect(x.x).toBeCloseTo(-1);
    expect(y.y).toBeCloseTo(-1);
    expect(z.z).toBeCloseTo(1);
    expect(new Vec3().cross(x, y).dot(z)).toBeGreaterThan(0);
  });
});
