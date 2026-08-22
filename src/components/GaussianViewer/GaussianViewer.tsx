import { useCallback, useEffect, useRef, useState } from "react";
import { Application, Entity } from "@playcanvas/react";
import { Camera, GSplat } from "@playcanvas/react/components";
import { useApp, useSplat } from "@playcanvas/react/hooks";
import {
  BoundingBox, Color, DEVICETYPE_WEBGL2, DEVICETYPE_WEBGPU, Entity as PcEntity,
  Gizmo, GIZMOSPACE_WORLD, GSplatResource, RotateGizmo, ScaleGizmo, TranslateGizmo,
  type Layer, type TransformGizmo,
} from "playcanvas";
import { Expand, Focus, LoaderCircle, Maximize2, Minimize2, RotateCcw, Save } from "lucide-react";
import { exportTransformedGaussian, onGaussianExportProgress, saveGaussianTransform } from "../../lib/backend";
import { useGaussianTransformStore } from "../../stores/gaussianTransformStore";
import type { GaussianExportProgress, GaussianTool, GaussianTransform } from "../../types/pipeline";
import { Toolbar } from "./Toolbar";
import { TransformPanel } from "./TransformPanel";
import { ViewerControls } from "./ViewerControls";

type ViewportApi = { fit: (resetDirection?: boolean) => void };

function SplatScene({ assetUrl, transform, tool, onTransformStart, onTransform, onTransformEnd, onStatus, onReady }: {
  assetUrl: string;
  transform: GaussianTransform;
  tool: GaussianTool;
  onTransformStart: () => void;
  onTransform: (transform: GaussianTransform) => void;
  onTransformEnd: () => void;
  onStatus: (status: { loading: boolean; progress: number; error: string | null; renderer?: string }) => void;
  onReady: (api: ViewportApi | null) => void;
}) {
  const app = useApp();
  const cameraRef = useRef<PcEntity>(null);
  const modelRef = useRef<PcEntity>(null);
  const controlsRef = useRef<ViewerControls | null>(null);
  const boundsRef = useRef<BoundingBox | null>(null);
  const layerRef = useRef<Layer | null>(null);
  const gizmoRef = useRef<TransformGizmo | null>(null);
  const { asset, loading, error, subscribe } = useSplat(assetUrl);

  useEffect(() => {
    const canvas = app.graphicsDevice.canvas;
    app.graphicsDevice.maxPixelRatio = 1;
    const resize = () => app.resizeCanvas(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight));
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    return () => observer.disconnect();
  }, [app]);

  useEffect(() => subscribe((meta) => onStatus({ loading: true, progress: Math.max(0, Math.min(1, meta.progress ?? 0)), error: null })), [subscribe, onStatus]);
  useEffect(() => onStatus({ loading, progress: loading ? 0 : 1, error, renderer: app.graphicsDevice.deviceType.toUpperCase() }), [app, error, loading, onStatus]);

  useEffect(() => {
    const entity = modelRef.current;
    if (!entity) return;
    entity.setLocalPosition(...transform.position);
    entity.setLocalEulerAngles(...transform.rotation);
    entity.setLocalScale(transform.scale, transform.scale, transform.scale);
  }, [transform]);

  const fit = useCallback((resetDirection = false) => {
    const source = asset?.resource as GSplatResource | undefined;
    const entity = modelRef.current;
    const controls = controlsRef.current;
    if (!source?.aabb || !entity || !controls) return;
    const transformed = new BoundingBox();
    transformed.setFromTransformedAabb(source.aabb, entity.getWorldTransform());
    boundsRef.current = transformed;
    controls.fit(transformed, resetDirection);
  }, [asset]);

  useEffect(() => {
    if (!asset || !cameraRef.current || !modelRef.current) return;
    const controls = new ViewerControls(app.graphicsDevice.canvas, cameraRef.current);
    controlsRef.current = controls;
    const layer = Gizmo.createLayer(app, "OOOSplat Transform Gizmo");
    layerRef.current = layer;
    onReady({ fit });
    const frame = requestAnimationFrame(() => fit(true));
    return () => {
      cancelAnimationFrame(frame);
      onReady(null);
      gizmoRef.current?.destroy();
      gizmoRef.current = null;
      controls.destroy();
      controlsRef.current = null;
      app.scene.layers.remove(layer);
      layerRef.current = null;
    };
  }, [app, asset, fit, onReady]);

  useEffect(() => {
    gizmoRef.current?.destroy();
    gizmoRef.current = null;
    const camera = cameraRef.current?.camera;
    const model = modelRef.current;
    const layer = layerRef.current;
    if (tool === "select" || !camera || !model || !layer) return;
    const gizmo: TransformGizmo = tool === "move"
      ? new TranslateGizmo(camera, layer)
      : tool === "rotate"
        ? new RotateGizmo(camera, layer)
        : new ScaleGizmo(camera, layer);
    gizmo.coordSpace = GIZMOSPACE_WORLD;
    gizmo.size = 0.85;
    gizmo.setTheme({ shapeBase: { x: new Color(0.88, 0.24, 0.22), y: new Color(0.2, 0.72, 0.38), z: new Color(0.18, 0.43, 0.95) } });
    if (gizmo instanceof ScaleGizmo) {
      gizmo.enableShape("x", false);
      gizmo.enableShape("y", false);
      gizmo.enableShape("z", false);
      gizmo.enableShape("xy", false);
      gizmo.enableShape("xz", false);
      gizmo.enableShape("yz", false);
      gizmo.enableShape("xyz", true);
    }
    const readTransform = () => {
      const position = model.getLocalPosition();
      const rotation = model.getLocalEulerAngles();
      const scale = model.getLocalScale().x;
      onTransform({ position: [position.x, position.y, position.z], rotation: [rotation.x, rotation.y, rotation.z], scale: Math.max(0.001, Math.min(1000, scale)) });
    };
    gizmo.on("transform:start", () => {
      if (controlsRef.current) controlsRef.current.enabled = false;
      onTransformStart();
    });
    gizmo.on("transform:move", readTransform);
    gizmo.on("transform:end", () => {
      readTransform();
      if (controlsRef.current) controlsRef.current.enabled = true;
      onTransformEnd();
    });
    gizmo.attach(model);
    gizmoRef.current = gizmo;
    return () => {
      gizmo.destroy();
      if (gizmoRef.current === gizmo) gizmoRef.current = null;
      if (controlsRef.current) controlsRef.current.enabled = true;
    };
  }, [tool, onTransform, onTransformEnd, onTransformStart]);

  return <>
    <Entity ref={cameraRef} name="OOOSplat Preview Camera" position={[0, 0, 5]}>
      <Camera clearColor="#0e1117" fov={52} nearClip={0.01} farClip={10000} />
    </Entity>
    {asset && <Entity ref={modelRef} name="Gaussian Splat" position={transform.position} rotation={transform.rotation} scale={[transform.scale, transform.scale, transform.scale]}>
      <GSplat asset={asset} />
    </Entity>}
  </>;
}

