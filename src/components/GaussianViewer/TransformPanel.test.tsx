// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GaussianTransform } from "../../types/pipeline";
import { TransformPanel } from "./TransformPanel";

function pointerEvent(type: string, x: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x });
  Object.defineProperty(event, "pointerId", { value: 9 });
  return event;
}

describe("TransformPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("scrubs a numeric value with a left-button horizontal drag", async () => {
    const begin = vi.fn();
    const commit = vi.fn();
    function Harness() {
      const [transform, setTransform] = useState<GaussianTransform>({ position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 });
      return <TransformPanel transform={transform} onBegin={begin} onChange={setTransform} onCommit={commit} />;
    }
    await act(async () => root.render(<Harness />));

    const scrubber = container.querySelector<HTMLButtonElement>('[aria-label="位置 X拖动调整"]');
    await act(async () => {
      scrubber?.dispatchEvent(pointerEvent("pointerdown", 100));
      scrubber?.dispatchEvent(pointerEvent("pointermove", 120));
      scrubber?.dispatchEvent(pointerEvent("pointerup", 120));
    });

    expect(begin).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLInputElement>('[aria-label="位置 X"]')?.value).toBe("0.2");
  });
});
