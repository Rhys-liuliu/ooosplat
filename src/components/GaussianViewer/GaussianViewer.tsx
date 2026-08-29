import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Application, Entity } from "@playcanvas/react";
import { Camera, GSplat } from "@playcanvas/react/components";
import { useApp, useSplat } from "@playcanvas/react/hooks";
import {
  ADDRESS_CLAMP_TO_EDGE,
  BoundingBox,
  DEVICETYPE_WEBGL2,
  Entity as PcEntity,
  FILTER_LINEAR,
  GAMMA_SRGB,
  type GSplatComponent,
  GSplatResource,
  PIXELFORMAT_RGBA8,
  RenderTarget,
  Texture,
  TONEMAP_LINEAR,
  Vec3,
  WORKBUFFER_UPDATE_ALWAYS,
  WORKBUFFER_UPDATE_AUTO,
  type Application as PcApplication,
  type CameraComponent,
  type WebglGraphicsDevice,
} from "playcanvas";
import {
  ArrowLeft,
  Film,
  FolderOpen,
  LoaderCircle,
  Move,
  Orbit,
  Play,
  Redo2,
  Save,
  Undo2,
  X,
  ZoomIn,
} from "lucide-react";
import appLogo from "../../../assets/app-icon.svg";
import {
  beginGaussianVideoExport,
  cancelGaussianVideoExport,
  commitGaussianVideoExport,
  exportTransformedGaussian,
  onGaussianExportProgress,
  revealFile,
  saveGaussianTransform,
} from "../../lib/backend";
import { previewAssetUrl as withPreviewAssetRevision } from "../../lib/previewAssetUrl";
import { useGaussianTransformStore } from "../../stores/gaussianTransformStore";
import type {
  GaussianExportProgress,
  GaussianTransform,
  GaussianVideoExportResult,
  GaussianVideoExportSession,
} from "../../types/pipeline";
import { PLY_TO_ENGINE_ROTATION } from "./CoordinateSystem";
import {
  copyFlippedRgbaRows,
  normalizedCaptureRegion,
  verticalFovForCapture,
  type NormalizedCaptureRegion,
} from "./PreviewCapture";
import {
  GAUSSIAN_VIDEO_FRAME_COUNT,
  GAUSSIAN_VIDEO_HEIGHT,
  GAUSSIAN_VIDEO_WIDTH,
  checkGaussianVideoCapability,
  encodeGaussianVideo,
  loadWatermarkLogo,
  type GaussianVideoCapability,
  type GaussianVideoEncodingProgress,
} from "./GaussianVideoExport";
import { GroundGrid } from "./GroundGrid";
import {
  ORBIT_DEGREES_PER_SECOND,
  ORBIT_START_SECONDS,
  PREVIEW_ANIMATION_GLSL,
  animationEffectsActive,
  animationPhaseAt,
  orbitDegreesAt,
  robustEffectBounds,
  type PreviewAnimationPhase,
} from "./PreviewAnimation";
import { TransformPanel } from "./TransformPanel";
import { ViewerControls, type ViewerCameraState } from "./ViewerControls";

type ViewerMode = "adjust" | "preview";
type ViewportPhase = "initializing" | "loading" | "mounting" | "ready" | "error";
type ViewportStatus = {
  phase: ViewportPhase;
  progress: number;
  error: string | null;
  renderer: string;
};
type AnimationStatus = {
  phase: PreviewAnimationPhase;
  elapsedSeconds: number;
};
type VideoExportPhase = "idle" | "preparing" | "rendering" | "finalizing" | "saving" | "completed" | "error";

interface SplatSceneApi {
  replay: () => void;
  exportVideo: (options: {
    signal: AbortSignal;
    onProgress: (progress: GaussianVideoEncodingProgress) => void;
    captureRegion: NormalizedCaptureRegion;
  }) => Promise<Uint8Array>;
}

const INITIAL_VIEWPORT: ViewportStatus = {
  phase: "initializing",
  progress: 0,
  error: null,
  renderer: "WEBGL2 / UNIFIED GSPLAT",
};
const INITIAL_VIDEO_CAPABILITY: GaussianVideoCapability & { checking: boolean } = {
  supported: false,
  reason: null,
  checking: true,
};
const INITIAL_CAMERA_POSITION: [number, number, number] = [0, 0, 5];
const IDENTITY_ROTATION: [number, number, number] = [0, 0, 0];
const IDENTITY_SCALE: [number, number, number] = [1, 1, 1];
const FIT_OCCUPANCY = 0.85;
const TRANSFORM_PANEL_SAFE_INSET_PX = 286;
const SQRT_THREE = Math.sqrt(3);

function effectRadialLimit(fullBounds: BoundingBox, effectBounds: BoundingBox) {
  const minimum = fullBounds.getMin();
  const maximum = fullBounds.getMax();
  let limit = 1;
  for (const x of [minimum.x, maximum.x]) {
    for (const y of [minimum.y, maximum.y]) {
      for (const z of [minimum.z, maximum.z]) {
        const dx = (x - effectBounds.center.x) / Math.max(effectBounds.halfExtents.x, 0.0001);
        const dy = (y - effectBounds.center.y) / Math.max(effectBounds.halfExtents.y, 0.0001);
        const dz = (z - effectBounds.center.z) / Math.max(effectBounds.halfExtents.z, 0.0001);
        limit = Math.max(limit, Math.hypot(dx, dy, dz) / SQRT_THREE);
      }
    }
  }
  return limit;
}