const formatBytes = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const compact = (values: number[]) => values.map((value) => Number(value.toFixed(2))).join(" / ");

export function GaussianViewer({ expanded, onToggleExpanded, pipelineRunning }: { expanded: boolean; onToggleExpanded: () => void; pipelineRunning: boolean }) {
  const store = useGaussianTransformStore();
  const apiRef = useRef<ViewportApi | null>(null);
  const saveQueue = useRef(Promise.resolve());
  const [viewport, setViewport] = useState({ loading: false, progress: 0, error: null as string | null, renderer: "—" });
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportResult, setExportResult] = useState<string | null>(null);

  const onStatus = useCallback((status: { loading: boolean; progress: number; error: string | null; renderer?: string }) => setViewport((current) => ({ ...current, ...status })), []);
  const onReady = useCallback((api: ViewportApi | null) => { apiRef.current = api; }, []);
  const onTransform = useCallback((transform: GaussianTransform) => useGaussianTransformStore.getState().setTransformLive(transform), []);
  const onTransformStart = useCallback(() => useGaussianTransformStore.getState().beginTransaction(), []);
  const onTransformEnd = useCallback(() => useGaussianTransformStore.getState().commitTransaction(), []);

  useEffect(() => {
    if (!store.descriptor || store.revision === 0) return;
    const projectId = store.descriptor.projectId;
    const transform = store.transform;
    store.setSaveState("saving");
    saveQueue.current = saveQueue.current
      .catch(() => undefined)
      .then(() => saveGaussianTransform(projectId, transform))
      .then(() => {
        if (useGaussianTransformStore.getState().descriptor?.projectId === projectId) useGaussianTransformStore.getState().setSaveState("saved");
      })
      .catch((error: unknown) => {
        if (useGaussianTransformStore.getState().descriptor?.projectId === projectId) useGaussianTransformStore.getState().setSaveState("error", error instanceof Error ? error.message : String(error));
      });
  }, [store.descriptor?.projectId, store.revision]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (!store.descriptor || !event.ctrlKey || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
      if (event.shiftKey) useGaussianTransformStore.getState().redo();
      else useGaussianTransformStore.getState().undo();
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [store.descriptor]);

  useEffect(() => {
    let unlisten: undefined | (() => void);
    void onGaussianExportProgress((event: GaussianExportProgress) => {
      if (event.projectId === useGaussianTransformStore.getState().descriptor?.projectId) setExportProgress(event.progress);
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  const exportGaussian = async () => {
    if (!store.descriptor || exporting) return;
    setExporting(true);
    setExportProgress(0);
    setExportResult(null);
    try {
      const result = await exportTransformedGaussian(store.descriptor.projectId, store.transform);
      setExportProgress(100);
      setExportResult(result.path);
    } catch (error) {
      setViewport((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setExporting(false);
    }
  };

  if (!store.descriptor) return <section className="preview-pane" aria-label="Gaussian Splat 预览">
    <div className="pane-header preview-pane-heading"><h2>03 预览</h2><button type="button" className="preview-expand" disabled><Maximize2 size={14} />展开</button></div>
    <div className="preview-empty"><Focus size={34} strokeWidth={1.3} /><strong>选择一个已完成项目</strong><p>在“02 历史任务”中点击“预览”，即可在 OOOSplat 内浏览和调整 Gaussian Splat。</p></div>
  </section>;

  return <section className="preview-pane active" aria-label="Gaussian Splat 预览">
    <header className="preview-header">
      <div><span>03 预览</span><strong>OOOSplat Preview</strong><small title={store.descriptor.modelPath}>{store.descriptor.modelPath}</small></div>
      <div className="preview-header-actions">
        <button type="button" onClick={() => apiRef.current?.fit(true)}><RotateCcw size={14} />Reset View</button>
        <button type="button" onClick={() => apiRef.current?.fit(false)}><Focus size={14} />Fit View</button>
        <button type="button" disabled={exporting} onClick={() => void exportGaussian()}>{exporting ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />} {exporting ? `Export ${exportProgress.toFixed(0)}%` : "Export Gaussian"}</button>
        <button type="button" onClick={onToggleExpanded}>{expanded ? <Minimize2 size={14} /> : <Expand size={14} />}{expanded ? "恢复" : "展开"}</button>
      </div>
    </header>
    {pipelineRunning && <div className="preview-resource-note">预览与生成任务正在同时使用图形资源，显存不足时交互可能暂时变慢。</div>}
    <div className="preview-editor">
      <Toolbar value={store.tool} onChange={store.setTool} />
      <div className="gaussian-viewport">
        <Application key={store.descriptor.projectId} className="gaussian-canvas" deviceTypes={[DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2]} graphicsDeviceOptions={{ antialias: false, alpha: false, powerPreference: "high-performance" }}>
          <SplatScene assetUrl={store.descriptor.assetUrl} transform={store.transform} tool={store.tool} onTransformStart={onTransformStart} onTransform={onTransform} onTransformEnd={onTransformEnd} onStatus={onStatus} onReady={onReady} />
        </Application>
        {viewport.loading && <div className="viewport-overlay"><LoaderCircle className="spin" size={22} /><strong>正在加载 Gaussian Splat</strong><span>{(viewport.progress * 100).toFixed(0)}%</span></div>}
        {viewport.error && <div className="viewport-overlay error"><strong>预览不可用</strong><p>{viewport.error}</p><button type="button" onClick={() => setViewport((current) => ({ ...current, error: null }))}>关闭</button></div>}
      </div>
      <TransformPanel transform={store.transform} onBegin={store.beginTransaction} onChange={store.setTransformLive} onCommit={store.commitTransaction} />
    </div>
    <footer className="preview-statusbar">
      <span><b>SPLATS</b>{store.descriptor.splatCount.toLocaleString()}</span>
      <span><b>FILE</b>{formatBytes(store.descriptor.fileSize)}</span>
      <span><b>P</b>{compact(store.transform.position)} <b>R</b>{compact(store.transform.rotation)} <b>S</b>{Number(store.transform.scale.toFixed(3))}</span>
      <span><b>RENDERER</b>{viewport.renderer}</span>
      <span className={`save-state ${store.saveState}`}><b>PROJECT</b>{store.saveState === "saving" ? "保存中" : store.saveState === "error" ? "保存失败" : store.saveState === "dirty" ? "未保存" : "已保存"}</span>
      {exportResult && <span className="export-result" title={exportResult}><b>EXPORTED</b>{exportResult.split(/[\\/]/).at(-1)}</span>}
    </footer>
    {store.saveError && <div className="preview-save-error">{store.saveError}</div>}
  </section>;
}
