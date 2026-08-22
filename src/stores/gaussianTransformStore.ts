import { create } from "zustand";
import type { GaussianPreviewDescriptor, GaussianTool, GaussianTransform } from "../types/pipeline";

export const IDENTITY_TRANSFORM: GaussianTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: 1,
};

const clone = (value: GaussianTransform): GaussianTransform => ({
  position: [...value.position],
  rotation: [...value.rotation],
  scale: value.scale,
});

const equal = (a: GaussianTransform, b: GaussianTransform) =>
  a.scale === b.scale && a.position.every((value, index) => value === b.position[index]) && a.rotation.every((value, index) => value === b.rotation[index]);

interface GaussianTransformState {
  descriptor: (GaussianPreviewDescriptor & { assetUrl: string }) | null;
  tool: GaussianTool;
  transform: GaussianTransform;
  history: GaussianTransform[];
  future: GaussianTransform[];
  transactionStart: GaussianTransform | null;
  revision: number;
  saveState: "saved" | "saving" | "dirty" | "error";
  saveError: string | null;
  load: (descriptor: GaussianPreviewDescriptor & { assetUrl: string }) => void;
  close: () => void;
  setTool: (tool: GaussianTool) => void;
  beginTransaction: () => void;
  setTransformLive: (transform: GaussianTransform) => void;
  commitTransaction: () => void;
  undo: () => void;
  redo: () => void;
  setSaveState: (saveState: GaussianTransformState["saveState"], saveError?: string | null) => void;
}

export const useGaussianTransformStore = create<GaussianTransformState>((set, get) => ({
  descriptor: null,
  tool: "select",
  transform: clone(IDENTITY_TRANSFORM),
  history: [],
  future: [],
  transactionStart: null,
  revision: 0,
  saveState: "saved",
  saveError: null,
  load: (descriptor) => set({ descriptor, transform: clone(descriptor.transform), history: [], future: [], transactionStart: null, tool: "select", revision: 0, saveState: "saved", saveError: null }),
  close: () => set({ descriptor: null, transform: clone(IDENTITY_TRANSFORM), history: [], future: [], transactionStart: null, tool: "select", revision: 0, saveState: "saved", saveError: null }),
  setTool: (tool) => set({ tool }),
  beginTransaction: () => {
    if (!get().transactionStart) set({ transactionStart: clone(get().transform) });
  },
  setTransformLive: (transform) => set({ transform: clone(transform), saveState: "dirty" }),
  commitTransaction: () => {
    const state = get();
    const start = state.transactionStart;
    if (!start || equal(start, state.transform)) {
      set({ transactionStart: null, saveState: start ? "saved" : state.saveState });
      return;
    }
    set({ history: [...state.history, start].slice(-100), future: [], transactionStart: null, revision: state.revision + 1, saveState: "dirty" });
  },
  undo: () => {
    const state = get();
    const previous = state.history.at(-1);
    if (!previous) return;
    set({ transform: clone(previous), history: state.history.slice(0, -1), future: [clone(state.transform), ...state.future].slice(0, 100), transactionStart: null, revision: state.revision + 1, saveState: "dirty" });
  },
  redo: () => {
    const state = get();
    const next = state.future[0];
    if (!next) return;
    set({ transform: clone(next), history: [...state.history, clone(state.transform)].slice(-100), future: state.future.slice(1), transactionStart: null, revision: state.revision + 1, saveState: "dirty" });
  },
  setSaveState: (saveState, saveError = null) => set({ saveState, saveError }),
}));