const PreviewCamera = memo(forwardRef<PcEntity>(function PreviewCamera(_props, ref) {
  return <Entity ref={ref} name="OOOSplat Preview Camera" position={INITIAL_CAMERA_POSITION} rotation={IDENTITY_ROTATION} scale={IDENTITY_SCALE}>
    <Camera clearColor="#0e1117" fov={52} nearClip={0.01} farClip={10000} gammaCorrection={GAMMA_SRGB} toneMapping={TONEMAP_LINEAR} />
  </Entity>;
}));

function nextAnimationFrame(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      cancelAnimationFrame(frame);
      reject(new DOMException("视频导出已取消。", "AbortError"));
    };
    const frame = requestAnimationFrame(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}

function waitForSplatFrame(
  app: PcApplication,
  camera: CameraComponent,
  signal: AbortSignal,
) {
  const gsplatSystem = app.systems.gsplat;
  if (!gsplatSystem) return Promise.reject(new Error("PlayCanvas GSplat 系统不可用。"));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      handle.off();
      if (error) reject(error);
      else resolve();
    };
    const handle = gsplatSystem.on(
      "frame:ready",
      (frameCamera: CameraComponent, _layer: unknown, ready: boolean, loadingCount: number) => {
        if (frameCamera === camera && ready && loadingCount === 0) finish();
      },
    );
    const abort = () => finish(new DOMException("视频导出已取消。", "AbortError"));
    const timeout = window.setTimeout(
      () => finish(new Error("等待高斯泼溅排序完成超时。请降低系统负载后重试。")),
      8_000,
    );
    signal.addEventListener("abort", abort, { once: true });
    app.renderNextFrame = true;
  });
}

