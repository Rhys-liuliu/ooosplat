import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { GaussianTransform } from "../../types/pipeline";

type ScrubMode = "linear" | "rotation" | "scale";
type DragState = {
  pointerId: number;
  startX: number;
  startValue: number;
  dragging: boolean;
};

const clampScale = (value: number) => Math.min(1000, Math.max(0.001, value));
const formatValue = (value: number) => String(Number(value.toFixed(4)));

function scrubValue(startValue: number, deltaX: number, mode: ScrubMode, fine: boolean) {
  const sensitivity = fine ? 0.1 : 1;
  if (mode === "scale") return clampScale(startValue * Math.exp(deltaX * 0.01 * sensitivity));
  const step = mode === "rotation" ? 0.25 : Math.max(Math.abs(startValue) * 0.005, 0.01);
  return startValue + deltaX * step * sensitivity;
}

export function NumberField({
  label, name, value, onBegin, onChange, onCommit, mode = "linear",
}: {
  label: string;
  name: string;
  value: number;
  onBegin: () => void;
  onChange: (value: number) => void;
  onCommit: () => void;
  mode?: ScrubMode;
}) {
  const [text, setText] = useState(formatValue(value));
  const [focused, setFocused] = useState(false);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    if (!focused && !dragRef.current?.dragging) setText(formatValue(value));
  }, [focused, value]);

  const commit = () => {
    const parsed = Number(text);
    if (Number.isFinite(parsed)) onChange(mode === "scale" ? clampScale(parsed) : parsed);
    setFocused(false);
    onCommit();
  };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") {
      setText(formatValue(value));
      event.currentTarget.blur();
    }
  };

  const pointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value, dragging: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    if (!drag.dragging) {
      if (Math.abs(deltaX) < 3) return;
      drag.dragging = true;
      onBegin();
      event.currentTarget.classList.add("dragging");
    }
    event.preventDefault();
    const next = scrubValue(drag.startValue, deltaX, mode, event.shiftKey);
    setText(formatValue(next));
    onChange(next);
  };

  const pointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    event.currentTarget.classList.remove("dragging");
    dragRef.current = null;
    if (drag.dragging) onCommit();
  };

  return <div className="transform-field">
    <button
      className="transform-scrubber"
      type="button"
      title={`${name}：按住鼠标左键左右拖动调整，按 Shift 精细调整`}
      aria-label={`${name}拖动调整`}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerEnd}
      onPointerCancel={pointerEnd}
    >{label}</button>
    <input
      type="text"
      inputMode="decimal"
      aria-label={name}
      value={text}
      onFocus={() => { setFocused(true); onBegin(); }}
      onChange={(event) => {
        setText(event.target.value);
        const parsed = Number(event.target.value);
        if (Number.isFinite(parsed) && (mode !== "scale" || parsed > 0)) onChange(parsed);
      }}
      onBlur={commit}
      onKeyDown={keyDown}
    />
  </div>;
}

export function TransformPanel({ transform, onBegin, onChange, onCommit }: { transform: GaussianTransform; onBegin: () => void; onChange: (transform: GaussianTransform) => void; onCommit: () => void }) {
  const vectorField = (group: "position" | "rotation", index: 0 | 1 | 2, value: number) => {
    const axis = ["X", "Y", "Z"][index];
    const groupName = group === "position" ? "位置" : "旋转";
    return <NumberField
      key={`${group}-${axis}`}
      label={axis}
      name={`${groupName} ${axis}`}
      value={value}
      mode={group === "rotation" ? "rotation" : "linear"}
      onBegin={onBegin}
      onCommit={onCommit}
      onChange={(next) => {
        const vector = [...transform[group]] as [number, number, number];
        vector[index] = next;
        onChange({ ...transform, [group]: vector });
      }}
    />;
  };

  return <aside className="transform-panel" aria-label="模型变换">
    <div className="transform-panel-heading"><strong>变换</strong><small>拖动轴标签快速调整</small></div>
    <section><h4>位置</h4><div className="transform-fields">{vectorField("position", 0, transform.position[0])}{vectorField("position", 1, transform.position[1])}{vectorField("position", 2, transform.position[2])}</div></section>
    <section><h4>旋转</h4><div className="transform-fields">{vectorField("rotation", 0, transform.rotation[0])}{vectorField("rotation", 1, transform.rotation[1])}{vectorField("rotation", 2, transform.rotation[2])}</div><p>角度</p></section>
    <section><h4>缩放</h4><NumberField label="等比" name="等比缩放" value={transform.scale} mode="scale" onBegin={onBegin} onCommit={onCommit} onChange={(scale) => onChange({ ...transform, scale })} /></section>
  </aside>;
}
