import { useEffect, useState, type KeyboardEvent } from "react";
import type { GaussianTransform } from "../../types/pipeline";

function NumberField({ label, value, onBegin, onChange, onCommit, scale = false }: { label: string; value: number; onBegin: () => void; onChange: (value: number) => void; onCommit: () => void; scale?: boolean }) {
  const [text, setText] = useState(String(Number(value.toFixed(4))));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(String(Number(value.toFixed(4)))); }, [value, focused]);
  const commit = () => {
    const parsed = Number(text);
    if (Number.isFinite(parsed)) onChange(scale ? Math.min(1000, Math.max(0.001, parsed)) : parsed);
    setFocused(false);
    onCommit();
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") {
      setText(String(Number(value.toFixed(4))));
      event.currentTarget.blur();
    }
  };
  return <label className="transform-field"><span>{label}</span><input type="text" inputMode="decimal" value={text} onFocus={() => { setFocused(true); onBegin(); }} onChange={(event) => { setText(event.target.value); const parsed = Number(event.target.value); if (Number.isFinite(parsed) && (!scale || parsed > 0)) onChange(parsed); }} onBlur={commit} onKeyDown={keyDown} /></label>;
}

export function TransformPanel({ transform, onBegin, onChange, onCommit }: { transform: GaussianTransform; onBegin: () => void; onChange: (transform: GaussianTransform) => void; onCommit: () => void }) {
  const vectorField = (group: "position" | "rotation", index: 0 | 1 | 2, value: number) => <NumberField label={["X", "Y", "Z"][index]} value={value} onBegin={onBegin} onCommit={onCommit} onChange={(next) => {
    const vector = [...transform[group]] as [number, number, number];
    vector[index] = next;
    onChange({ ...transform, [group]: vector });
  }} />;
  return <aside className="transform-panel">
    <div className="transform-panel-heading"><strong>Transform</strong><small>MODEL</small></div>
    <section><h4>Position</h4><div className="transform-fields">{vectorField("position", 0, transform.position[0])}{vectorField("position", 1, transform.position[1])}{vectorField("position", 2, transform.position[2])}</div></section>
    <section><h4>Rotation</h4><div className="transform-fields">{vectorField("rotation", 0, transform.rotation[0])}{vectorField("rotation", 1, transform.rotation[1])}{vectorField("rotation", 2, transform.rotation[2])}</div><p>DEGREES</p></section>
    <section><h4>Scale</h4><NumberField label="Uniform" value={transform.scale} scale onBegin={onBegin} onCommit={onCommit} onChange={(scale) => onChange({ ...transform, scale })} /></section>
  </aside>;
}