const SplatScene = forwardRef<SplatSceneApi, {
  assetUrl: string;
  transform: GaussianTransform;
  mode: ViewerMode;
  onStatus: (status: ViewportStatus) => void;
  onAnimationStatus: (status: AnimationStatus) => void;
}>(function SplatScene({ assetUrl, transform, mode, onStatus, onAnimationStatus }, ref) {
  const app = useApp();
  const cameraRef = useRef<PcEntity>(null);
  const modelRef = useRef<PcEntity>(null);
  const splatRef = useRef<PcEntity>(null);
  const controlsRef = useRef<ViewerControls | null>(null);
  const gridRef = useRef<GroundGrid | null>(null);
  const appDestroyedRef = useRef(false);
  const modeRef = useRef<ViewerMode>(mode);
  const exportingRef = useRef(false);
  const animationElapsedRef = useRef(0);
  const lastReportedAtRef = useRef(-1);
  const animationComponentRef = useRef<GSplatComponent | null>(null);
  const animationEffectActiveRef = useRef(false);
  const robustLocalBoundsRef = useRef<BoundingBox | null>(null);
  app.scene.gsplatCentersEnabled = true;
  const { asset, loading, error, subscribe } = useSplat(assetUrl);
  const renderer = `${app.graphicsDevice.deviceType.toUpperCase()} / UNIFIED GSPLAT`;

  const setAnimationUniforms = useCallback((enabled: boolean, elapsedSeconds: number) => {
    const component = animationComponentRef.current;
    if (!component || appDestroyedRef.current) return;
    const effectActive = enabled && animationEffectsActive(elapsedSeconds);
    if (effectActive) {
      component.workBufferUpdate = WORKBUFFER_UPDATE_ALWAYS;
      component.setParameter("uOoosplatAnimationEnabled", 1);
      component.setParameter("uOoosplatAnimationTime", elapsedSeconds);
    } else if (animationEffectActiveRef.current || component.getParameter("uOoosplatAnimationEnabled") !== 0) {
      component.workBufferUpdate = WORKBUFFER_UPDATE_AUTO;
      component.setParameter("uOoosplatAnimationEnabled", 0);
      component.setParameter("uOoosplatAnimationTime", Math.min(elapsedSeconds, ORBIT_START_SECONDS));
    }
    animationEffectActiveRef.current = effectActive;
    app.renderNextFrame = true;
  }, [app]);

  const reportAnimation = useCallback((elapsedSeconds: number, force = false) => {
    if (!force && elapsedSeconds - lastReportedAtRef.current < 0.2) return;
    lastReportedAtRef.current = elapsedSeconds;
    onAnimationStatus({ phase: animationPhaseAt(elapsedSeconds), elapsedSeconds });
  }, [onAnimationStatus]);

  const replay = useCallback(() => {
    animationElapsedRef.current = 0;
    lastReportedAtRef.current = -1;
    setAnimationUniforms(true, 0);
    reportAnimation(0, true);
  }, [reportAnimation, setAnimationUniforms]);

  useEffect(() => {
    modeRef.current = mode;
    gridRef.current?.setVisible(mode === "adjust");
    if (mode === "preview") replay();
    else setAnimationUniforms(false, animationElapsedRef.current);
  }, [mode, replay, setAnimationUniforms]);

  useEffect(() => {
    appDestroyedRef.current = false;
    const handle = app.on("destroy", () => {
      appDestroyedRef.current = true;
      controlsRef.current?.destroy();
      controlsRef.current = null;
      gridRef.current?.destroy();
      gridRef.current = null;
    });
    return () => { handle.off(); };
  }, [app]);

  useEffect(() => {
    const canvas = app.graphicsDevice.canvas;
    const container = canvas.parentElement ?? canvas;
    const resize = () => {
      if (appDestroyedRef.current || exportingRef.current) return;
      app.graphicsDevice.maxPixelRatio = Math.max(1, window.devicePixelRatio || 1);
      app.resizeCanvas(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    window.addEventListener("resize", resize);
    resize();
    onStatus({ phase: "loading", progress: 0, error: null, renderer });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [app, onStatus, renderer]);

  useEffect(() => {
    const unsubscribe = subscribe((meta) => onStatus({
      phase: "loading",
      progress: Math.max(0, Math.min(1, meta.progress ?? 0)),
      error: null,
      renderer,
    }));
    return () => { unsubscribe(); };
  }, [onStatus, renderer, subscribe]);

  useEffect(() => {
    if (error) onStatus({ phase: "error", progress: 0, error, renderer });
    else if (asset) onStatus({ phase: "mounting", progress: 1, error: null, renderer });
    else if (loading) onStatus({ phase: "loading", progress: 0, error: null, renderer });
  }, [asset, error, loading, onStatus, renderer]);

  useEffect(() => {
    if (!asset) return;
    return () => {
      if (appDestroyedRef.current || !app.assets.get(asset.id)) return;
      asset.unload();
      app.assets.remove(asset);
    };
  }, [app, asset]);

  const transformedModelBounds = useCallback(() => {
    const source = asset?.resource as GSplatResource | undefined;
    const splat = splatRef.current;
    if (!source?.aabb || !splat) return null;
    const transformed = new BoundingBox();
    transformed.setFromTransformedAabb(source.aabb, splat.getWorldTransform());
    return transformed;
  }, [asset]);

  const transformedEffectBounds = useCallback(() => {
    const source = asset?.resource as GSplatResource | undefined;
    const splat = splatRef.current;
    if (!source?.aabb || !splat) return null;
    if (!robustLocalBoundsRef.current) {
      const robust = robustEffectBounds(source.centers, {
        center: [source.aabb.center.x, source.aabb.center.y, source.aabb.center.z],
        halfExtents: [source.aabb.halfExtents.x, source.aabb.halfExtents.y, source.aabb.halfExtents.z],
      });
      robustLocalBoundsRef.current = new BoundingBox(
        new Vec3(...robust.center),
        new Vec3(...robust.halfExtents),
      );
    }
    const transformed = new BoundingBox();
    transformed.setFromTransformedAabb(robustLocalBoundsRef.current, splat.getWorldTransform());
    return transformed;
  }, [asset]);

  const syncSceneBounds = useCallback(() => {
    const controls = controlsRef.current;
    const modelBounds = transformedModelBounds();
    if (!modelBounds) return null;
    const component = animationComponentRef.current;
    const effectBounds = transformedEffectBounds() ?? modelBounds;
    if (component) {
      component.setParameter(
        "uOoosplatEffectCenter",
        new Float32Array([effectBounds.center.x, effectBounds.center.y, effectBounds.center.z]),
      );
      component.setParameter(
        "uOoosplatEffectExtent",
        new Float32Array([
          Math.max(effectBounds.halfExtents.x, 0.0001),
          Math.max(effectBounds.halfExtents.y, 0.0001),
          Math.max(effectBounds.halfExtents.z, 0.0001),
        ]),
      );
      component.setParameter("uOoosplatEffectRadialLimit", effectRadialLimit(modelBounds, effectBounds));
    }
    if (controls) {
      const combined = modelBounds.clone();
      const gridBounds = gridRef.current?.bounds;
      if (gridBounds) combined.add(gridBounds);
      controls.setSceneBounds(combined);
    }
    return modelBounds;
  }, [transformedEffectBounds, transformedModelBounds]);

  useEffect(() => {
    const entity = modelRef.current;
    if (!entity) return;
    entity.setLocalPosition(...transform.position);
    entity.setLocalEulerAngles(...transform.rotation);
    entity.setLocalScale(transform.scale, transform.scale, transform.scale);
    syncSceneBounds();
  }, [syncSceneBounds, transform]);

  const fit = useCallback((resetDirection = false) => {
    const controls = controlsRef.current;
    const source = asset?.resource as GSplatResource | undefined;
    if (!source?.aabb || !controls) return false;
    const values = [
      source.aabb.center.x, source.aabb.center.y, source.aabb.center.z,
      source.aabb.halfExtents.x, source.aabb.halfExtents.y, source.aabb.halfExtents.z,
    ];
    if (values.some((value) => !Number.isFinite(value))) return false;
    const transformed = syncSceneBounds();
    if (!transformed) return false;
    controls.fit(transformed, {
      resetDirection,
      occupancy: FIT_OCCUPANCY,
      rightInsetPx: TRANSFORM_PANEL_SAFE_INSET_PX,
    });
    return true;
  }, [asset, syncSceneBounds]);

  useEffect(() => {
    if (!asset || !cameraRef.current || !modelRef.current || !splatRef.current) return;
    const component = splatRef.current.gsplat;
    if (!component) return;
    animationComponentRef.current = component;
    animationEffectActiveRef.current = false;
    robustLocalBoundsRef.current = null;
    component.setWorkBufferModifier({ glsl: PREVIEW_ANIMATION_GLSL });
    component.workBufferUpdate = WORKBUFFER_UPDATE_AUTO;
    component.setParameter("uOoosplatAnimationEnabled", 0);
    component.setParameter("uOoosplatAnimationTime", 0);
    component.setParameter("uOoosplatEffectCenter", new Float32Array([0, 0, 0]));
    component.setParameter("uOoosplatEffectExtent", new Float32Array([1, 1, 1]));
    component.setParameter("uOoosplatEffectRadialLimit", 1);
    const controls = new ViewerControls(app.graphicsDevice.canvas, cameraRef.current);
    controlsRef.current = controls;
    const source = asset.resource as GSplatResource;
    const gridBounds = new BoundingBox();
    gridBounds.setFromTransformedAabb(source.aabb, splatRef.current.getWorldTransform());
    const grid = new GroundGrid(app, gridBounds);
    grid.setVisible(modeRef.current === "adjust");
    gridRef.current = grid;
    syncSceneBounds();
    setAnimationUniforms(modeRef.current === "preview", animationElapsedRef.current);

    const updateHandle = app.on("update", (deltaSeconds: number) => {
      if (exportingRef.current || modeRef.current !== "preview") return;
      const previous = animationElapsedRef.current;
      const elapsed = previous + Math.min(Math.max(deltaSeconds, 0), 0.1);
      animationElapsedRef.current = elapsed;
      setAnimationUniforms(true, elapsed);
      controls.orbitBy((elapsed - previous) * ORBIT_DEGREES_PER_SECOND);
      reportAnimation(elapsed);
    });

    let firstFrame = 0;
    let readyFrame = 0;
    firstFrame = requestAnimationFrame(() => {
      readyFrame = requestAnimationFrame(() => {
        if (fit(true)) {
          if (modeRef.current === "preview") replay();
          onStatus({ phase: "ready", progress: 1, error: null, renderer });
        } else {
          onStatus({
            phase: "error",
            progress: 0,
            error: "PLY 已加载，但无法读取有效的模型边界。请确认该文件是 OOOSplat 生成的 Brush Gaussian PLY。",
            renderer,
          });
        }
      });
    });

    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(readyFrame);
      updateHandle.off();
      controls.destroy();
      if (controlsRef.current === controls) controlsRef.current = null;
      grid.destroy();
      if (gridRef.current === grid) gridRef.current = null;
      if (!appDestroyedRef.current && animationComponentRef.current === component && component.entity.gsplat === component) {
        component.workBufferUpdate = WORKBUFFER_UPDATE_AUTO;
        component.setParameter("uOoosplatAnimationEnabled", 0);
        component.setWorkBufferModifier(null);
        component.deleteParameter("uOoosplatAnimationEnabled");
        component.deleteParameter("uOoosplatAnimationTime");
        component.deleteParameter("uOoosplatEffectCenter");
        component.deleteParameter("uOoosplatEffectExtent");
        component.deleteParameter("uOoosplatEffectRadialLimit");
      }
      if (animationComponentRef.current === component) animationComponentRef.current = null;
      animationEffectActiveRef.current = false;
      robustLocalBoundsRef.current = null;
    };
  }, [app, asset, fit, onStatus, renderer, replay, reportAnimation, setAnimationUniforms, syncSceneBounds]);

  const exportVideo = useCallback(async ({
    signal,
    onProgress,
    captureRegion,
  }: {
    signal: AbortSignal;
    onProgress: (progress: GaussianVideoEncodingProgress) => void;
    captureRegion: NormalizedCaptureRegion;
  }) => {
    const controls = controlsRef.current;
    const cameraEntity = cameraRef.current;
    if (!controls || !cameraEntity?.camera) throw new Error("预览相机尚未就绪。 ");
    if (exportingRef.current) throw new Error("已有视频正在导出。 ");

    const graphicsDevice = app.graphicsDevice as WebglGraphicsDevice;
    if (graphicsDevice.maxTextureSize < Math.max(GAUSSIAN_VIDEO_WIDTH, GAUSSIAN_VIDEO_HEIGHT)) {
      throw new Error(`显卡最大纹理尺寸 ${graphicsDevice.maxTextureSize} 无法导出 1080 × 1920 视频。`);
    }
    const readbackPixels = new Uint8Array(GAUSSIAN_VIDEO_WIDTH * GAUSSIAN_VIDEO_HEIGHT * 4);
    let frameImageData: ImageData | null = null;
    const cameraState: ViewerCameraState = controls.snapshot();
    const elapsed = animationElapsedRef.current;
    const previousRenderTarget = cameraEntity.camera.renderTarget;
    const previousFov = cameraEntity.camera.fov;
    const previousEnabled = controls.enabled;
    const previousGridVisible = gridRef.current?.isVisible ?? false;
    const logo = await loadWatermarkLogo(appLogo);
    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = GAUSSIAN_VIDEO_WIDTH;
    outputCanvas.height = GAUSSIAN_VIDEO_HEIGHT;
    const videoTexture = new Texture(graphicsDevice, {
      name: "OOOSplat Portrait Video",
      width: GAUSSIAN_VIDEO_WIDTH,
      height: GAUSSIAN_VIDEO_HEIGHT,
      format: PIXELFORMAT_RGBA8,
      mipmaps: false,
      minFilter: FILTER_LINEAR,
      magFilter: FILTER_LINEAR,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE,
    });
    const videoRenderTarget = new RenderTarget({
      name: "OOOSplat Portrait Video Target",
      colorBuffer: videoTexture,
      depth: true,
      samples: 1,
    });

    exportingRef.current = true;
    controls.enabled = false;
    gridRef.current?.setVisible(false);
    cameraEntity.camera.renderTarget = videoRenderTarget;
    cameraEntity.camera.fov = verticalFovForCapture(previousFov, captureRegion.height);
    setAnimationUniforms(true, 0);

    try {
      return await encodeGaussianVideo({
        canvas: outputCanvas,
        logo,
        signal,
        onProgress,
        renderFrameAt: async (timeSeconds, context) => {
          signal.throwIfAborted();
          animationElapsedRef.current = timeSeconds;
          setAnimationUniforms(true, timeSeconds);
          controls.restore(cameraState);
          controls.setOrbitYaw(cameraState.yaw + orbitDegreesAt(timeSeconds));
          await waitForSplatFrame(app, cameraEntity.camera!, signal);
          await nextAnimationFrame(signal);
          app.render();
          graphicsDevice.setRenderTarget(videoRenderTarget);
          graphicsDevice.updateBegin();
          await graphicsDevice.readPixelsAsync(
            0,
            0,
            GAUSSIAN_VIDEO_WIDTH,
            GAUSSIAN_VIDEO_HEIGHT,
            readbackPixels,
            true,
          );
          signal.throwIfAborted();
          frameImageData ??= context.createImageData(GAUSSIAN_VIDEO_WIDTH, GAUSSIAN_VIDEO_HEIGHT);
          copyFlippedRgbaRows(
            readbackPixels,
            frameImageData.data,
            GAUSSIAN_VIDEO_WIDTH,
            GAUSSIAN_VIDEO_HEIGHT,
          );
          context.putImageData(frameImageData, 0, 0);
        },
      });
    } finally {
      exportingRef.current = false;
      animationElapsedRef.current = elapsed;
      controls.restore(cameraState);
      controls.enabled = previousEnabled;
      gridRef.current?.setVisible(previousGridVisible && modeRef.current === "adjust");
      cameraEntity.camera.renderTarget = previousRenderTarget;
      cameraEntity.camera.fov = previousFov;
      videoTexture.destroy();
      videoRenderTarget.destroy();
      setAnimationUniforms(modeRef.current === "preview", elapsed);
      reportAnimation(elapsed, true);
      app.renderNextFrame = true;
    }
  }, [app, reportAnimation, setAnimationUniforms]);

  useImperativeHandle(ref, () => ({ replay, exportVideo }), [exportVideo, replay]);

  return <>
    <PreviewCamera ref={cameraRef} />
    {asset && <Entity ref={modelRef} name="Gaussian Splat Transform" position={transform.position} rotation={transform.rotation} scale={[transform.scale, transform.scale, transform.scale]}>
      <Entity ref={splatRef} name="Gaussian PLY Coordinates" rotation={PLY_TO_ENGINE_ROTATION}>
        <GSplat asset={asset} unified />
      </Entity>
    </Entity>}
  </>;
});

const formatBytes = (bytes: number) => bytes >= 1024 ** 3
  ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
  : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const compact = (values: number[]) => values.map((value) => Number(value.toFixed(2))).join(" / ");
const phaseLabels: Record<PreviewAnimationPhase, string> = {
  reveal: "显现",
  shockwave: "冲击波",
  orbit: "环绕",
};

export function GaussianViewer({ onExit, onDisposed, pipelineRunning }: {
  onExit: () => void | Promise<void>;
  onDisposed: (projectId: string) => void;
  pipelineRunning: boolean;
}) {
  const store = useGaussianTransformStore();
  const sceneApiRef = useRef<SplatSceneApi | null>(null);
  const captureGuideRef = useRef<HTMLDivElement | null>(null);
  const saveQueue = useRef(Promise.resolve());
  const videoAbortRef = useRef<AbortController | null>(null);
  const videoSessionRef = useRef<GaussianVideoExportSession | null>(null);
  const [mode, setMode] = useState<ViewerMode>("adjust");
  const [viewport, setViewport] = useState<ViewportStatus>(INITIAL_VIEWPORT);
  const [rendererRevision, setRendererRevision] = useState(0);
  const [gaussianExporting, setGaussianExporting] = useState(false);
  const [gaussianExportProgress, setGaussianExportProgress] = useState(0);
  const [gaussianExportResult, setGaussianExportResult] = useState<string | null>(null);
  const [animationStatus, setAnimationStatus] = useState<AnimationStatus>({ phase: "reveal", elapsedSeconds: 0 });
  const [videoCapability, setVideoCapability] = useState(INITIAL_VIDEO_CAPABILITY);
  const [videoPhase, setVideoPhase] = useState<VideoExportPhase>("idle");
  const [videoProgress, setVideoProgress] = useState<GaussianVideoEncodingProgress>({
    phase: "rendering",
    currentFrame: 0,
    totalFrames: GAUSSIAN_VIDEO_FRAME_COUNT,
    progress: 0,
  });
  const [videoError, setVideoError] = useState<string | null>(null);
  const [videoResult, setVideoResult] = useState<GaussianVideoExportResult | null>(null);
  const previewAssetUrl = useMemo(() => {
    if (!store.descriptor) return "";
    return withPreviewAssetRevision(store.descriptor.assetUrl, "retry", rendererRevision.toString());
  }, [rendererRevision, store.descriptor]);

  const onStatus = useCallback((status: ViewportStatus) => setViewport(status), []);
  const onAnimationStatus = useCallback((status: AnimationStatus) => setAnimationStatus(status), []);
  const busy = gaussianExporting || !["idle", "completed", "error"].includes(videoPhase);

  useEffect(() => {
    let active = true;
    void checkGaussianVideoCapability().then((capability) => {
      if (active) setVideoCapability({ ...capability, checking: false });
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setViewport((current) => current.phase === "initializing" ? {
        phase: "error",
        progress: 0,
        error: "WebGL2 渲染器初始化超时。请更新显卡驱动和 Microsoft Edge WebView2 Runtime 后重试。",
        renderer: "WEBGL2 / UNIFIED GSPLAT",
      } : current);
    }, 10_000);
    return () => window.clearTimeout(timeout);
  }, [rendererRevision, store.descriptor?.projectId]);

  useEffect(() => {
    if (!store.descriptor || store.revision === 0) return;
    const projectId = store.descriptor.projectId;
    const transform = store.transform;
    store.setSaveState("saving");
    saveQueue.current = saveQueue.current
      .catch(() => undefined)
      .then(() => saveGaussianTransform(projectId, transform))
      .then(() => {
        if (useGaussianTransformStore.getState().descriptor?.projectId === projectId) {
          useGaussianTransformStore.getState().setSaveState("saved");
        }
      })
      .catch((error: unknown) => {
        if (useGaussianTransformStore.getState().descriptor?.projectId === projectId) {
          useGaussianTransformStore.getState().setSaveState("error", error instanceof Error ? error.message : String(error));
        }
      });
  }, [store.descriptor?.projectId, store.revision]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (mode !== "adjust" || !store.descriptor || (!event.ctrlKey && !event.metaKey)) return;
      const key = event.key.toLowerCase();
      const isUndo = key === "z" && !event.shiftKey;
      const isRedo = (key === "z" && event.shiftKey) || key === "y";
      if (!isUndo && !isRedo) return;
      event.preventDefault();
      if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
      if (isRedo) useGaussianTransformStore.getState().redo();
      else useGaussianTransformStore.getState().undo();
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [mode, store.descriptor?.projectId]);

  useEffect(() => {
    let unlisten: undefined | (() => void);
    void onGaussianExportProgress((event: GaussianExportProgress) => {
      if (event.projectId === useGaussianTransformStore.getState().descriptor?.projectId) {
        setGaussianExportProgress(event.progress);
      }
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  useEffect(() => () => {
    videoAbortRef.current?.abort();
    const session = videoSessionRef.current;
    if (session) void cancelGaussianVideoExport(session.exportId);
  }, []);

  useEffect(() => {
    const projectId = store.descriptor?.projectId;
    if (!projectId) return;
    return () => {
      queueMicrotask(() => onDisposed(projectId));
    };
  }, [onDisposed, store.descriptor?.projectId]);

  const exportGaussian = async () => {
    if (!store.descriptor || busy) return;
    setGaussianExporting(true);
    setGaussianExportProgress(0);
    setGaussianExportResult(null);
    try {
      const result = await exportTransformedGaussian(store.descriptor.projectId, store.transform);
      setGaussianExportProgress(100);
      setGaussianExportResult(result.path);
    } catch (error) {
      setViewport((current) => ({ ...current, phase: "error", error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setGaussianExporting(false);
    }
  };

  const exportVideo = async () => {
    if (!store.descriptor || !sceneApiRef.current || busy || !videoCapability.supported) return;
    const guide = captureGuideRef.current;
    const canvas = guide?.parentElement?.querySelector("canvas");
    if (!guide || !(canvas instanceof HTMLCanvasElement)) {
      setVideoError("无法读取视频取景框，请退出预览后重试。");
      setVideoPhase("error");
      return;
    }
    let captureRegion: NormalizedCaptureRegion;
    try {
      captureRegion = normalizedCaptureRegion(canvas.getBoundingClientRect(), guide.getBoundingClientRect());
    } catch (error) {
      setVideoError(error instanceof Error ? error.message : String(error));
      setVideoPhase("error");
      return;
    }
    setVideoPhase("preparing");
    setVideoError(null);
    setVideoResult(null);
    setVideoProgress({ phase: "rendering", currentFrame: 0, totalFrames: GAUSSIAN_VIDEO_FRAME_COUNT, progress: 0 });
    const abortController = new AbortController();
    videoAbortRef.current = abortController;
    let committed = false;
    try {
      const session = await beginGaussianVideoExport(store.descriptor.projectId);
      videoSessionRef.current = session;
      setVideoPhase("rendering");
      const bytes = await sceneApiRef.current.exportVideo({
        signal: abortController.signal,
        captureRegion,
        onProgress: (progress) => {
          setVideoProgress(progress);
          setVideoPhase(progress.phase === "finalizing" ? "finalizing" : "rendering");
        },
      });
      abortController.signal.throwIfAborted();
      setVideoPhase("saving");
      const result = await commitGaussianVideoExport(session.exportId, bytes);
      committed = true;
      videoSessionRef.current = null;
      setVideoResult(result);
      setVideoPhase("completed");
    } catch (error) {
      if (!abortController.signal.aborted) {
        setVideoError(error instanceof Error ? error.message : String(error));
        setVideoPhase("error");
      } else {
        setVideoPhase("idle");
      }
    } finally {
      const session = videoSessionRef.current;
      if (session && !committed) await cancelGaussianVideoExport(session.exportId).catch(() => undefined);
      videoSessionRef.current = null;
      if (videoAbortRef.current === abortController) videoAbortRef.current = null;
    }
  };

  const cancelVideo = () => videoAbortRef.current?.abort();
  const retry = () => {
    setViewport(INITIAL_VIEWPORT);
    setRendererRevision((value) => value + 1);
  };
  const runHistory = (direction: "undo" | "redo") => {
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    useGaussianTransformStore.getState()[direction]();
  };
  const switchMode = (nextMode: ViewerMode) => {
    if (busy || nextMode === mode) return;
    setMode(nextMode);
    setVideoError(null);
    if (nextMode === "preview") setVideoPhase("idle");
  };

  if (!store.descriptor) return null;

  const loadingLabel = viewport.phase === "initializing"
    ? "正在初始化 WebGL2 渲染器"
    : viewport.phase === "mounting"
      ? "正在创建高斯泼溅 GPU 资源"
      : "正在读取高斯泼溅文件";
  const phaseLabel = {
    initializing: "初始化中",
    loading: "加载中",
    mounting: "准备中",
    ready: "就绪",
    error: "异常",
  }[viewport.phase];
  const videoBusy = !["idle", "completed", "error"].includes(videoPhase);
  const videoButtonLabel = videoPhase === "preparing"
    ? "准备导出"
    : videoPhase === "rendering"
      ? `渲染 ${videoProgress.currentFrame} / ${videoProgress.totalFrames}`
      : videoPhase === "finalizing"
        ? "正在封装 MP4"
        : videoPhase === "saving"
          ? "正在保存"
          : "导出竖屏视频";

  return <section className={`preview-pane active preview-workspace viewer-mode-${mode}`} aria-label="高斯泼溅预览">
    <header className="preview-header">
      <div className="preview-heading">
        <button className="preview-back-icon" type="button" title="返回任务" aria-label="返回任务" disabled={busy} onClick={() => void onExit()}><ArrowLeft size={19} /></button>
        <h1>03 预览</h1>
      </div>
      <div className="preview-mode-control">
        <div className={`preview-mode-toggle mode-${mode}`} role="group" aria-label="预览工作模式">
          <button type="button" className={mode === "adjust" ? "active" : ""} aria-pressed={mode === "adjust"} disabled={busy} onClick={() => switchMode("adjust")}>调整</button>
          <button type="button" className={mode === "preview" ? "active" : ""} aria-pressed={mode === "preview"} disabled={busy} onClick={() => switchMode("preview")}>动画</button>
        </div>
        <p>{mode === "adjust" ? "调整高斯泼溅的原点、大小与位置等" : "调整画面并导出展示视频"}</p>
      </div>
      <div className="preview-input-hints" aria-label="视图鼠标操作">
        <span><Orbit size={15} />左键旋转</span>
        <span><Move size={15} />右键拖动</span>
        <span><ZoomIn size={15} />滚轮缩放</span>
      </div>
    </header>
    <div className="preview-commandbar">
      <div className="preview-header-actions">
        {mode === "adjust" ? <>
          <button type="button" title="撤销（Ctrl+Z）" disabled={store.history.length === 0 || busy} onClick={() => runHistory("undo")}><Undo2 size={14} />撤销</button>
          <button type="button" title="重做（Ctrl+Shift+Z / Ctrl+Y）" disabled={store.future.length === 0 || busy} onClick={() => runHistory("redo")}><Redo2 size={14} />重做</button>
          <button type="button" disabled={busy || viewport.phase !== "ready"} onClick={() => void exportGaussian()}>{gaussianExporting ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />} {gaussianExporting ? `导出中 ${gaussianExportProgress.toFixed(0)}%` : "导出高斯"}</button>
        </> : <>
          <button type="button" disabled={videoBusy || viewport.phase !== "ready"} onClick={() => sceneApiRef.current?.replay()}><Play size={14} />重新播放</button>
          {videoBusy
            ? <button type="button" className="video-cancel" disabled={videoPhase === "saving"} onClick={cancelVideo}><X size={14} />取消导出</button>
            : <button type="button" disabled={!videoCapability.supported || viewport.phase !== "ready"} title={videoCapability.reason ?? undefined} onClick={() => void exportVideo()}><Film size={14} />{videoButtonLabel}</button>}
        </>}
      </div>
    </div>
    {pipelineRunning && <div className="preview-resource-note">预览与生成任务正在同时使用图形资源，显存不足时交互可能暂时变慢。</div>}
    <div className="preview-editor">
      <div className="gaussian-viewport">
        <Application key={`${store.descriptor.projectId}-${rendererRevision}`} className="gaussian-canvas" deviceTypes={[DEVICETYPE_WEBGL2]} graphicsDeviceOptions={{ antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: "high-performance" }}>
          <SplatScene ref={sceneApiRef} assetUrl={previewAssetUrl} transform={store.transform} mode={mode} onStatus={onStatus} onAnimationStatus={onAnimationStatus} />
        </Application>
        {mode === "preview" && <div ref={captureGuideRef} className="portrait-capture-guide" aria-hidden="true">
          <div className="portrait-frame-label"><span>1080 × 1920</span><span>30 FPS</span></div>
          <div className="preview-watermark"><img src={appLogo} alt="" /><strong>OOOSplat</strong></div>
        </div>}
        {mode === "preview" && <div className="portrait-matte" aria-hidden="true" />}
        {viewport.phase !== "ready" && viewport.phase !== "error" && <div className="viewport-overlay"><LoaderCircle className="spin" size={22} /><strong>{loadingLabel}</strong>{viewport.phase === "loading" && <span>{(viewport.progress * 100).toFixed(0)}%</span>}</div>}
        {viewport.phase === "error" && <div className="viewport-overlay error"><strong>预览不可用</strong><p>{viewport.error}</p><div className="viewport-error-actions"><button type="button" onClick={retry}>重新加载</button><button type="button" onClick={() => void onExit()}>返回任务</button></div></div>}
        {mode === "adjust" && <TransformPanel transform={store.transform} onBegin={store.beginTransaction} onChange={store.setTransformLive} onCommit={store.commitTransaction} />}
        {mode === "preview" && <div className="animation-hud">
          <span className={`animation-pulse phase-${animationStatus.phase}`} />
          <b>{phaseLabels[animationStatus.phase]}</b>
          <span>{animationStatus.elapsedSeconds.toFixed(1)}s</span>
        </div>}
        {mode === "preview" && videoBusy && <div className="video-export-overlay">
          <div><LoaderCircle className="spin" size={20} /><strong>{videoButtonLabel}</strong></div>
          <div className="video-export-track"><span style={{ width: `${videoProgress.progress * 100}%` }} /></div>
          <small>{videoPhase === "rendering" ? `${Math.round(videoProgress.progress * 100)}% · ${videoProgress.currentFrame} / ${GAUSSIAN_VIDEO_FRAME_COUNT} 帧` : "请保持窗口开启"}</small>
        </div>}
      </div>
    </div>
    <footer className="preview-statusbar">
      <span><b>泼溅数量</b>{store.descriptor.splatCount.toLocaleString()}</span>
      <span><b>文件大小</b>{formatBytes(store.descriptor.fileSize)}</span>
      {mode === "adjust"
        ? <span><b>位置</b>{compact(store.transform.position)} <b>旋转</b>{compact(store.transform.rotation)} <b>缩放</b>{Number(store.transform.scale.toFixed(3))}</span>
        : <span><b>时间线</b>显现 5s · 冲击波 8s · 环绕 24s / 圈</span>}
      <span><b>渲染器</b>{viewport.renderer}</span>
      <span><b>状态</b>{phaseLabel}</span>
      {mode === "adjust" && <span className={`save-state ${store.saveState}`}><b>项目</b>{store.saveState === "saving" ? "保存中" : store.saveState === "error" ? "保存失败" : store.saveState === "dirty" ? "未保存" : "已保存"}</span>}
      {gaussianExportResult && mode === "adjust" && <span className="export-result" title={gaussianExportResult}><b>已导出</b>{gaussianExportResult.split(/[\\/]/).at(-1)}</span>}
      {mode === "preview" && <span><b>视频编码</b>{videoCapability.checking ? "检测中" : videoCapability.supported ? "H.264 可用" : "不可用"}</span>}
      {videoResult && mode === "preview" && <button className="statusbar-file-action" type="button" title={videoResult.path} onClick={() => void revealFile(videoResult.path)}><FolderOpen size={12} /><b>已导出</b>{videoResult.path.split(/[\\/]/).at(-1)} · {formatBytes(videoResult.fileSize)}</button>}
    </footer>
    {store.saveError && mode === "adjust" && <div className="preview-save-error">{store.saveError}</div>}
    {mode === "preview" && !videoCapability.checking && !videoCapability.supported && <div className="preview-video-message warning">{videoCapability.reason}</div>}
    {mode === "preview" && videoError && <div className="preview-video-message error">视频导出失败：{videoError}</div>}
  </section>;
}
