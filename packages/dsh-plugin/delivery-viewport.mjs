// A reported host iframe size is optional. Never pass arbitrary context properties
// to Chromium, and never describe a fallback size as a measured host viewport.
export function normalizeDeliveryViewport(value) {
  if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height)) return null;
  if (value.width < 240 || value.width > 3840 || value.height < 240 || value.height > 2160) return null;
  return {width:Math.round(value.width),height:Math.round(value.height)};
}

