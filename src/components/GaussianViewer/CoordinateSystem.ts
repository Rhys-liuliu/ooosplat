import { Quat, Vec3 } from "playcanvas";

/** PlayCanvas' documented Gaussian PLY coordinate-space mapping. */
export const PLY_TO_ENGINE_ROTATION: [number, number, number] = [0, 0, 180];

export function plyDirectionToEngine(direction: Vec3) {
  return new Quat()
    .setFromEulerAngles(...PLY_TO_ENGINE_ROTATION)
    .transformVector(direction, new Vec3());
}
