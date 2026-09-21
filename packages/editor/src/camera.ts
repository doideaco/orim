export interface Camera {
  x: number; // world coord at screen origin
  y: number;
  zoom: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const toScreen = (cam: Camera, p: Point): Point => ({
  x: (p.x - cam.x) * cam.zoom,
  y: (p.y - cam.y) * cam.zoom,
});

export const toWorld = (cam: Camera, p: Point): Point => ({
  x: p.x / cam.zoom + cam.x,
  y: p.y / cam.zoom + cam.y,
});

/** Zoom about a fixed screen point so the world under the cursor stays put. */
export function zoomAt(cam: Camera, screen: Point, factor: number): Camera {
  const zoom = Math.min(4, Math.max(0.02, cam.zoom * factor));
  const before = toWorld(cam, screen);
  const next = { ...cam, zoom };
  const after = toWorld(next, screen);
  return { zoom, x: cam.x + (before.x - after.x), y: cam.y + (before.y - after.y) };
}

export function visibleWorldRect(cam: Camera, width: number, height: number) {
  const tl = toWorld(cam, { x: 0, y: 0 });
  const br = toWorld(cam, { x: width, y: height });
  return { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y };
}

/** Camera that fits `bounds` into a viewport with padding. */
export function cameraToFit(
  bounds: Rect,
  viewportW: number,
  viewportH: number,
  padding = 64,
): Camera {
  const zoom = Math.min(
    4,
    Math.max(
      0.02,
      Math.min(
        (viewportW - padding * 2) / Math.max(1, bounds.w),
        (viewportH - padding * 2) / Math.max(1, bounds.h),
      ),
    ),
  );
  return {
    zoom,
    x: bounds.x + bounds.w / 2 - viewportW / 2 / zoom,
    y: bounds.y + bounds.h / 2 - viewportH / 2 / zoom,
  };
}
