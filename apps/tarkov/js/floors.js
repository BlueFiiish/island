// Floor classification for map markers.
//
// Loaded two ways on purpose: as a plain <script> in the renderer (no bundler,
// CSP script-src 'self') and via require() from the node tests. Hence the
// factory + globalThis/module.exports tail rather than ESM.
//
// THE RULE (and why it is deliberately timid):
// tarkov.dev's layer extents come in two shapes. Some carry an xz `bounds` box
// listing the building the floor covers ("dome", "white bishop", ...). Others
// carry ONLY a height band, which spans the WHOLE map at that altitude - on
// Shoreline, Factory and Streets that swallows hundreds of outdoor markers
// (extracts included) that are not in a building at all.
//
// So a marker is only ever declared to be on another floor when a BOUNDED
// extent proves it: the height matches AND the xz point falls inside one of
// that extent's boxes. A height-only match proves nothing and is ignored.
// Anything unconfirmed counts as on-floor and is never dimmed. False negatives
// (a real off-floor marker drawn at full strength) are harmless; false
// positives fade markers you need.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PilotFloors = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function insideBox(box, p) {
    // each box is [[x1, z1], [x2, z2], "name"] in game coords; corners are in
    // no guaranteed order, so normalise before comparing
    const a = box && box[0];
    const b = box && box[1];
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (!Number.isFinite(a[0]) || !Number.isFinite(a[1])) return false;
    if (!Number.isFinite(b[0]) || !Number.isFinite(b[1])) return false;
    const inX = p.x >= Math.min(a[0], b[0]) && p.x <= Math.max(a[0], b[0]);
    const inZ = p.z >= Math.min(a[1], b[1]) && p.z <= Math.max(a[1], b[1]);
    return inX && inZ;
  }

  // Height bands are INCLUSIVE at both ends - a marker sitting exactly on a
  // floor's slab must count as being on it.
  function inHeightBand(height, y) {
    if (!Array.isArray(height) || height.length < 2) return false;
    if (!Number.isFinite(height[0]) || !Number.isFinite(height[1])) return false;
    return y >= Math.min(height[0], height[1]) && y <= Math.max(height[0], height[1]);
  }

  // The svgLayer id of the floor a position is CONFIRMED to sit on, or null
  // when nothing bounded claims it (which includes every base-level marker).
  function floorForPosition(mapData, p) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
    const layers = (mapData && mapData.layers) || [];
    for (const l of layers) {
      if (!l || !l.svgLayer) continue;
      for (const ext of l.extents || []) {
        if (!ext || !inHeightBand(ext.height, p.y)) continue;
        const boxes = ext.bounds;
        // height-only extent: covers the whole map, proves nothing. Skip it.
        if (!Array.isArray(boxes) || !boxes.length) continue;
        for (const box of boxes) if (insideBox(box, p)) return l.svgLayer;
      }
    }
    return null;
  }

  // True only when the position is CONFIRMED to belong to a floor other than
  // the one currently selected.
  function isOffFloor(mapData, currentFloor, p) {
    if (!currentFloor) return false;
    const floor = floorForPosition(mapData, p);
    return floor != null && floor !== currentFloor;
  }

  return { floorForPosition, isOffFloor, insideBox, inHeightBand };
}));
