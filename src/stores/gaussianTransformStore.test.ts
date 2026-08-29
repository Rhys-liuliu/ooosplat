import { beforeEach, describe, expect, it } from "vitest";
import { IDENTITY_TRANSFORM, useGaussianTransformStore } from "./gaussianTransformStore";

describe("GaussianTransformStore", () => {
  beforeEach(() => useGaussianTransformStore.getState().close());

  it("records a drag as one transaction and supports undo and redo", () => {
    const store = useGaussianTransformStore.getState();
    store.beginTransaction();
    store.setTransformLive({ ...IDENTITY_TRANSFORM, position: [1, 2, 3] });
    store.setTransformLive({ ...IDENTITY_TRANSFORM, position: [4, 5, 6] });
    store.commitTransaction();
    expect(useGaussianTransformStore.getState().history).toHaveLength(1);
    useGaussianTransformStore.getState().undo();
    expect(useGaussianTransformStore.getState().transform.position).toEqual([0, 0, 0]);
    useGaussianTransformStore.getState().redo();
    expect(useGaussianTransformStore.getState().transform.position).toEqual([4, 5, 6]);
  });

  it("caps history at 100 committed transforms", () => {
    for (let index = 1; index <= 105; index += 1) {
      useGaussianTransformStore.getState().beginTransaction();
      useGaussianTransformStore.getState().setTransformLive({ ...IDENTITY_TRANSFORM, scale: index });
      useGaussianTransformStore.getState().commitTransaction();
    }
    expect(useGaussianTransformStore.getState().history).toHaveLength(100);
  });

  it("does not overwrite an in-flight save state for a no-op transaction", () => {
    useGaussianTransformStore.getState().setSaveState("saving");
    useGaussianTransformStore.getState().beginTransaction();
    useGaussianTransformStore.getState().commitTransaction();
    expect(useGaussianTransformStore.getState().saveState).toBe("saving");
  });
});
