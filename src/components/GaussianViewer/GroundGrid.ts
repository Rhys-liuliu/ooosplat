import { BoundingBox, Color, LAYERID_WORLD, Vec3, type Application } from "playcanvas";

export interface GroundGridGeometry {
  positions: Vec3[];
  colors: Color[];
  step: number;
  halfSize: number;
  bounds: BoundingBox;
}

export function niceGridStep(span: number) {
  const raw = Math.max(span, 0.0001) / 12;
  const exponent = Math.floor(Math.log10(raw));
  const magnitude = 10 ** exponent;
  const normalized = raw / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

export function buildGroundGrid(modelBounds: BoundingBox): GroundGridGeometry {
  const span = Math.max(modelBounds.halfExtents.x * 2, modelBounds.halfExtents.y * 2, modelBounds.halfExtents.z * 2, 0.0001);
  const step = niceGridStep(span);
  const halfSize = step * 10;
  const positions: Vec3[] = [];
  const colors: Color[] = [];
  const minor = new Color(0.18, 0.21, 0.27);
  const major = new Color(0.28, 0.32, 0.4);
  const xAxis = new Color(0.9, 0.25, 0.22);
  const yAxis = new Color(0.22, 0.74, 0.39);
  const zAxis = new Color(0.2, 0.43, 0.96);

  const addLine = (start: Vec3, end: Vec3, color: Color) => {
    positions.push(start, end);
    colors.push(color, color);
  };

  for (let index = -10; index <= 10; index += 1) {
    if (index === 0) continue;
    const offset = index * step;
    const color = index % 5 === 0 ? major : minor;
    addLine(new Vec3(-halfSize, 0, offset), new Vec3(halfSize, 0, offset), color);
    addLine(new Vec3(offset, 0, -halfSize), new Vec3(offset, 0, halfSize), color);
  }

  addLine(new Vec3(-halfSize, 0, 0), new Vec3(halfSize, 0, 0), xAxis);
  addLine(new Vec3(0, 0, -halfSize), new Vec3(0, 0, halfSize), zAxis);
  addLine(new Vec3(0, 0, 0), new Vec3(0, step * 2, 0), yAxis);

  const bounds = new BoundingBox(new Vec3(0, step, 0), new Vec3(halfSize, step, halfSize));
  return { positions, colors, step, halfSize, bounds };
}

export class GroundGrid {
  private destroyed = false;
  private visible = true;
  private readonly stopDrawing: () => void;
  readonly bounds: BoundingBox;

  constructor(app: Application, bounds: BoundingBox) {
    const geometry = buildGroundGrid(bounds);
    this.bounds = geometry.bounds.clone();
    const worldLayer = app.scene.layers.getLayerById(LAYERID_WORLD) ?? undefined;
    const draw = () => {
      if (this.visible) app.drawLines(geometry.positions, geometry.colors, true, worldLayer);
    };
    const updateHandle = app.on("update", draw);
    this.stopDrawing = () => updateHandle.off();
  }

  setVisible(visible: boolean) {
    this.visible = visible;
  }

  get isVisible() {
    return this.visible;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopDrawing();
  }
}
