import { BoundingBox, Vec3, type Application } from "playcanvas";
import { describe, expect, it, vi } from "vitest";
import { buildGroundGrid, GroundGrid, niceGridStep } from "./GroundGrid";

describe("GroundGrid", () => {
  it("chooses readable 1/2/5 grid steps for different model scales", () => {
    expect(niceGridStep(0.12)).toBeCloseTo(0.01);
    expect(niceGridStep(12)).toBe(1);
    expect(niceGridStep(24)).toBe(2);
    expect(niceGridStep(60)).toBe(5);
  });

  it("builds an XZ grid with colored origin axes", () => {
    const geometry = buildGroundGrid(new BoundingBox(new Vec3(), new Vec3(6, 2, 3)));

    expect(geometry.step).toBe(1);
    expect(geometry.halfSize).toBe(10);
    expect(geometry.positions).toHaveLength(86);
    expect(geometry.colors).toHaveLength(geometry.positions.length);
    expect(geometry.bounds.halfExtents.x).toBe(geometry.halfSize);
    expect(geometry.bounds.halfExtents.z).toBe(geometry.halfSize);
    expect(geometry.positions.at(-2)?.equals(new Vec3(0, 0, 0))).toBe(true);
    expect(geometry.positions.at(-1)?.equals(new Vec3(0, 2, 0))).toBe(true);
    expect(geometry.colors.at(-1)?.g).toBeGreaterThan(geometry.colors.at(-1)?.r ?? 1);
  });

  it("draws with depth testing and releases the update listener once", () => {
    const off = vi.fn();
    const drawLines = vi.fn();
    let draw: (() => void) | undefined;
    const worldLayer = { id: 0 };
    const app = {
      scene: { layers: { getLayerById: vi.fn(() => worldLayer) } },
      drawLines,
      on: vi.fn((_event: string, callback: () => void) => {
        draw = callback;
        return { off };
      }),
    } as unknown as Application;
    const grid = new GroundGrid(app, new BoundingBox(new Vec3(), new Vec3(1, 1, 1)));

    draw?.();
    expect(drawLines).toHaveBeenCalledWith(expect.any(Array), expect.any(Array), true, worldLayer);
    grid.setVisible(false);
    draw?.();
    expect(grid.isVisible).toBe(false);
    expect(drawLines).toHaveBeenCalledTimes(1);
    grid.setVisible(true);
    draw?.();
    expect(grid.isVisible).toBe(true);
    expect(drawLines).toHaveBeenCalledTimes(2);
    grid.destroy();
    grid.destroy();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
