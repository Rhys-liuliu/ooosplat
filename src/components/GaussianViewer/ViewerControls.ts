import { BoundingBox, Entity, Vec3, type CameraComponent } from "playcanvas";

export class ViewerControls {
  private readonly canvas: HTMLCanvasElement;
  private readonly cameraEntity: Entity;
  private readonly camera: CameraComponent;
  private target = new Vec3();
  private yaw = 35;
  private pitch = -22;
  private distance = 5;
  private pointerId: number | null = null;
  private mode: "orbit" | "pan" | null = null;
  private lastX = 0;
  private lastY = 0;
  enabled = true;

  constructor(canvas: HTMLCanvasElement, cameraEntity: Entity) {
    if (!cameraEntity.camera) throw new Error("Preview camera component is unavailable");
    this.canvas = canvas;
    this.cameraEntity = cameraEntity;
    this.camera = cameraEntity.camera;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.preventContextMenu);
    this.updateCamera();
  }

  destroy() {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("contextmenu", this.preventContextMenu);
  }

  fit(bounds: BoundingBox, resetDirection = false) {
    if (resetDirection) {
      this.yaw = 35;
      this.pitch = -22;
    }
    this.target.copy(bounds.center);
    const radius = Math.max(bounds.halfExtents.length(), 0.01);
    const halfFov = (this.camera.fov * Math.PI) / 360;
    this.distance = Math.max(radius / Math.sin(halfFov) * 1.18, 0.05);
    this.camera.nearClip = Math.max(this.distance - radius * 2.5, 0.001);
    this.camera.farClip = Math.max(this.distance + radius * 6, 100);
    this.updateCamera();
  }

  private updateCamera() {
    const yaw = this.yaw * Math.PI / 180;
    const pitch = this.pitch * Math.PI / 180;
    const horizontal = Math.cos(pitch) * this.distance;
    this.cameraEntity.setPosition(
      this.target.x + Math.sin(yaw) * horizontal,
      this.target.y + Math.sin(pitch) * this.distance,
      this.target.z + Math.cos(yaw) * horizontal,
    );
    this.cameraEntity.lookAt(this.target);
  }

  private preventContextMenu = (event: MouseEvent) => event.preventDefault();

  private onPointerDown = (event: PointerEvent) => {
    if (!this.enabled || (event.button !== 0 && event.button !== 2)) return;
    this.pointerId = event.pointerId;
    this.mode = event.button === 0 ? "orbit" : "pan";
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.canvas.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.enabled || this.pointerId !== event.pointerId || !this.mode) return;
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    if (this.mode === "orbit") {
      this.yaw -= dx * 0.3;
      this.pitch = Math.max(-89, Math.min(89, this.pitch + dy * 0.3));
    } else {
      const speed = this.distance * 0.0016;
      this.target.add(this.cameraEntity.right.clone().mulScalar(-dx * speed));
      this.target.add(this.cameraEntity.up.clone().mulScalar(dy * speed));
    }
    this.updateCamera();
  };

  private onPointerUp = (event: PointerEvent) => {
    if (this.pointerId !== event.pointerId) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.pointerId = null;
    this.mode = null;
  };

  private onWheel = (event: WheelEvent) => {
    if (!this.enabled) return;
    event.preventDefault();
    this.distance = Math.max(0.01, Math.min(1_000_000, this.distance * Math.exp(event.deltaY * 0.001)));
    this.updateCamera();
  };
}
