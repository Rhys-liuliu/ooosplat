// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mediabunny = vi.hoisted(() => {
  const state: {
    output: { state: string; cancel: ReturnType<typeof vi.fn>; finalize: ReturnType<typeof vi.fn> } | null;
    source: { add: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } | null;
  } = { output: null, source: null };
  const canEncodeVideo = vi.fn();

  class BufferTarget {
    buffer: ArrayBuffer | null = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112]).buffer;
  }

  class Output {
    state = "pending";
    start = vi.fn(async () => { this.state = "started"; });
    finalize = vi.fn(async () => { this.state = "finalized"; });
    cancel = vi.fn(async () => { this.state = "canceled"; });
    addVideoTrack = vi.fn();

    constructor(_options: unknown) {
      state.output = this;
    }
  }

  class CanvasSource {
    add = vi.fn(async () => undefined);
    close = vi.fn();

    constructor(_canvas: HTMLCanvasElement, _options: unknown) {
      state.source = this;
    }
  }

  class Mp4OutputFormat {
    constructor(_options: unknown) {}
  }

  return { BufferTarget, CanvasSource, Mp4OutputFormat, Output, canEncodeVideo, state };
});

vi.mock("mediabunny", () => ({
  BufferTarget: mediabunny.BufferTarget,
  CanvasSource: mediabunny.CanvasSource,
  Mp4OutputFormat: mediabunny.Mp4OutputFormat,
  Output: mediabunny.Output,
  canEncodeVideo: mediabunny.canEncodeVideo,
}));

import {
  GAUSSIAN_VIDEO_FRAME_COUNT,
  GAUSSIAN_VIDEO_HEIGHT,
  GAUSSIAN_VIDEO_WIDTH,
  checkGaussianVideoCapability,
  encodeGaussianVideo,
} from "./GaussianVideoExport";

function createCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = GAUSSIAN_VIDEO_WIDTH;
  canvas.height = GAUSSIAN_VIDEO_HEIGHT;
  const context = {
    beginPath: vi.fn(),
    drawImage: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 160 })),
    restore: vi.fn(),
    roundRect: vi.fn(),
    save: vi.fn(),
    fillStyle: "",
    font: "",
    globalAlpha: 1,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    shadowBlur: 0,
    shadowColor: "",
    textBaseline: "alphabetic",
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(canvas, "getContext").mockReturnValue(context);
  return { canvas, context };
}

beforeEach(() => {
  mediabunny.state.output = null;
  mediabunny.state.source = null;
  mediabunny.canEncodeVideo.mockReset();
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(globalThis, "VideoEncoder", { configurable: true, value: class VideoEncoder {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GaussianVideoExport", () => {
  it("reports whether the current WebView can encode AVC", async () => {
    mediabunny.canEncodeVideo.mockResolvedValueOnce(true);
    await expect(checkGaussianVideoCapability()).resolves.toEqual({ supported: true, reason: null });

    mediabunny.canEncodeVideo.mockResolvedValueOnce(false);
    await expect(checkGaussianVideoCapability()).resolves.toEqual({
      supported: false,
      reason: "当前系统没有可用的 AVC / H.264 编码器。",
    });
  });

  it("encodes exactly 690 deterministic frames and finalizes MP4", async () => {
    const { canvas, context } = createCanvas();
    const renderFrameAt = vi.fn(async () => undefined);
    const progress = vi.fn();

    const bytes = await encodeGaussianVideo({
      canvas,
      logo: canvas,
      renderFrameAt,
      signal: new AbortController().signal,
      onProgress: progress,
    });

    expect(GAUSSIAN_VIDEO_FRAME_COUNT).toBe(690);
    expect(renderFrameAt).toHaveBeenCalledTimes(690);
    expect(mediabunny.state.source?.add).toHaveBeenCalledTimes(690);
    expect(mediabunny.state.source?.close).toHaveBeenCalledOnce();
    expect(mediabunny.state.output?.finalize).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "finalizing", progress: 1 }));
    expect(context.font).toContain("Arial");
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("cancels the muxer and rejects without producing a result", async () => {
    const { canvas } = createCanvas();
    const controller = new AbortController();
    let frames = 0;

    await expect(encodeGaussianVideo({
      canvas,
      logo: canvas,
      signal: controller.signal,
      renderFrameAt: async () => {
        frames += 1;
        controller.abort();
      },
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(frames).toBe(1);
    expect(mediabunny.state.output?.cancel).toHaveBeenCalled();
    expect(mediabunny.state.output?.finalize).not.toHaveBeenCalled();
  });
});
