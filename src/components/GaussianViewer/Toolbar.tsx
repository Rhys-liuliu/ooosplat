import { MousePointer2, Move3D, Rotate3D, Scaling } from "lucide-react";
import type { GaussianTool } from "../../types/pipeline";

const tools = [
  { value: "select" as const, label: "Select", icon: MousePointer2 },
  { value: "move" as const, label: "Move", icon: Move3D },
  { value: "rotate" as const, label: "Rotate", icon: Rotate3D },
  { value: "scale" as const, label: "Scale", icon: Scaling },
];

export function Toolbar({ value, onChange }: { value: GaussianTool; onChange: (tool: GaussianTool) => void }) {
  return <nav className="gaussian-tools" aria-label="Gaussian Transform 工具">
    {tools.map(({ value: tool, label, icon: Icon }) => <button key={tool} type="button" className={value === tool ? "active" : ""} aria-pressed={value === tool} title={label} onClick={() => onChange(tool)}>
      <Icon size={18} /><span>{label}</span>
    </button>)}
  </nav>;
}
