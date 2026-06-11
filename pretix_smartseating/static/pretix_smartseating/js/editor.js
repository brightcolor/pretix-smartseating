(function () {
  const host = document.getElementById("smartseat-editor");
  if (!host) return;

  const width = Number(host.dataset.width || 1200);
  const height = Number(host.dataset.height || 800);
  // Event products the editor can attach to a "product area" (standing/GA region).
  let PRODUCTS = [];
  try { PRODUCTS = JSON.parse(document.getElementById("smartseat-products")?.textContent || "[]"); } catch (_) { PRODUCTS = []; }
  const saveUrl = host.dataset.saveUrl;
  const exportUrl = host.dataset.exportUrl;
  const assetsUrl = host.dataset.assetsUrl;
  const assetsUploadUrl = host.dataset.assetsUploadUrl;
  const assetsUpdateUrlTemplate = host.dataset.assetsUpdateUrlTemplate;
  const assetsDeleteUrlTemplate = host.dataset.assetsDeleteUrlTemplate;
  const csrf = host.dataset.csrf;
  const templateList = document.getElementById("smartseat-template-list");
  const templateUploadForm = document.getElementById("smartseat-template-upload-form");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  host.appendChild(svg);

  // --- Pan / zoom / viewport-culling ----------------------------------------
  // The visible region is expressed as a viewBox. draw() only renders seats
  // inside it (+ margin), so very large plans stay responsive: rendering cost
  // scales with what's on screen, not with the total seat count.
  const MIN_VIEW = 60;
  const MAX_VIEW_FACTOR = 4;
  const LABEL_SEAT_LIMIT = 400; // skip per-seat text labels above this many visible seats
  const view = { x: 0, y: 0, w: width, h: height };
  let drawScheduled = false;

  const applyViewBox = () => {
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  };
  applyViewBox();

  // Effective canvas size (editable via the Plan tab) + clamps so nothing can
  // be dragged / resized / placed outside the defined canvas area.
  const canvasW = () => Number((state && state.bounds && state.bounds.width) || width);
  const canvasH = () => Number((state && state.bounds && state.bounds.height) || height);
  const clampX = (x) => Math.max(0, Math.min(canvasW(), x));
  const clampY = (y) => Math.max(0, Math.min(canvasH(), y));

  // How far an area extends from its `position` in local (unrotated) space.
  // Used to clamp dragging/resizing so an area can't poke outside the canvas.
  const areaLocalExtent = (area) => {
    if (area.shape === "rectangle" && area.rectangle) {
      return { left: 0, right: area.rectangle.width || 0, top: 0, bottom: area.rectangle.height || 0 };
    }
    if (area.shape === "circle" && area.circle) {
      const r = area.circle.radius || 0;
      return { left: -r, right: r, top: -r, bottom: r };
    }
    if (area.shape === "ellipse" && area.ellipse) {
      const rx = area.ellipse.radius?.x || 0, ry = area.ellipse.radius?.y || 0;
      return { left: -rx, right: rx, top: -ry, bottom: ry };
    }
    return { left: 0, right: 0, top: 0, bottom: 0 };
  };
  // Clamp an area position so its (unrotated) extent stays within the canvas.
  const clampAreaPos = (area, x, y) => {
    const e = areaLocalExtent(area);
    const nx = Math.max(-e.left, Math.min(canvasW() - e.right, x));
    const ny = Math.max(-e.top, Math.min(canvasH() - e.bottom, y));
    return { x: e.right - e.left > canvasW() ? -e.left : nx, y: e.bottom - e.top > canvasH() ? -e.top : ny };
  };

  const scheduleDraw = () => {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(() => {
      drawScheduled = false;
      draw();
    });
  };

  // Exact screen->user mapping using the live CTM. This accounts for the
  // viewBox AND preserveAspectRatio letterboxing, so the marquee, drag and
  // zoom focus stay perfectly in sync with the cursor even when the SVG
  // element's aspect ratio differs from the viewBox.
  const clientToSvg = (clientX, clientY) => {
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: view.x, y: view.y };
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  // Screen pixels per user unit for the current zoom (constant during a pan).
  const screenScale = () => {
    const ctm = svg.getScreenCTM();
    return { sx: ctm ? ctm.a : 1, sy: ctm ? ctm.d : 1 };
  };

  const resetView = () => {
    const bounds = (state && state.bounds) ? state.bounds : { width, height };
    view.x = 0;
    view.y = 0;
    view.w = Number(bounds.width) || width;
    view.h = Number(bounds.height) || height;
    applyViewBox();
    scheduleDraw();
  };

  // Zoom the viewport onto one area (used for "enter section"). Rotation is
  // ignored for the fit — close enough for navigation.
  const fitViewToArea = (area) => {
    const geom = areaLocalGeom(area);
    if (!geom || !geom.bb) return;
    const px = Number(area.position?.x || 0), py = Number(area.position?.y || 0);
    const pad = 40;
    view.x = px + geom.bb.x0 - pad;
    view.y = py + geom.bb.y0 - pad;
    view.w = (geom.bb.x1 - geom.bb.x0) + pad * 2;
    view.h = (geom.bb.y1 - geom.bb.y0) + pad * 2;
    applyViewBox();
    scheduleDraw();
  };

  svg.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 0.85 : 1.18;
      const focus = clientToSvg(event.clientX, event.clientY);
      const maxW = width * MAX_VIEW_FACTOR;
      const maxH = height * MAX_VIEW_FACTOR;
      const newW = Math.min(Math.max(view.w * factor, MIN_VIEW), maxW);
      const newH = Math.min(Math.max(view.h * factor, MIN_VIEW), maxH);
      // Keep the point under the cursor stationary while zooming.
      view.x = focus.x - (focus.x - view.x) * (newW / view.w);
      view.y = focus.y - (focus.y - view.y) * (newH / view.h);
      view.w = newW;
      view.h = newH;
      applyViewBox();
      scheduleDraw();
    },
    { passive: false }
  );

  // ─── Unified pointer interaction ──────────────────────────────────────────
  // Left-drag on empty canvas  → rubber-band selection
  // Middle-mouse drag          → pan
  // Space + left-drag          → pan
  // Left-drag on a seat        → move seat(s)
  // Left-click on seat         → select / Shift = toggle
  // Left-click on empty canvas → deselect all
  // Double-click               → reset view
  // ──────────────────────────────────────────────────────────────────────────
  const DRAG_THRESHOLD = 4; // client-px before a click becomes a drag

  // Rubber-band overlay rect – re-appended to SVG top after every draw().
  const rubberRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rubberRect.setAttribute("fill", "rgba(0,85,204,0.08)");
  rubberRect.setAttribute("stroke", "#0055cc");
  rubberRect.setAttribute("stroke-width", "1");
  rubberRect.setAttribute("stroke-dasharray", "5 3");
  rubberRect.setAttribute("display", "none");
  rubberRect.setAttribute("pointer-events", "none");

  // Alignment guide lines (shown while dragging seats).
  const mkGuide = () => {
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("class", "smartseat-guide");
    l.setAttribute("display", "none");
    l.setAttribute("pointer-events", "none");
    return l;
  };
  const guideV = mkGuide();
  const guideH = mkGuide();
  const ALIGN_TOL = 5; // user units: snap to a neighbour's x/y within this distance
  const hideGuides = () => { guideV.setAttribute("display", "none"); guideH.setAttribute("display", "none"); };
  const nearest = (vals, target) => {
    let best = null, bestD = ALIGN_TOL + 1;
    for (const v of vals) { const d = Math.abs(v - target); if (d < bestD) { bestD = d; best = v; } }
    return best;
  };

  let spaceDown = false;
  let pointerMode = null; // 'pan' | 'rubber' | 'seat-wait' | 'seat-drag'
  let pointerData = {};
  let activeTool = "select";
  // Photoshop-style: the group we have "entered" via double-click. While set,
  // clicks select individual seats inside it; clicking elsewhere / Esc exits.
  let activeGroup = null;
  // When set (by a click-to-place on the canvas), generators anchor here
  // instead of the viewport centre / the sidebar's X/Y fields.
  let placePoint = null;
  // Polygon / curve tool: vertices placed so far + the live cursor point.
  let polyPoints = null;
  let polyCursor = null;
  let polyMode = "polygon"; // "polygon" (straight edges) | "curve" (smooth)
  let lastNudge = 0; // timestamp, to coalesce arrow-key nudges into one undo step
  const isPolyTool = () => activeTool === "polygon" || activeTool === "curve";
  // Creation tools → the action they trigger when you click on the canvas.
  const GENERATOR_TOOLS = {
    row: "add-row", block: "generate-block", arc: "generate-arc",
    table: "generate-table", stage: "add-stage", round: "add-ellipse",
    label: "add-label", sector: "generate-sector", focal: "set-focal",
  };

  window.addEventListener("keydown", (e) => {
    if (e.key === " " && document.activeElement === document.body) {
      e.preventDefault();
      spaceDown = true;
      svg.classList.add("smartseat-space");
    }
    // Enter finishes a polygon/curve that's being drawn.
    if (e.key === "Enter" && isPolyTool() && polyPoints) {
      e.preventDefault();
      finalizePolygon();
      return;
    }
    // Esc: cancel a polygon draft, then leave an entered group, then a tool.
    if (e.key === "Escape") {
      if (isPolyTool() && polyPoints) {
        cancelPolygon();
      } else if (activeGroup) {
        activeGroup = null;
        selected = new Set();
        scheduleDraw();
      } else if (activeTool !== "select" && typeof setTool === "function") {
        setTool("select");
      }
    }
    // Copy / paste the seat selection (ignored while typing in a field).
    const inField = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName || "");
    if ((e.ctrlKey || e.metaKey) && !inField) {
      const k = e.key.toLowerCase();
      if (k === "c") { copySelection(); return; }
      if (k === "v") { e.preventDefault(); pasteClipboard(); return; }
      if (k === "d") { e.preventDefault(); duplicateSelected(); return; }
    }
    // Arrow keys nudge the current selection (Shift = 10×). Precise positioning.
    if (e.key.indexOf("Arrow") === 0) {
      const tag = document.activeElement?.tagName || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const hasSel = selected.size > 0, hasArea = selectedArea !== null;
      if (!hasSel && !hasArea) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      let dx = 0, dy = 0;
      if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      else if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "ArrowDown") dy = step;
      else return;
      const now = Date.now();
      if (now - lastNudge > 400) saveSnapshot();
      lastNudge = now;
      if (hasArea) {
        const a = state.areas[selectedArea];
        a.position = clampAreaPos(a, Number(a.position?.x || 0) + dx, Number(a.position?.y || 0) + dy);
      } else {
        let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
        for (const s of state.seats) if (selected.has(s.external_id)) {
          mnx = Math.min(mnx, s.x); mxx = Math.max(mxx, s.x);
          mny = Math.min(mny, s.y); mxy = Math.max(mxy, s.y);
        }
        dx = Math.max(-mnx, Math.min(canvasW() - mxx, dx));
        dy = Math.max(-mny, Math.min(canvasH() - mxy, dy));
        for (const s of state.seats) if (selected.has(s.external_id)) { s.x += dx; s.y += dy; }
        // Move linked areas (e.g. a table shape) with the selection.
        linkedAreasForSelection().forEach((da) => {
          const a = state.areas[da.idx];
          if (a) a.position = { x: da.x + dx, y: da.y + dy };
        });
      }
      scheduleDraw();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === " ") {
      spaceDown = false;
      svg.classList.remove("smartseat-space");
    }
  });

  svg.addEventListener("pointerdown", (event) => {
    // Middle-mouse or Space+left → pan
    if (event.button === 1 || (event.button === 0 && spaceDown)) {
      pointerMode = "pan";
      const sc = screenScale();
      pointerData = {
        startX: event.clientX, startY: event.clientY,
        viewX: view.x, viewY: view.y, sx: sc.sx, sy: sc.sy,
      };
      svg.setPointerCapture(event.pointerId);
      svg.classList.add("smartseat-panning");
      return;
    }
    if (event.button !== 0) return;

    const svgPt = clientToSvg(event.clientX, event.clientY);

    // Polygon / curve tool: every click drops a point (clicking the first point
    // again closes the shape). Handled before everything else so it works over
    // seats. Curve mode smooths the points into a rounded outline on finish.
    if (isPolyTool()) {
      if (!polyPoints) polyMode = activeTool === "curve" ? "curve" : "polygon";
      const pt = { x: clampX(snap(svgPt.x)), y: clampY(snap(svgPt.y)) };
      if (polyPoints && polyPoints.length >= 3) {
        const f = polyPoints[0];
        const near = Math.hypot(pt.x - f.x, pt.y - f.y) * (screenScale().sx || 1);
        if (near < 12) { finalizePolygon(); return; }
      }
      if (!polyPoints) polyPoints = [];
      polyPoints.push(pt);
      polyCursor = pt;
      scheduleDraw();
      return;
    }

    // Rotation handle (area or seat selection) takes top priority.
    const rotEl = event.target?.closest?.("[data-rotate]");
    if (rotEl) {
      svg.setPointerCapture(event.pointerId);
      const kind = rotEl.getAttribute("data-rotate");
      if (kind === "area" && selectedArea !== null) {
        const a = state.areas[selectedArea];
        const pivot = { x: Number(a.position?.x || 0), y: Number(a.position?.y || 0) };
        pointerMode = "rotate-area";
        pointerData = {
          pivot, startAngle: Math.atan2(svgPt.y - pivot.y, svgPt.x - pivot.x),
          origRot: Number(a.rotation || 0), snapshotted: false,
        };
      } else if (kind === "seats") {
        const sel = state.seats.filter((s) => selected.has(s.external_id));
        let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
        sel.forEach((s) => { mnx = Math.min(mnx, s.x); mxx = Math.max(mxx, s.x); mny = Math.min(mny, s.y); mxy = Math.max(mxy, s.y); });
        const pivot = { x: (mnx + mxx) / 2, y: (mny + mxy) / 2 };
        pointerMode = "rotate-seats";
        pointerData = {
          pivot, startAngle: Math.atan2(svgPt.y - pivot.y, svgPt.x - pivot.x),
          orig: sel.map((s) => ({ id: s.external_id, x: s.x, y: s.y })), snapshotted: false,
        };
      }
      return;
    }

    // Resize handle of the selected area takes priority over seats/canvas.
    const handleEl = event.target?.closest?.("[data-handle]");
    if (handleEl && selectedArea !== null) {
      const area = state.areas[selectedArea];
      if (area) {
        svg.setPointerCapture(event.pointerId);
        pointerMode = "area-resize";
        pointerData = {
          dir: handleEl.getAttribute("data-handle"),
          areaIndex: selectedArea,
          start: svgPt,
          orig: JSON.parse(JSON.stringify(area)),
          snapshotted: false,
        };
        return;
      }
    }

    const seatId = event.target?.getAttribute("data-id");

    if (seatId) {
      // Seat interaction – wait to see if this becomes a drag or just a click.
      svg.setPointerCapture(event.pointerId);
      const seat = state.seats.find((s) => s.external_id === seatId);
      if (!seat) return;
      pointerMode = "seat-wait";
      pointerData = {
        seat,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startSvgX: svgPt.x,
        startSvgY: svgPt.y,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
      };
      return;
    }

    const areaEl = event.target?.closest?.("[data-area-index]");
    if (areaEl) {
      svg.setPointerCapture(event.pointerId);
      pointerMode = "area-wait";
      pointerData = {
        areaIndex: parseInt(areaEl.getAttribute("data-area-index"), 10),
        node: areaEl,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startSvgX: svgPt.x,
        startSvgY: svgPt.y,
      };
      return;
    }

    if (event.target === svg) {
      // A creation tool is active → click-to-place at the cursor.
      const action = GENERATOR_TOOLS[activeTool];
      if (action) {
        placePoint = { x: clampX(snap(svgPt.x)), y: clampY(snap(svgPt.y)) };
        handleAction(action);
        placePoint = null;
        return; // consumed: no rubber-band, no pointer capture
      }
      // Select tool on empty canvas – start rubber-band.
      svg.setPointerCapture(event.pointerId);
      pointerMode = "rubber";
      pointerData = { startClientX: event.clientX, startClientY: event.clientY, startSvgX: svgPt.x, startSvgY: svgPt.y };
    }
  });

  svg.addEventListener("pointermove", (event) => {
    // Polygon / curve tool: rubber-line preview from the last point to cursor.
    if (isPolyTool() && polyPoints && polyPoints.length) {
      const p = clientToSvg(event.clientX, event.clientY);
      polyCursor = { x: clampX(p.x), y: clampY(p.y) };
      scheduleDraw();
      return;
    }
    if (!pointerMode) return;

    if (pointerMode === "pan") {
      // Convert the screen delta to user units via the scale captured at start.
      const dx = (event.clientX - pointerData.startX) / (pointerData.sx || 1);
      const dy = (event.clientY - pointerData.startY) / (pointerData.sy || 1);
      view.x = pointerData.viewX - dx;
      view.y = pointerData.viewY - dy;
      applyViewBox();
      scheduleDraw();
      return;
    }

    if (pointerMode === "rubber") {
      const moved = Math.hypot(event.clientX - pointerData.startClientX, event.clientY - pointerData.startClientY);
      if (moved < DRAG_THRESHOLD) return;
      const cur = clientToSvg(event.clientX, event.clientY);
      const rx = Math.min(pointerData.startSvgX, cur.x);
      const ry = Math.min(pointerData.startSvgY, cur.y);
      rubberRect.setAttribute("x", rx);
      rubberRect.setAttribute("y", ry);
      rubberRect.setAttribute("width", Math.abs(cur.x - pointerData.startSvgX));
      rubberRect.setAttribute("height", Math.abs(cur.y - pointerData.startSvgY));
      rubberRect.setAttribute("display", "");
      return;
    }

    if (pointerMode === "seat-wait" || pointerMode === "seat-drag") {
      const moved = Math.hypot(event.clientX - pointerData.startClientX, event.clientY - pointerData.startClientY);
      if (moved < DRAG_THRESHOLD && pointerMode === "seat-wait") return;

      if (pointerMode === "seat-wait") {
        // Elevate to drag: make the dragged seat (or its whole group) selected.
        if (!selected.has(pointerData.seat.external_id)) {
          selected = new Set(groupAwareIds(pointerData.seat.external_id, pointerData.altKey));
          scheduleDraw();
        }
        // Alt+drag duplicates the selection and drags the copies away
        // (Excalidraw-style); the originals stay put.
        if (pointerData.altKey && selected.size) {
          saveSnapshot();
          const usedIds = existingExternalIds();
          const copies = [];
          state.seats.forEach((s) => {
            if (!selected.has(s.external_id)) return;
            copies.push(createSeat({ ...s, external_id: makeUniqueExternalId(s.external_id + "-copy", usedIds) }));
          });
          state.seats = state.seats.concat(copies);
          selected = new Set(copies.map((s) => s.external_id));
          draw(); // synchronous: the copies need rendered nodes to drag
        }
        // Snapshot positions of all selected seats at drag start + collect the
        // x/y of all *other* seats as alignment guide candidates.
        pointerData.origPositions = {};
        const axs = [], ays = [];
        let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
        for (const s of state.seats) {
          if (selected.has(s.external_id)) {
            pointerData.origPositions[s.external_id] = { x: s.x, y: s.y };
            mnx = Math.min(mnx, s.x); mxx = Math.max(mxx, s.x);
            mny = Math.min(mny, s.y); mxy = Math.max(mxy, s.y);
          } else {
            axs.push(s.x); ays.push(s.y);
          }
        }
        // Rhythm candidates: continue equal spacing (e.g. row pitch) — for every
        // adjacent pair of existing x/y positions, the "next step" also snaps.
        const rhythm = (vals) => {
          const uniq = [...new Set(vals.map((v) => Math.round(v)))].sort((a, b) => a - b);
          const out = [];
          for (let i = 1; i < uniq.length; i++) {
            const gap = uniq[i] - uniq[i - 1];
            if (gap >= 8 && gap <= 200) { out.push(uniq[i] + gap); out.push(uniq[i - 1] - gap); }
          }
          return out;
        };
        pointerData.alignXs = axs.concat(rhythm(axs));
        pointerData.alignYs = ays.concat(rhythm(ays));
        pointerData.dragBBox = { mnx, mny, mxx, mxy };
        pointerData.dragAreas = linkedAreasForSelection();
        svg.classList.add("smartseat-dragging");
        pointerMode = "seat-drag";
      }

      // Compute snapped delta (snap via lead seat so group stays coherent).
      const cur = clientToSvg(event.clientX, event.clientY);
      const rawDx = cur.x - pointerData.startSvgX;
      const rawDy = cur.y - pointerData.startSvgY;
      const leadOrig = pointerData.origPositions[pointerData.seat.external_id];
      let effDx = snap(leadOrig.x + rawDx) - leadOrig.x;
      let effDy = snap(leadOrig.y + rawDy) - leadOrig.y;

      // Alignment guides: snap the lead seat to a neighbour's x / y when close.
      const ax = nearest(pointerData.alignXs, leadOrig.x + effDx);
      const ay = nearest(pointerData.alignYs, leadOrig.y + effDy);
      if (ax !== null) {
        effDx = ax - leadOrig.x;
        guideV.setAttribute("x1", ax); guideV.setAttribute("x2", ax);
        guideV.setAttribute("y1", view.y); guideV.setAttribute("y2", view.y + view.h);
        guideV.setAttribute("display", "");
      } else { guideV.setAttribute("display", "none"); }
      if (ay !== null) {
        effDy = ay - leadOrig.y;
        guideH.setAttribute("y1", ay); guideH.setAttribute("y2", ay);
        guideH.setAttribute("x1", view.x); guideH.setAttribute("x2", view.x + view.w);
        guideH.setAttribute("display", "");
      } else { guideH.setAttribute("display", "none"); }

      // Keep the whole selection inside the canvas (no falling off the edge).
      const bb = pointerData.dragBBox;
      if (bb) {
        effDx = Math.max(-bb.mnx, Math.min(canvasW() - bb.mxx, effDx));
        effDy = Math.max(-bb.mny, Math.min(canvasH() - bb.mxy, effDy));
      }

      // Remember the committed delta so pointerup can move *all* selected seats
      // (including ones culled out of the DOM), not just the rendered nodes.
      pointerData.effDx = effDx;
      pointerData.effDy = effDy;

      // Move circle nodes directly (fast – no full redraw on every pixel).
      for (const s of state.seats) {
        if (!selected.has(s.external_id)) continue;
        const orig = pointerData.origPositions[s.external_id];
        if (!orig) continue;
        const node = renderedNodes.get(s.external_id);
        if (node) {
          node.setAttribute("cx", orig.x + effDx);
          node.setAttribute("cy", orig.y + effDy);
        }
      }
      // Move linked areas (e.g. a table shape) live with the selection.
      (pointerData.dragAreas || []).forEach((da) => {
        const a = state.areas[da.idx];
        const node = svg.querySelector('[data-area-index="' + da.idx + '"]');
        if (a && node) node.setAttribute("transform",
          `translate(${da.x + effDx} ${da.y + effDy}) rotate(${Number(a.rotation || 0)})`);
      });
      updateGroupOutlinesLive(); // keep group boundaries glued to their seats
      return;
    }

    if (pointerMode === "area-wait" || pointerMode === "area-drag") {
      const moved = Math.hypot(event.clientX - pointerData.startClientX, event.clientY - pointerData.startClientY);
      if (moved < DRAG_THRESHOLD && pointerMode === "area-wait") return;
      const area = state.areas[pointerData.areaIndex];
      if (!area) return;
      if (pointerMode === "area-wait") {
        pointerData.orig = { x: Number(area.position?.x || 0), y: Number(area.position?.y || 0) };
        svg.classList.add("smartseat-dragging");
        pointerMode = "area-drag";
      }
      const cur = clientToSvg(event.clientX, event.clientY);
      const raw = clampAreaPos(area,
        snap(pointerData.orig.x + (cur.x - pointerData.startSvgX)),
        snap(pointerData.orig.y + (cur.y - pointerData.startSvgY)));
      const nx = raw.x, ny = raw.y;
      pointerData.pendingPos = { x: nx, y: ny };
      if (pointerData.node) {
        pointerData.node.setAttribute("transform", `translate(${nx} ${ny}) rotate(${Number(area.rotation || 0)})`);
      }
      return;
    }

    if (pointerMode === "area-resize") {
      const area = state.areas[pointerData.areaIndex];
      if (!area) return;
      if (!pointerData.snapshotted) { saveSnapshot(); pointerData.snapshotted = true; }
      const orig = pointerData.orig;
      const cur = clientToSvg(event.clientX, event.clientY);
      const th = (Number(orig.rotation || 0) * Math.PI) / 180;
      const cos = Math.cos(th), sin = Math.sin(th);
      const dir = pointerData.dir;
      const MIN = 10;
      if (area.shape === "rectangle") {
        const dxw = cur.x - pointerData.start.x;
        const dyw = cur.y - pointerData.start.y;
        const ldx = cos * dxw + sin * dyw; // rotate delta into local frame R(-θ)
        const ldy = -sin * dxw + cos * dyw;
        let w = orig.rectangle.width, h = orig.rectangle.height, lox = 0, loy = 0;
        if (dir.includes("w")) { w = orig.rectangle.width - ldx; lox = ldx; }
        if (dir.includes("e")) { w = orig.rectangle.width + ldx; }
        if (dir.includes("n")) { h = orig.rectangle.height - ldy; loy = ldy; }
        if (dir.includes("s")) { h = orig.rectangle.height + ldy; }
        w = Math.max(MIN, w); h = Math.max(MIN, h);
        const wx = cos * lox - sin * loy; // local origin shift back to world R(θ)
        const wy = sin * lox + cos * loy;
        area.rectangle.width = w; area.rectangle.height = h;
        area.position = { x: orig.position.x + wx, y: orig.position.y + wy };
      } else {
        // circle / ellipse: anchored at centre, radius follows the cursor.
        const rcx = cur.x - orig.position.x, rcy = cur.y - orig.position.y;
        const lx = Math.abs(cos * rcx + sin * rcy);
        const ly = Math.abs(-sin * rcx + cos * rcy);
        if (area.shape === "circle") {
          const r = dir === "n" || dir === "s" ? ly : dir === "e" || dir === "w" ? lx : Math.max(lx, ly);
          area.circle.radius = Math.max(MIN, r);
        } else if (area.shape === "ellipse") {
          let rx = orig.ellipse.radius.x, ry = orig.ellipse.radius.y;
          if (dir.includes("e") || dir.includes("w")) rx = lx;
          if (dir.includes("n") || dir.includes("s")) ry = ly;
          area.ellipse.radius = { x: Math.max(MIN, rx), y: Math.max(MIN, ry) };
        }
      }
      // Keep the resized area inside the canvas (axis-aligned areas only).
      if (Math.abs(Number(area.rotation || 0)) < 0.5) {
        const W = canvasW(), H = canvasH();
        if (area.shape === "rectangle") {
          let px = area.position.x, py = area.position.y;
          let w = area.rectangle.width, h = area.rectangle.height;
          if (px < 0) { w += px; px = 0; }
          if (py < 0) { h += py; py = 0; }
          area.rectangle.width = Math.max(MIN, Math.min(w, W - px));
          area.rectangle.height = Math.max(MIN, Math.min(h, H - py));
          area.position = { x: px, y: py };
        } else if (area.shape === "circle") {
          const cx = area.position.x, cy = area.position.y;
          const maxR = Math.min(cx, W - cx, cy, H - cy);
          area.circle.radius = Math.max(MIN, Math.min(area.circle.radius, maxR));
        } else if (area.shape === "ellipse") {
          const cx = area.position.x, cy = area.position.y;
          area.ellipse.radius = {
            x: Math.max(MIN, Math.min(area.ellipse.radius.x, cx, W - cx)),
            y: Math.max(MIN, Math.min(area.ellipse.radius.y, cy, H - cy)),
          };
        }
      }
      scheduleDraw();
      return;
    }

    if (pointerMode === "rotate-area") {
      const a = state.areas[selectedArea];
      if (!a) return;
      if (!pointerData.snapshotted) { saveSnapshot(); pointerData.snapshotted = true; }
      const cur = clientToSvg(event.clientX, event.clientY);
      const ang = Math.atan2(cur.y - pointerData.pivot.y, cur.x - pointerData.pivot.x);
      let deg = pointerData.origRot + ((ang - pointerData.startAngle) * 180) / Math.PI;
      if (event.shiftKey) deg = Math.round(deg / 15) * 15;
      a.rotation = Math.round(deg * 10) / 10;
      scheduleDraw();
      return;
    }

    if (pointerMode === "rotate-seats") {
      if (!pointerData.snapshotted) { saveSnapshot(); pointerData.snapshotted = true; }
      const cur = clientToSvg(event.clientX, event.clientY);
      let delta = Math.atan2(cur.y - pointerData.pivot.y, cur.x - pointerData.pivot.x) - pointerData.startAngle;
      if (event.shiftKey) delta = (Math.round((delta * 180 / Math.PI) / 15) * 15) * Math.PI / 180;
      const cosd = Math.cos(delta), sind = Math.sin(delta);
      pointerData.orig.forEach((o) => {
        const seat = state.seats.find((s) => s.external_id === o.id);
        if (!seat) return;
        const dx = o.x - pointerData.pivot.x, dy = o.y - pointerData.pivot.y;
        seat.x = pointerData.pivot.x + dx * cosd - dy * sind;
        seat.y = pointerData.pivot.y + dx * sind + dy * cosd;
      });
      scheduleDraw();
      return;
    }
  });

  const endPointer = (event) => {
    if (!pointerMode) return;
    try { svg.releasePointerCapture(event.pointerId); } catch (_) {}

    if (pointerMode === "pan") {
      pointerMode = null;
      svg.classList.remove("smartseat-panning");
      return;
    }

    if (pointerMode === "rubber") {
      pointerMode = null;
      rubberRect.setAttribute("display", "none");
      const moved = Math.hypot(event.clientX - pointerData.startClientX, event.clientY - pointerData.startClientY);
      if (moved < DRAG_THRESHOLD) {
        // Treated as a click on the canvas → clear selection and leave group.
        if (selected.size || selectedArea !== null || activeGroup) {
          selected = new Set();
          selectedArea = null;
          activeGroup = null;
          scheduleDraw();
        }
        return;
      }
      // Select seats inside the rectangle.
      const rx = parseFloat(rubberRect.getAttribute("x"));
      const ry = parseFloat(rubberRect.getAttribute("y"));
      const rw = parseFloat(rubberRect.getAttribute("width"));
      const rh = parseFloat(rubberRect.getAttribute("height"));
      const newSel = new Set();
      for (const s of state.seats) {
        if (s.x >= rx && s.x <= rx + rw && s.y >= ry && s.y <= ry + rh) newSel.add(s.external_id);
      }
      selected = newSel;
      scheduleDraw();
      if (newSel.size) setSidebarTab("edit");
      return;
    }

    if (pointerMode === "seat-wait") {
      // Pure click – update selection.
      pointerMode = null;
      if (selectedArea !== null) {
        selectedArea = null;
        scheduleDraw();
      }
      if (pointerData.shiftKey) {
        const ids = groupAwareIds(pointerData.seat.external_id, pointerData.altKey);
        const allSelected = ids.every((id) => selected.has(id));
        ids.forEach((id) => { allSelected ? selected.delete(id) : selected.add(id); });
        scheduleDraw();
      } else {
        selected = new Set(groupAwareIds(pointerData.seat.external_id, pointerData.altKey));
        scheduleDraw();
      }
      refreshInspector();
      if (selected.size) setSidebarTab("edit");
      return;
    }

    if (pointerMode === "seat-drag") {
      pointerMode = null;
      svg.classList.remove("smartseat-dragging");
      hideGuides();
      // Commit new positions for ALL selected seats from their drag-start
      // positions + the final delta. Using origPositions (not the rendered
      // nodes) keeps seats that were culled out of the DOM moving with the
      // group, so the selection never splits and the outline stays correct.
      const dx = pointerData.effDx || 0, dy = pointerData.effDy || 0;
      if (dx || dy) {
        saveSnapshot();
        for (const s of state.seats) {
          if (!selected.has(s.external_id)) continue;
          const orig = pointerData.origPositions[s.external_id];
          if (!orig) continue;
          s.x = orig.x + dx;
          s.y = orig.y + dy;
        }
        (pointerData.dragAreas || []).forEach((da) => {
          const a = state.areas[da.idx];
          if (a) a.position = { x: da.x + dx, y: da.y + dy };
        });
      }
      scheduleDraw(); // full redraw syncs labels, text, etc.
      return;
    }

    if (pointerMode === "area-wait") {
      // Pure click → select this area (and clear seat selection).
      pointerMode = null;
      selectedArea = pointerData.areaIndex;
      selected = new Set();
      draw();
      setSidebarTab("edit");
      return;
    }

    if (pointerMode === "area-drag") {
      pointerMode = null;
      svg.classList.remove("smartseat-dragging");
      const area = state.areas[pointerData.areaIndex];
      if (area && pointerData.pendingPos) {
        saveSnapshot();
        area.position = pointerData.pendingPos;
      }
      selectedArea = pointerData.areaIndex;
      draw();
      return;
    }

    if (pointerMode === "area-resize") {
      pointerMode = null;
      draw(); // sync inspector fields with the new size
      return;
    }

    if (pointerMode === "rotate-area" || pointerMode === "rotate-seats") {
      pointerMode = null;
      draw();
      return;
    }

    pointerMode = null;
  };

  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);
  svg.addEventListener("dblclick", (event) => {
    // Finishing a polygon/curve takes priority while that tool is drawing.
    if (isPolyTool() && polyPoints) { finalizePolygon(); return; }

    // Double-click a section area → zoom into it (seats.io-style sections).
    const areaEl2 = event.target?.closest?.("[data-area-index]");
    if (areaEl2) {
      const a = state.areas[parseInt(areaEl2.getAttribute("data-area-index"), 10)];
      if (a && a.role === "section") { fitViewToArea(a); return; }
    }

    // Enter a group to edit single seats. Forgiving: works when double-clicking
    // a grouped seat OR anywhere inside the group's outline (e.g. the table in
    // the middle, the gaps between seats).
    const seatId = event.target?.getAttribute?.("data-id");
    let g = seatId ? topGroupForSeat(seatId) : null;
    let pick = g ? seatId : null;
    if (!g) {
      const p = clientToSvg(event.clientX, event.clientY);
      for (const grp of (state.groups || []).filter((x) => !x.parent)) {
        const bb = groupBBox(grp, false);
        if (!bb) continue;
        if (p.x >= bb.mnx - GROUP_PAD && p.x <= bb.mxx + GROUP_PAD &&
            p.y >= bb.mny - GROUP_PAD && p.y <= bb.mxy + GROUP_PAD) {
          g = grp;
          // pick the group seat nearest the cursor so the inspector is useful
          let best = null, bd = Infinity;
          for (const id of groupSeatIds(grp)) {
            const s = state.seats.find((x) => x.external_id === id);
            if (!s) continue;
            const d = Math.hypot(s.x - p.x, s.y - p.y);
            if (d < bd) { bd = d; best = id; }
          }
          pick = best;
          break;
        }
      }
    }
    if (g) {
      activeGroup = g.id;
      selected = pick ? new Set([pick]) : new Set();
      selectedArea = null;
      draw();
      setSidebarTab("edit");
      return;
    }
    // Otherwise the double-click fits the plan to the viewport.
    resetView();
  });

  let state = {
    seats: [],
    areas: [],
    groups: [],
    zones: [{ name: "Main" }],
    template_assets: [],
    categories: [{ code: "standard", name: "Standard", color: "#3B82F6", price_rank: 100 }],
    bounds: { width, height },
    plan: { width, height, grid_size: 10, snap_enabled: true },
  };
  let selected = new Set();
  let selectedArea = null; // index into state.areas, or null
  let activeZone = "Main"; // seats are created in this zone (== block_label)
  const undoStack = [];
  const redoStack = [];

  const seatColor = (seat) => {
    if (seat.is_blocked || seat.is_technical_blocked) return "#8892a2";
    const category = state.categories.find((entry) => entry.code === seat.category_code);
    return category?.color || "#3B82F6";
  };

  const seatClass = (seat) => {
    const c = ["smartseat-seat"];
    if (selected.has(seat.external_id)) c.push("selected");
    if (seat.is_accessible || seat.seat_type === "wheelchair") c.push("accessible");
    if (seat.is_companion || seat.seat_type === "companion") c.push("companion");
    return c.join(" ");
  };

  const field = (name) => document.querySelector(`[data-field="${name}"]`);

  const buildAssetUrl = (template, assetId) => template.replace("/0/", `/${assetId}/`);

  const snap = (value) => {
    if (!state.plan.snap_enabled) return value;
    const grid = Number(state.plan.grid_size || 10);
    if (!grid) return value;
    return Math.round(value / grid) * grid;
  };

  const parseNumber = (name, fallback) => {
    const value = Number(field(name)?.value);
    return Number.isFinite(value) ? value : fallback;
  };

  const toLetters = (num) => {
    let n = Math.max(1, Math.floor(num));
    let out = "";
    while (n > 0) {
      const rem = (n - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  };

  const lettersToNumber = (letters) => {
    const cleaned = (letters || "A").toUpperCase().replace(/[^A-Z]/g, "") || "A";
    let value = 0;
    for (const ch of cleaned) value = value * 26 + (ch.charCodeAt(0) - 64);
    return value;
  };

  const saveSnapshot = () => {
    undoStack.push(JSON.stringify(state));
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  };

  const buildRowLabel = (baseLabel, offset) => toLetters(lettersToNumber(baseLabel) + offset);

  const seatNumberForPosition = (index, total, mode) => {
    if (mode !== "odd_even") return String(index + 1);
    const oddCount = Math.ceil(total / 2);
    if (index < oddCount) return String(1 + index * 2);
    return String(2 + (index - oddCount) * 2);
  };

  const existingExternalIds = () => new Set(state.seats.map((seat) => seat.external_id));

  const makeUniqueExternalId = (proposed, usedSet) => {
    if (!usedSet.has(proposed)) {
      usedSet.add(proposed);
      return proposed;
    }
    let seq = 2;
    while (usedSet.has(`${proposed}-${seq}`)) seq += 1;
    const finalValue = `${proposed}-${seq}`;
    usedSet.add(finalValue);
    return finalValue;
  };

  const nextRowIndex = () => state.seats.reduce((max, seat) => Math.max(max, seat.row_index || 0), -1) + 1;

  const createSeat = (seat) => ({
    display_name: `${seat.row_label}-${seat.seat_number}`,
    seat_type: "normal",
    is_accessible: false,
    is_companion: false,
    is_hidden: false,
    is_blocked: false,
    is_technical_blocked: false,
    notes: "",
    metadata: {},
    ...seat,
  });

  const populateCategoryOptions = () => {
    const select = field("gen-category");
    if (!select) return;
    const current = select.value || "standard";
    while (select.firstChild) select.removeChild(select.firstChild);
    state.categories.forEach((category) => {
      const option = document.createElement("option");
      option.value = category.code;
      option.textContent = category.name;
      select.appendChild(option);
    });
    if (!state.categories.find((category) => category.code === current)) {
      select.value = state.categories[0]?.code || "standard";
    } else {
      select.value = current;
    }
  };

  // ─── Category management + selection inspector ─────────────────────────────
  const CATEGORY_PALETTE = ["#3B82F6", "#ef4444", "#22c55e", "#a855f7", "#f59e0b", "#06b6d4", "#ec4899"];
  const categoryListEl = document.getElementById("smartseat-category-list");

  const slugify = (s) =>
    (s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "cat";

  const uniqueCategoryCode = (base) => {
    const used = new Set(state.categories.map((c) => c.code));
    let code = slugify(base);
    let i = 2;
    while (used.has(code)) code = `${slugify(base)}-${i++}`;
    return code;
  };

  const populateInspectorCategorySelect = () => {
    const sel = field("insp-category");
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = "";
    const mixed = document.createElement("option");
    mixed.value = "";
    mixed.textContent = "— mixed / keep —";
    sel.appendChild(mixed);
    state.categories.forEach((c) => {
      const o = document.createElement("option");
      o.value = c.code;
      o.textContent = c.name;
      sel.appendChild(o);
    });
    sel.value = cur;
  };

  const refreshCategoryList = () => {
    if (!categoryListEl) return;
    categoryListEl.innerHTML = "";
    if (!state.categories.length) {
      categoryListEl.innerHTML = '<p class="smartseat-insp-hint">No categories yet.</p>';
      return;
    }
    const header = document.createElement("div");
    header.className = "smartseat-cat-header";
    header.innerHTML = "<span>Colour</span><span>Name</span><span>#</span><span>Sort</span><span></span>";
    categoryListEl.appendChild(header);
    const counts = {};
    state.seats.forEach((s) => {
      if (s.category_code) counts[s.category_code] = (counts[s.category_code] || 0) + 1;
    });
    state.categories.forEach((cat) => {
      const row = document.createElement("div");
      row.className = "smartseat-cat-row";
      const safeName = (cat.name || "").replace(/"/g, "&quot;");
      row.innerHTML = `
        <input type="color" data-k="color" value="${cat.color || "#3B82F6"}" title="Colour">
        <input type="text" data-k="name" value="${safeName}" placeholder="Name">
        <span class="smartseat-cat-count" title="Seats in this category">${counts[cat.code] || 0}</span>
        <input type="number" data-k="price_rank" value="${cat.price_rank ?? 100}" title="Sort order (lower = first)">
        <button type="button" data-k="del" title="Delete category">&times;</button>
      `;
      row.querySelectorAll("input[data-k]").forEach((inp) => {
        inp.addEventListener("change", () => {
          const k = inp.getAttribute("data-k");
          const target = state.categories.find((c) => c.code === cat.code);
          if (!target) return;
          if (k === "price_rank") target.price_rank = parseInt(inp.value, 10) || 0;
          else target[k] = inp.value;
          populateCategoryOptions();
          populateInspectorCategorySelect();
          draw();
        });
      });
      row.querySelector('button[data-k="del"]').addEventListener("click", () => {
        if (!confirm(`Delete category "${cat.name}"? Seats in it become uncategorized.`)) return;
        saveSnapshot();
        state.categories = state.categories.filter((c) => c.code !== cat.code);
        state.seats.forEach((s) => {
          if (s.category_code === cat.code) s.category_code = null;
        });
        populateCategoryOptions();
        populateInspectorCategorySelect();
        refreshCategoryList();
        draw();
      });
      categoryListEl.appendChild(row);
    });
  };

  const addCategory = () => {
    saveSnapshot();
    const name = `Category ${state.categories.length + 1}`;
    state.categories.push({
      code: uniqueCategoryCode(name),
      name,
      color: CATEGORY_PALETTE[state.categories.length % CATEGORY_PALETTE.length],
      price_rank: 100,
    });
    populateCategoryOptions();
    populateInspectorCategorySelect();
    refreshCategoryList();
  };

  const refreshPlanInfo = () => {
    const sc = document.querySelector('[data-role="seat-count"]');
    if (sc) sc.textContent = String(state.seats.length);
  };

  // Show only what the current selection needs in the Edit tab: the Selection
  // block when seats are selected, the Area block when an area is selected, and
  // a short hint when nothing is selected.
  const editActive = () => document.querySelector('[data-tab-btn="edit"]')?.classList.contains("active");
  const applyEditContext = () => {
    if (!editActive()) return;
    const hasSel = selected.size > 0;
    const hasArea = selectedArea !== null;
    const selSec = document.querySelector('[data-role="selection-section"]');
    const areaSec = document.querySelector('[data-role="area-section"]');
    const emptySec = document.querySelector('[data-role="edit-empty-section"]');
    if (selSec) selSec.hidden = !hasSel;
    if (areaSec) areaSec.hidden = !hasArea;
    if (emptySec) emptySec.hidden = hasSel || hasArea;
  };

  const refreshInspector = () => {
    refreshPlanInfo();
    applyEditContext();
    const fields = document.querySelector('[data-role="sel-fields"]');
    const count = document.querySelector('[data-role="sel-count"]');
    if (count) count.textContent = String(selected.size);
    if (!fields || !selected.size) return;
    const sel = state.seats.filter((s) => selected.has(s.external_id));
    const common = (getter) => {
      const vals = new Set(sel.map(getter));
      return vals.size === 1 ? [...vals][0] : null;
    };
    const cat = common((s) => s.category_code || "");
    const type = common((s) => s.seat_type || "normal");
    field("insp-category").value = cat === null ? "" : cat;
    field("insp-seat-type").value = type === null ? "" : type;
    const setCheck = (name, getter) => {
      const v = common(getter);
      const el = field(name);
      if (!el) return;
      el.indeterminate = v === null;
      el.checked = v === true;
    };
    setCheck("insp-blocked", (s) => !!s.is_blocked);
  };

  const applyToSelection = (mutator) => {
    if (!selected.size) return;
    saveSnapshot();
    state.seats.forEach((s) => {
      if (selected.has(s.external_id)) mutator(s);
    });
    draw();
  };

  const alignSelection = (mode) => {
    const sel = state.seats.filter((s) => selected.has(s.external_id));
    if (sel.length < 2) return;
    saveSnapshot();
    const xs = sel.map((s) => s.x);
    const ys = sel.map((s) => s.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const avgX = xs.reduce((a, b) => a + b, 0) / xs.length;
    const avgY = ys.reduce((a, b) => a + b, 0) / ys.length;
    sel.forEach((s) => {
      if (mode === "left") s.x = minX;
      else if (mode === "right") s.x = maxX;
      else if (mode === "hcenter") s.x = avgX;
      else if (mode === "top") s.y = minY;
      else if (mode === "bottom") s.y = maxY;
      else if (mode === "vcenter") s.y = avgY;
    });
    draw();
  };

  const distributeSelection = (axis) => {
    const sel = state.seats.filter((s) => selected.has(s.external_id));
    if (sel.length < 3) return;
    saveSnapshot();
    const key = axis === "h" ? "x" : "y";
    sel.sort((a, b) => a[key] - b[key]);
    const first = sel[0][key];
    const last = sel[sel.length - 1][key];
    const step = (last - first) / (sel.length - 1);
    sel.forEach((s, i) => { s[key] = first + step * i; });
    draw();
  };

  // ─── Area inspector (edit the selected decorative area) ────────────────────
  const areaFieldsEl = document.getElementById("smartseat-area-fields");

  const numberField = (label, value, onChange, step) => {
    const wrap = document.createElement("label");
    wrap.className = "smartseat-area-field";
    wrap.textContent = label;
    const inp = document.createElement("input");
    inp.type = "number";
    if (step) inp.step = String(step);
    inp.value = String(value);
    inp.addEventListener("change", () => onChange(parseFloat(inp.value)));
    wrap.appendChild(inp);
    return wrap;
  };

  const colorField = (label, value, onChange) => {
    const wrap = document.createElement("label");
    wrap.className = "smartseat-area-field";
    wrap.textContent = label;
    const inp = document.createElement("input");
    inp.type = "color";
    inp.value = (value || "#cccccc").slice(0, 7);
    inp.addEventListener("change", () => onChange(inp.value));
    wrap.appendChild(inp);
    return wrap;
  };

  const commitArea = () => {
    saveSnapshot();
    draw();
  };

  const refreshAreaInspector = () => {
    applyEditContext();
    if (!areaFieldsEl) return;
    const area = selectedArea !== null ? state.areas[selectedArea] : null;
    if (!area) { areaFieldsEl.innerHTML = ""; return; }
    areaFieldsEl.innerHTML = "";

    const typeLine = document.createElement("p");
    typeLine.className = "smartseat-insp-hint";
    typeLine.textContent = "Type: " + area.shape;
    areaFieldsEl.appendChild(typeLine);

    // Editor role: a clickable/editable object vs a locked decoration marking.
    const roleWrap = document.createElement("label");
    roleWrap.className = "smartseat-area-field";
    roleWrap.textContent = "Use as";
    const roleSel = document.createElement("select");
    [["interactive", "Interactive (clickable / editable)"],
     ["decoration", "Decoration (locked marking)"],
     ["product", "Product area (standing / GA)"],
     ["section", "Section (zoomable block)"],
     ["focal", "Focal point (best-available anchor)"]]
      .forEach(([val, label]) => {
        const o = document.createElement("option");
        o.value = val; o.textContent = label;
        roleSel.appendChild(o);
      });
    roleSel.value = area.role || "interactive";
    roleSel.addEventListener("change", () => { area.role = roleSel.value; commitArea(); refreshAreaInspector(); });
    roleWrap.appendChild(roleSel);
    areaFieldsEl.appendChild(roleWrap);

    // Sections carry a display label (shown on the plan and in the shop).
    if (area.role === "section") {
      const lWrap = document.createElement("label");
      lWrap.className = "smartseat-area-field";
      lWrap.textContent = "Section label";
      const lInp = document.createElement("input");
      lInp.type = "text"; lInp.value = area.label || "";
      lInp.addEventListener("change", () => { area.label = lInp.value; commitArea(); });
      lWrap.appendChild(lInp);
      areaFieldsEl.appendChild(lWrap);
      const hint = document.createElement("p");
      hint.className = "smartseat-insp-hint";
      hint.textContent = "Double-click the section on the plan to zoom into it; shoppers can click it to zoom too.";
      areaFieldsEl.appendChild(hint);
    }

    // Product areas (standing / general admission): pick the pretix product that
    // a click in the shop will add to the cart (by quantity).
    if (area.role === "product") {
      const pWrap = document.createElement("label");
      pWrap.className = "smartseat-area-field";
      pWrap.textContent = "Product (ticket)";
      const pSel = document.createElement("select");
      const none = document.createElement("option");
      none.value = ""; none.textContent = PRODUCTS.length ? "— choose —" : "(no products in this event)";
      pSel.appendChild(none);
      PRODUCTS.forEach((p) => {
        const o = document.createElement("option");
        o.value = String(p.id); o.textContent = p.name;
        pSel.appendChild(o);
      });
      pSel.value = area.product != null ? String(area.product) : "";
      pSel.addEventListener("change", () => {
        area.product = pSel.value ? Number(pSel.value) : null;
        area.product_name = pSel.value ? (PRODUCTS.find((p) => String(p.id) === pSel.value)?.name || "") : "";
        commitArea();
      });
      pWrap.appendChild(pSel);
      areaFieldsEl.appendChild(pWrap);
      const hint = document.createElement("p");
      hint.className = "smartseat-insp-hint";
      hint.textContent = "Shoppers click this region to add the product to the cart. No individual seats.";
      areaFieldsEl.appendChild(hint);
    }

    if (area.shape === "text") {
      const wrap = document.createElement("label");
      wrap.className = "smartseat-area-field";
      wrap.textContent = "Text";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = area.text?.text || "";
      inp.addEventListener("change", () => { area.text.text = inp.value; commitArea(); });
      wrap.appendChild(inp);
      areaFieldsEl.appendChild(wrap);
      areaFieldsEl.appendChild(numberField("Font size", area.text?.size || 16,
        (v) => { area.text.size = v; commitArea(); }));
      areaFieldsEl.appendChild(colorField("Text colour", area.text?.color,
        (v) => { area.text.color = v; commitArea(); }));
    } else {
      areaFieldsEl.appendChild(colorField("Fill", area.color, (v) => { area.color = v; commitArea(); }));
      areaFieldsEl.appendChild(colorField("Border", area.border_color, (v) => { area.border_color = v; commitArea(); }));
      if (area.shape === "rectangle" && area.rectangle) {
        areaFieldsEl.appendChild(numberField("Width", area.rectangle.width, (v) => { area.rectangle.width = v; commitArea(); }));
        areaFieldsEl.appendChild(numberField("Height", area.rectangle.height, (v) => { area.rectangle.height = v; commitArea(); }));
      } else if (area.shape === "circle" && area.circle) {
        areaFieldsEl.appendChild(numberField("Radius", area.circle.radius, (v) => { area.circle.radius = v; commitArea(); }));
      } else if (area.shape === "ellipse" && area.ellipse) {
        areaFieldsEl.appendChild(numberField("Radius X", area.ellipse.radius.x, (v) => { area.ellipse.radius.x = v; commitArea(); }));
        areaFieldsEl.appendChild(numberField("Radius Y", area.ellipse.radius.y, (v) => { area.ellipse.radius.y = v; commitArea(); }));
      }

      // Fill the area with a grid of seats.
      if (area.shape !== "text") {
        const fill = document.createElement("div");
        fill.className = "smartseat-area-fill";
        const head = document.createElement("p");
        head.className = "smartseat-insp-hint";
        head.textContent = "Fill with seats";
        fill.appendChild(head);
        const cntWrap = document.createElement("label");
        cntWrap.className = "smartseat-area-field";
        cntWrap.textContent = "Number of seats";
        const cnt = document.createElement("input");
        cnt.type = "number"; cnt.min = "1"; cnt.max = "2000"; cnt.value = "30";
        cntWrap.appendChild(cnt);
        fill.appendChild(cntWrap);
        const catWrap = document.createElement("label");
        catWrap.className = "smartseat-area-field";
        catWrap.textContent = "Category";
        const catSel = document.createElement("select");
        (state.categories || []).forEach((c) => {
          const o = document.createElement("option"); o.value = c.code; o.textContent = c.name; catSel.appendChild(o);
        });
        catWrap.appendChild(catSel);
        fill.appendChild(catWrap);
        const btn = document.createElement("button");
        btn.type = "button"; btn.className = "btn btn-default btn-sm"; btn.textContent = "Fill with seats";
        btn.addEventListener("click", () => fillAreaWithSeats(area, parseInt(cnt.value, 10) || 1, catSel.value));
        fill.appendChild(btn);
        areaFieldsEl.appendChild(fill);
      }
    }
    areaFieldsEl.appendChild(numberField("Rotation°", area.rotation || 0, (v) => { area.rotation = v; commitArea(); }, 1));
  };

  const drawBackgroundAssets = () => {
    const sortedAssets = [...state.template_assets]
      .filter((asset) => asset.is_visible)
      .sort((a, b) => (a.z_index || 0) - (b.z_index || 0));

    sortedAssets.forEach((asset) => {
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const x = Number(asset.x || 0);
      const y = Number(asset.y || 0);
      const scale = Number(asset.scale || 1);
      const rotation = Number(asset.rotation || 0);
      group.setAttribute("transform", `translate(${x} ${y}) rotate(${rotation}) scale(${scale})`);
      group.setAttribute("opacity", String(asset.opacity ?? 0.35));
      group.setAttribute("data-template-id", String(asset.id));
      // Background layers must never swallow pointer events, otherwise the
      // rubber-band / seat / area tools can't receive clicks over the image.
      group.setAttribute("pointer-events", "none");

      const image = document.createElementNS("http://www.w3.org/2000/svg", "image");
      image.setAttributeNS("http://www.w3.org/1999/xlink", "href", asset.image_url);
      image.setAttribute("x", "0");
      image.setAttribute("y", "0");
      image.setAttribute("width", String(asset.width || 200));
      image.setAttribute("height", String(asset.height || 200));
      image.setAttribute("preserveAspectRatio", "none");
      group.appendChild(image);
      svg.appendChild(group);
    });
  };

  // Maps external_id -> currently rendered circle node, so selection changes
  // can update just the affected nodes instead of redrawing the whole plan.
  const renderedNodes = new Map();

  const applySelectionClass = (externalId) => {
    const node = renderedNodes.get(externalId);
    const seat = state.seats.find((s) => s.external_id === externalId);
    if (node && seat) {
      node.setAttribute("class", seatClass(seat));
    }
  };

  // onSeatClick kept for keyboard/programmatic use; pointer interaction is
  // now handled by the unified SVG pointer handler above.
  const onSeatClick = (seat, shiftKey = false) => {
    if (shiftKey) {
      if (selected.has(seat.external_id)) selected.delete(seat.external_id);
      else selected.add(seat.external_id);
      applySelectionClass(seat.external_id);
    } else {
      const previous = Array.from(selected);
      selected = new Set([seat.external_id]);
      previous.forEach(applySelectionClass);
      applySelectionClass(seat.external_id);
    }
  };

  // ─── Decorative areas (stage / bar / aisles / text labels) ────────────────
  const SVGNS = "http://www.w3.org/2000/svg";

  const newAreaId = () => "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const newArea = (shape) => {
    const cx = placePoint ? placePoint.x : view.x + view.w / 2;
    const cy = placePoint ? placePoint.y : view.y + view.h / 2;
    const base = { id: newAreaId(), shape, position: { x: snap(cx), y: snap(cy) }, rotation: 0 };
    if (shape === "rectangle") {
      return { ...base, color: "#cbd5e1", border_color: "#64748b", rectangle: { width: 200, height: 80 } };
    }
    if (shape === "ellipse") {
      return { ...base, color: "#cbd5e1", border_color: "#64748b", ellipse: { radius: { x: 100, y: 60 } } };
    }
    if (shape === "circle") {
      return { ...base, color: "#cbd5e1", border_color: "#64748b", circle: { radius: 80 } };
    }
    // text
    return { ...base, text: { text: "Label", color: "#111827", size: 24, position: { x: 0, y: 0 } } };
  };

  const addArea = (shape) => {
    saveSnapshot();
    state.areas.push(newArea(shape));
    selectedArea = state.areas.length - 1;
    selected = new Set();
    draw();
  };

  // Ring sector / grandstand block: an annular sector (curved trapezoid) like a
  // stadium tribune. Center = click point; built as a polygon (outer arc + inner
  // arc) so it stays native-compatible.
  const generateSector = () => {
    const cx = snap(placePoint ? placePoint.x : view.x + view.w / 2);
    const cy = snap(placePoint ? placePoint.y : view.y + view.h / 2);
    const inner = Math.max(0, parseNumber("gen-sector-inner", 140));
    const outer = Math.max(inner + 10, parseNumber("gen-sector-outer", 240));
    let a0 = parseNumber("gen-sector-start", -60);
    let a1 = parseNumber("gen-sector-end", 60);
    if (a0 === a1) a1 = a0 + 60;
    const segs = Math.max(6, Math.round(Math.abs(a1 - a0) / 4)); // ~4° steps
    const rad = (d) => (d * Math.PI) / 180;
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const a = rad(a0 + ((a1 - a0) * i) / segs);
      pts.push({ x: Math.round(cx + Math.cos(a) * outer), y: Math.round(cy + Math.sin(a) * outer) });
    }
    if (inner > 0) {
      for (let i = segs; i >= 0; i--) {
        const a = rad(a0 + ((a1 - a0) * i) / segs);
        pts.push({ x: Math.round(cx + Math.cos(a) * inner), y: Math.round(cy + Math.sin(a) * inner) });
      }
    } else {
      pts.push({ x: cx, y: cy });
    }
    saveSnapshot();
    state.areas.push({
      id: newAreaId(), shape: "polygon", role: "decoration",
      position: { x: 0, y: 0 }, rotation: 0,
      color: "rgba(234,179,8,0.35)", border_color: "#ca8a04",
      polygon: { points: pts },
    });
    selectedArea = state.areas.length - 1;
    selected = new Set();
    draw();
    setSidebarTab("edit");
    setTool("select");
  };

  // Focal point: a single marker ("the stage is here") used to rank
  // best-available suggestions by real distance. Editor-only, max one per plan.
  const setFocalPoint = () => {
    const cx = snap(placePoint ? placePoint.x : view.x + view.w / 2);
    const cy = snap(placePoint ? placePoint.y : view.y + view.h / 2);
    saveSnapshot();
    state.areas = (state.areas || []).filter((a) => a.role !== "focal");
    state.areas.push({
      id: newAreaId(), shape: "circle", role: "focal",
      position: { x: cx, y: cy }, rotation: 0, circle: { radius: 14 },
    });
    selectedArea = state.areas.length - 1;
    selected = new Set();
    draw();
    setSidebarTab("edit");
    setTool("select");
  };

  // ─── Polygon tool ─────────────────────────────────────────────────────────
  const cancelPolygon = () => { polyPoints = null; polyCursor = null; scheduleDraw(); };

  // Smooth a set of points into a closed Catmull-Rom curve, sampled back into
  // polygon points (so curves stay representable as native polygon areas).
  const sampleClosedCurve = (pts, perSeg = 16) => {
    const n = pts.length;
    if (n < 3) return pts.map((p) => ({ x: p.x, y: p.y }));
    const out = [];
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      for (let t = 0; t < perSeg; t++) {
        const s = t / perSeg, s2 = s * s, s3 = s2 * s;
        const x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * s + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * s2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * s3);
        const y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * s + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * s2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * s3);
        out.push({ x: Math.round(x), y: Math.round(y) });
      }
    }
    return out;
  };

  const finalizePolygon = () => {
    if (!polyPoints || polyPoints.length < 3) { cancelPolygon(); return; }
    saveSnapshot();
    const curve = polyMode === "curve";
    const points = curve ? sampleClosedCurve(polyPoints) : polyPoints.map((p) => ({ x: p.x, y: p.y }));
    state.areas.push({
      // Curves default to a decorative marking; polygons start interactive.
      shape: "polygon",
      role: curve ? "decoration" : "interactive",
      position: { x: 0, y: 0 }, rotation: 0,
      color: curve ? "rgba(148,163,184,0.35)" : "#cbd5e1",
      border_color: "#64748b",
      polygon: { points },
    });
    selectedArea = state.areas.length - 1;
    selected = new Set();
    polyPoints = null; polyCursor = null;
    draw();
    setSidebarTab("edit");
    setTool("select");
  };

  // Live preview of the polygon being drawn (committed edges + rubber line to
  // the cursor + a closing hint back to the first vertex + vertex dots).
  const renderPolygonDraft = () => {
    if (!polyPoints || !polyPoints.length) return;
    const sc = screenScale().sx || 1;
    const pts = polyPoints.map((p) => `${p.x},${p.y}`).join(" ");
    const line = document.createElementNS(SVGNS, "polyline");
    line.setAttribute("points", pts + (polyCursor ? ` ${polyCursor.x},${polyCursor.y}` : ""));
    line.setAttribute("class", "smartseat-poly-draft");
    svg.appendChild(line);
    if (polyPoints.length >= 2 && polyCursor) {
      const close = document.createElementNS(SVGNS, "line");
      close.setAttribute("x1", polyCursor.x); close.setAttribute("y1", polyCursor.y);
      close.setAttribute("x2", polyPoints[0].x); close.setAttribute("y2", polyPoints[0].y);
      close.setAttribute("class", "smartseat-poly-close");
      svg.appendChild(close);
    }
    polyPoints.forEach((p, i) => {
      const dot = document.createElementNS(SVGNS, "circle");
      dot.setAttribute("cx", p.x); dot.setAttribute("cy", p.y);
      dot.setAttribute("r", (i === 0 ? 6 : 4) / sc);
      dot.setAttribute("class", "smartseat-poly-vertex" + (i === 0 ? " first" : ""));
      svg.appendChild(dot);
    });
  };

  // ─── Fill an area with a grid of seats ────────────────────────────────────
  const pointInPolygon = (x, y, pts) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };

  // Local-frame geometry of an area: inside-test, bounding box and surface area.
  const areaLocalGeom = (area) => {
    if (area.shape === "rectangle" && area.rectangle) {
      const w = area.rectangle.width, h = area.rectangle.height;
      return { inside: (x, y) => x >= 0 && x <= w && y >= 0 && y <= h,
        bb: { x0: 0, y0: 0, x1: w, y1: h }, area: w * h };
    }
    if (area.shape === "circle" && area.circle) {
      const r = area.circle.radius;
      return { inside: (x, y) => x * x + y * y <= r * r,
        bb: { x0: -r, y0: -r, x1: r, y1: r }, area: Math.PI * r * r };
    }
    if (area.shape === "ellipse" && area.ellipse) {
      const rx = area.ellipse.radius.x || 1, ry = area.ellipse.radius.y || 1;
      return { inside: (x, y) => (x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1,
        bb: { x0: -rx, y0: -ry, x1: rx, y1: ry }, area: Math.PI * rx * ry };
    }
    if (area.shape === "polygon" && area.polygon) {
      const pts = area.polygon.points || [];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, a = 0;
      for (let i = 0; i < pts.length; i++) {
        x0 = Math.min(x0, pts[i].x); y0 = Math.min(y0, pts[i].y);
        x1 = Math.max(x1, pts[i].x); y1 = Math.max(y1, pts[i].y);
        const j = (i + 1) % pts.length;
        a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
      }
      return { inside: (x, y) => pointInPolygon(x, y, pts),
        bb: { x0, y0, x1, y1 }, area: Math.abs(a) / 2 };
    }
    return null;
  };

  const fillAreaWithSeats = (area, count, categoryCode) => {
    count = Math.max(1, Math.floor(count || 1));
    const geom = areaLocalGeom(area);
    if (!geom) { alert("This area shape can't be filled with seats."); return; }
    const px = Number(area.position?.x || 0), py = Number(area.position?.y || 0);
    const th = (Number(area.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(th), sin = Math.sin(th);

    // Pick a grid spacing from the area, then refine so we get ≈ count seats.
    const collect = (spacing) => {
      const out = [];
      const w = geom.bb.x1 - geom.bb.x0, h = geom.bb.y1 - geom.bb.y0;
      const cols = Math.max(1, Math.round(w / spacing)), rows = Math.max(1, Math.round(h / spacing));
      const ox = geom.bb.x0 + (w - (cols - 1) * spacing) / 2;
      const oy = geom.bb.y0 + (h - (rows - 1) * spacing) / 2;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const lx = ox + c * spacing, ly = oy + r * spacing;
          if (geom.inside(lx, ly)) out.push({ lx, ly });
        }
      }
      return out;
    };
    let spacing = Math.max(10, Math.sqrt(geom.area / count));
    let pts = collect(spacing);
    for (let i = 0; i < 8 && pts.length < count; i++) { spacing *= 0.85; pts = collect(spacing); }
    // If we overshot, evenly thin the list down to the requested count.
    if (pts.length > count) {
      const step = pts.length / count;
      const thinned = [];
      for (let i = 0; i < count; i++) thinned.push(pts[Math.floor(i * step)]);
      pts = thinned;
    }
    if (!pts.length) { alert("Area too small for the requested number of seats."); return; }

    saveSnapshot();
    const usedIds = existingExternalIds();
    const rowIndex = nextRowIndex();
    const blockLabel = activeZone || "Main";
    const cat = categoryCode || state.categories[0]?.code || "standard";
    const newIds = [];
    pts.forEach((p, i) => {
      const wx = px + p.lx * cos - p.ly * sin;
      const wy = py + p.lx * sin + p.ly * cos;
      const externalId = makeUniqueExternalId(`${blockLabel}-FILL-${i + 1}`, usedIds);
      newIds.push(externalId);
      state.seats.push(createSeat({
        external_id: externalId, block_label: blockLabel,
        row_label: "F", seat_number: String(i + 1), seat_index: i, row_index: rowIndex,
        x: snap(wx), y: snap(wy), rotation: 0, category_code: cat,
      }));
    });
    selected = new Set(newIds);
    selectedArea = null;
    ensureZones();
    createGroupFromIds(newIds, "Area seats");
    draw();
  };

  const deleteArea = (index) => {
    if (index == null || !state.areas[index]) return;
    saveSnapshot();
    state.areas.splice(index, 1);
    selectedArea = null;
    draw();
  };

  const renderArea = (area, index) => {
    const g = document.createElementNS(SVGNS, "g");
    const px = Number(area.position?.x || 0);
    const py = Number(area.position?.y || 0);
    g.setAttribute("transform", `translate(${px} ${py}) rotate(${Number(area.rotation || 0)})`);
    g.setAttribute("data-area-index", String(index));
    const role = area.role || "interactive";
    const deco = role === "decoration";
    let cls = "smartseat-area" + (index === selectedArea ? " selected" : "");
    // Decorations get a muted dashed look but stay selectable. They render
    // behind the seats, so seats always win a click where they overlap.
    if (deco) cls += " smartseat-area-deco";
    if (role === "product") cls += " smartseat-area-product";
    if (role === "section") cls += " smartseat-area-section";
    g.setAttribute("class", cls);

    // Focal point: rendered as a crosshair marker instead of a normal shape.
    if (role === "focal") {
      g.setAttribute("class", cls + " smartseat-area-focal");
      const r = 14;
      const ring = document.createElementNS(SVGNS, "circle");
      ring.setAttribute("cx", 0); ring.setAttribute("cy", 0); ring.setAttribute("r", r);
      g.appendChild(ring);
      [[-r * 1.5, 0, r * 1.5, 0], [0, -r * 1.5, 0, r * 1.5]].forEach((l) => {
        const ln = document.createElementNS(SVGNS, "line");
        ln.setAttribute("x1", l[0]); ln.setAttribute("y1", l[1]);
        ln.setAttribute("x2", l[2]); ln.setAttribute("y2", l[3]);
        g.appendChild(ln);
      });
      const t = document.createElementNS(SVGNS, "text");
      t.setAttribute("x", 0); t.setAttribute("y", -r * 1.9);
      t.setAttribute("text-anchor", "middle");
      t.textContent = "Focus";
      g.appendChild(t);
      svg.appendChild(g);
      return;
    }

    const fill = area.color || "rgba(148,163,184,0.5)";
    const stroke = area.border_color || "#64748b";
    let shapeEl = null;
    if (area.shape === "rectangle" && area.rectangle) {
      shapeEl = document.createElementNS(SVGNS, "rect");
      shapeEl.setAttribute("x", "0");
      shapeEl.setAttribute("y", "0");
      shapeEl.setAttribute("width", String(area.rectangle.width || 100));
      shapeEl.setAttribute("height", String(area.rectangle.height || 50));
    } else if (area.shape === "circle" && area.circle) {
      shapeEl = document.createElementNS(SVGNS, "circle");
      shapeEl.setAttribute("cx", "0");
      shapeEl.setAttribute("cy", "0");
      shapeEl.setAttribute("r", String(area.circle.radius || 50));
    } else if (area.shape === "ellipse" && area.ellipse) {
      shapeEl = document.createElementNS(SVGNS, "ellipse");
      shapeEl.setAttribute("cx", "0");
      shapeEl.setAttribute("cy", "0");
      shapeEl.setAttribute("rx", String(area.ellipse.radius?.x || 80));
      shapeEl.setAttribute("ry", String(area.ellipse.radius?.y || 50));
    } else if (area.shape === "polygon" && area.polygon) {
      shapeEl = document.createElementNS(SVGNS, "polygon");
      shapeEl.setAttribute("points", (area.polygon.points || []).map((p) => `${p.x},${p.y}`).join(" "));
    } else if (area.shape === "text" && area.text) {
      shapeEl = document.createElementNS(SVGNS, "text");
      shapeEl.setAttribute("x", String(area.text.position?.x || 0));
      shapeEl.setAttribute("y", String(area.text.position?.y || 0));
      shapeEl.setAttribute("font-size", String(area.text.size || 16));
      shapeEl.setAttribute("fill", area.text.color || "#111827");
      shapeEl.textContent = area.text.text || "";
    }
    if (!shapeEl) return;
    if (area.shape !== "text") {
      shapeEl.setAttribute("fill", fill);
      shapeEl.setAttribute("stroke", stroke);
      shapeEl.setAttribute("stroke-width", "1");
    }
    g.appendChild(shapeEl);

    // Sections show their label in the centre (double-click zooms into them).
    if (role === "section") {
      const geom = areaLocalGeom(area);
      const bb = geom && geom.bb;
      const label = document.createElementNS(SVGNS, "text");
      label.setAttribute("x", bb ? (bb.x0 + bb.x1) / 2 : 0);
      label.setAttribute("y", bb ? (bb.y0 + bb.y1) / 2 : 0);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "smartseat-area-section-label");
      label.textContent = area.label || "Section";
      g.appendChild(label);
    }

    // Product areas show their product name (or a hint to pick one) in the centre.
    if (role === "product") {
      const bb = areaBBox(area);
      const cx = bb ? bb.x0 + bb.w / 2 : 0;
      const cy = bb ? bb.y0 + bb.h / 2 : 0;
      const label = document.createElementNS(SVGNS, "text");
      label.setAttribute("x", cx); label.setAttribute("y", cy);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "smartseat-area-product-label");
      label.textContent = area.product_name || (area.product ? "Product #" + area.product : "⚠ pick a product");
      g.appendChild(label);
    }

    svg.appendChild(g);
  };

  const renderAreas = () => {
    (state.areas || []).forEach((area, index) => renderArea(area, index));
  };

  // Resize handles for the selected area (rendered on top of seats).
  const HANDLE_PX = 9;
  const HANDLE_DIRS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

  const areaBBox = (area) => {
    if (area.shape === "rectangle" && area.rectangle) {
      return { x0: 0, y0: 0, w: area.rectangle.width || 0, h: area.rectangle.height || 0 };
    }
    if (area.shape === "circle" && area.circle) {
      const r = area.circle.radius || 0;
      return { x0: -r, y0: -r, w: 2 * r, h: 2 * r };
    }
    if (area.shape === "ellipse" && area.ellipse) {
      const rx = area.ellipse.radius?.x || 0;
      const ry = area.ellipse.radius?.y || 0;
      return { x0: -rx, y0: -ry, w: 2 * rx, h: 2 * ry };
    }
    return null;
  };

  const handlePointLocal = (bbox, dir) => {
    const mx = bbox.x0 + bbox.w / 2;
    const my = bbox.y0 + bbox.h / 2;
    const x = dir.includes("w") ? bbox.x0 : dir.includes("e") ? bbox.x0 + bbox.w : mx;
    const y = dir.includes("n") ? bbox.y0 : dir.includes("s") ? bbox.y0 + bbox.h : my;
    return { x, y };
  };

  const renderAreaHandles = (area, index) => {
    const bbox = areaBBox(area);
    if (!bbox) return; // text or unsupported shape -> no handles
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute(
      "transform",
      `translate(${Number(area.position?.x || 0)} ${Number(area.position?.y || 0)}) rotate(${Number(area.rotation || 0)})`
    );
    const hs = HANDLE_PX / (screenScale().sx || 1); // ~constant on-screen size
    HANDLE_DIRS.forEach((dir) => {
      const p = handlePointLocal(bbox, dir);
      const rect = document.createElementNS(SVGNS, "rect");
      rect.setAttribute("x", String(p.x - hs / 2));
      rect.setAttribute("y", String(p.y - hs / 2));
      rect.setAttribute("width", String(hs));
      rect.setAttribute("height", String(hs));
      rect.setAttribute("class", "smartseat-handle");
      rect.setAttribute("data-handle", dir);
      rect.setAttribute("data-area-index", String(index));
      g.appendChild(rect);
    });
    // Rotation handle above the top edge.
    const cxLocal = bbox.x0 + bbox.w / 2;
    const off = (HANDLE_PX * 2.4) / (screenScale().sx || 1);
    const line = document.createElementNS(SVGNS, "line");
    line.setAttribute("x1", cxLocal); line.setAttribute("y1", bbox.y0);
    line.setAttribute("x2", cxLocal); line.setAttribute("y2", bbox.y0 - off);
    line.setAttribute("class", "smartseat-rot-line");
    g.appendChild(line);
    const rot = document.createElementNS(SVGNS, "circle");
    rot.setAttribute("cx", cxLocal); rot.setAttribute("cy", bbox.y0 - off);
    rot.setAttribute("r", hs * 0.6);
    rot.setAttribute("class", "smartseat-rot-handle");
    rot.setAttribute("data-rotate", "area");
    rot.setAttribute("data-area-index", String(index));
    g.appendChild(rot);
    svg.appendChild(g);
  };

  // Rotation handle for a multi-seat selection (rendered at the selection bbox).
  const renderSeatRotateHandle = () => {
    const sel = state.seats.filter((s) => selected.has(s.external_id));
    if (sel.length < 2) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    sel.forEach((s) => {
      minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
      minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
    });
    const cx = (minX + maxX) / 2;
    const off = (HANDLE_PX * 2.6) / (screenScale().sx || 1);
    const line = document.createElementNS(SVGNS, "line");
    line.setAttribute("x1", cx); line.setAttribute("y1", minY);
    line.setAttribute("x2", cx); line.setAttribute("y2", minY - off);
    line.setAttribute("class", "smartseat-rot-line");
    svg.appendChild(line);
    const rot = document.createElementNS(SVGNS, "circle");
    rot.setAttribute("cx", cx); rot.setAttribute("cy", minY - off);
    rot.setAttribute("r", (HANDLE_PX * 0.6) / (screenScale().sx || 1));
    rot.setAttribute("class", "smartseat-rot-handle");
    rot.setAttribute("data-rotate", "seats");
    svg.appendChild(rot);
  };

  // Dashed boundary + name around every top-level group, so grouping is visible
  // on the canvas (purely decorative → no pointer events). DOM nodes are kept
  // per group id so the outline can be moved live while dragging seats.
  const GROUP_PAD = 14;
  const groupOutlineNodes = new Map(); // gid -> { rect, label }

  // Bounding box of a group's seats. `live` reads moved positions straight from
  // the rendered circles (used during a drag); otherwise the committed state.
  const groupBBox = (g, live) => {
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity, n = 0;
    for (const id of groupSeatIds(g)) {
      let sx, sy;
      const node = live ? renderedNodes.get(id) : null;
      if (node) { sx = parseFloat(node.getAttribute("cx")); sy = parseFloat(node.getAttribute("cy")); }
      else {
        const s = state.seats.find((x) => x.external_id === id);
        if (!s) continue;
        sx = s.x; sy = s.y;
      }
      n++;
      mnx = Math.min(mnx, sx); mxx = Math.max(mxx, sx);
      mny = Math.min(mny, sy); mxy = Math.max(mxy, sy);
    }
    return n ? { mnx, mny, mxx, mxy } : null;
  };

  const renderGroupOutlines = () => {
    groupOutlineNodes.clear();
    const groups = (state.groups || []).filter((g) => !g.parent);
    for (const g of groups) {
      const bb = groupBBox(g, false);
      if (!bb) continue;
      const x = bb.mnx - GROUP_PAD, y = bb.mny - GROUP_PAD;
      const w = (bb.mxx - bb.mnx) + GROUP_PAD * 2, h = (bb.mxy - bb.mny) + GROUP_PAD * 2;
      const isActive = g.id === activeGroup;
      const selectedGroup = !isActive && groupSeatIds(g).some((id) => selected.has(id));
      const state2 = isActive ? " active" : (selectedGroup ? " selected" : "");
      const rect = document.createElementNS(SVGNS, "rect");
      rect.setAttribute("x", x); rect.setAttribute("y", y);
      rect.setAttribute("width", w); rect.setAttribute("height", h);
      rect.setAttribute("rx", 12); rect.setAttribute("ry", 12);
      rect.setAttribute("class", "smartseat-group-outline" + state2);
      svg.appendChild(rect);
      const label = document.createElementNS(SVGNS, "text");
      label.setAttribute("x", x + 7); label.setAttribute("y", y - 5);
      label.setAttribute("class", "smartseat-group-label" + state2);
      label.textContent = (g.name || "Group") + (isActive ? " — editing" : "");
      svg.appendChild(label);
      groupOutlineNodes.set(g.id, { rect, label });
    }
  };

  // Reposition group outlines to follow seats that are being dragged, without a
  // full redraw (keeps the boundary glued to its contents).
  const updateGroupOutlinesLive = () => {
    if (!groupOutlineNodes.size) return;
    groupOutlineNodes.forEach((nodes, gid) => {
      const g = (state.groups || []).find((x) => x.id === gid);
      if (!g) return;
      const bb = groupBBox(g, true);
      if (!bb) return;
      const x = bb.mnx - GROUP_PAD, y = bb.mny - GROUP_PAD;
      nodes.rect.setAttribute("x", x); nodes.rect.setAttribute("y", y);
      nodes.rect.setAttribute("width", (bb.mxx - bb.mnx) + GROUP_PAD * 2);
      nodes.rect.setAttribute("height", (bb.mxy - bb.mny) + GROUP_PAD * 2);
      nodes.label.setAttribute("x", x + 7); nodes.label.setAttribute("y", y - 5);
    });
  };

  const draw = () => {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    renderedNodes.clear();
    drawBackgroundAssets();
    renderAreas();

    // Viewport culling: only build DOM for seats inside the visible region.
    const marginX = view.w * 0.05;
    const marginY = view.h * 0.05;
    const minX = view.x - marginX;
    const maxX = view.x + view.w + marginX;
    const minY = view.y - marginY;
    const maxY = view.y + view.h + marginY;

    const visible = [];
    for (const seat of state.seats) {
      const sx = Number(seat.x);
      const sy = Number(seat.y);
      if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue;
      visible.push(seat);
    }
    // Labels are the most expensive part; only render them when few seats show.
    const showLabels = visible.length <= LABEL_SEAT_LIMIT;

    for (const seat of visible) {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", seat.x);
      circle.setAttribute("cy", seat.y);
      circle.setAttribute("r", 8);
      circle.setAttribute("fill", seatColor(seat));
      circle.setAttribute("class", seatClass(seat));
      circle.setAttribute("data-id", seat.external_id);
      // Seat clicks/drags are handled by the unified SVG pointer handler.
      svg.appendChild(circle);
      renderedNodes.set(seat.external_id, circle);

      if (showLabels) {
        // Seat number rendered ON the seat (like the shop), not beside it.
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", seat.x);
        label.setAttribute("y", seat.y);
        label.setAttribute("class", "smartseat-seat-num");
        label.textContent = seat.seat_number;
        svg.appendChild(label);
      }
    }
    renderGroupOutlines();
    renderPolygonDraft();
    // Resize handles for the selected area, on top of seats.
    if (selectedArea !== null && state.areas[selectedArea]) {
      renderAreaHandles(state.areas[selectedArea], selectedArea);
    } else if (selected.size >= 2) {
      renderSeatRotateHandle();
    }
    // Keep alignment guides + rubber-band rect on top of everything.
    svg.appendChild(guideV);
    svg.appendChild(guideH);
    svg.appendChild(rubberRect);
    refreshInspector();
    refreshAreaInspector();
  };

  const refreshTemplatePanel = () => {
    if (!templateList) return;
    templateList.innerHTML = "";
    if (!state.template_assets.length) {
      templateList.innerHTML = '<p class="help-block">No template layers uploaded yet.</p>';
      return;
    }
    const sortedAssets = [...state.template_assets].sort((a, b) => (a.z_index || 0) - (b.z_index || 0));
    sortedAssets.forEach((asset) => {
      const row = document.createElement("div");
      row.className = "smartseat-template-row";
      row.innerHTML = `
        <div class="smartseat-template-head"><strong>${asset.name}</strong> <small>(${asset.source_kind})</small></div>
        <div class="smartseat-template-grid">
          <label>X <input type="number" data-k="x" value="${Number(asset.x || 0).toFixed(0)}"></label>
          <label>Y <input type="number" data-k="y" value="${Number(asset.y || 0).toFixed(0)}"></label>
          <label>Scale <input type="number" step="0.05" min="0.05" max="20" data-k="scale" value="${asset.scale}"></label>
          <label>Rotation <input type="number" step="1" data-k="rotation" value="${asset.rotation}"></label>
          <label>Opacity <input type="range" min="0" max="1" step="0.05" data-k="opacity" value="${asset.opacity}"></label>
          <label>Z <input type="number" step="1" data-k="z_index" value="${asset.z_index || 0}"></label>
          <label><input type="checkbox" data-k="is_visible" ${asset.is_visible ? "checked" : ""}> visible</label>
          <label><input type="checkbox" data-k="is_locked" ${asset.is_locked ? "checked" : ""}> lock</label>
        </div>
        <div class="smartseat-template-actions">
          <button type="button" data-action="nudge-left">◀</button>
          <button type="button" data-action="nudge-right">▶</button>
          <button type="button" data-action="nudge-up">▲</button>
          <button type="button" data-action="nudge-down">▼</button>
          <button type="button" data-action="delete">Delete</button>
        </div>
      `;

      row.querySelectorAll("input[data-k]").forEach((input) => {
        input.addEventListener("change", async () => {
          const key = input.getAttribute("data-k");
          let value;
          if (input.type === "checkbox") value = input.checked;
          else value = Number(input.value);
          await updateTemplateAsset(asset.id, { [key]: value });
        });
      });

      row.querySelectorAll("button[data-action]").forEach((button) => {
        button.addEventListener("click", async () => {
          const action = button.getAttribute("data-action");
          if (action === "delete") {
            if (!confirm(`Delete template layer "${asset.name}"?`)) return;
            await deleteTemplateAsset(asset.id);
            return;
          }
          const delta = 10;
          if (action === "nudge-left") await updateTemplateAsset(asset.id, { x: Number(asset.x || 0) - delta });
          if (action === "nudge-right") await updateTemplateAsset(asset.id, { x: Number(asset.x || 0) + delta });
          if (action === "nudge-up") await updateTemplateAsset(asset.id, { y: Number(asset.y || 0) - delta });
          if (action === "nudge-down") await updateTemplateAsset(asset.id, { y: Number(asset.y || 0) + delta });
        });
      });

      templateList.appendChild(row);
    });
  };

  const fetchTemplateAssets = async () => {
    if (!assetsUrl) return;
    const response = await fetch(assetsUrl, { credentials: "same-origin" });
    if (!response.ok) return;
    const data = await response.json();
    state.template_assets = data.assets || [];
    draw();
    refreshTemplatePanel();
  };

  const updateTemplateAsset = async (assetId, payload) => {
    const url = buildAssetUrl(assetsUpdateUrlTemplate, assetId);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
      body: JSON.stringify(payload),
      credentials: "same-origin",
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: "Failed to update template asset." }));
      alert(err.message || "Failed to update template asset.");
      return;
    }
    const data = await response.json();
    state.template_assets = state.template_assets.map((asset) => (asset.id === assetId ? data.asset : asset));
    draw();
    refreshTemplatePanel();
  };

  const deleteTemplateAsset = async (assetId) => {
    const url = buildAssetUrl(assetsDeleteUrlTemplate, assetId);
    const response = await fetch(url, {
      method: "POST",
      headers: { "X-CSRFToken": csrf },
      credentials: "same-origin",
    });
    if (!response.ok) {
      alert("Failed to delete template asset.");
      return;
    }
    state.template_assets = state.template_assets.filter((asset) => asset.id !== assetId);
    draw();
    refreshTemplatePanel();
  };

  if (templateUploadForm) {
    templateUploadForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(templateUploadForm);
      const response = await fetch(assetsUploadUrl, {
        method: "POST",
        headers: { "X-CSRFToken": csrf },
        body: formData,
        credentials: "same-origin",
      });
      const data = await response.json().catch(() => ({ message: "Upload failed." }));
      if (!response.ok) {
        alert(data.message || "Upload failed.");
        return;
      }
      templateUploadForm.reset();
      state.template_assets.push(data.asset);
      draw();
      refreshTemplatePanel();
    });
  }

  const addGeneratedRow = () => {
    saveSnapshot();
    const rowIndex = nextRowIndex();
    const rowLabel = buildRowLabel("A", rowIndex);
    const usedIds = existingExternalIds();
    const seatCount = Math.max(1, Math.floor(parseNumber("gen-seat-count", 20)));
    const seatSpacing = Math.max(5, parseNumber("gen-seat-spacing", 28));
    const numbering = field("gen-numbering")?.value || "sequential";
    const blockLabel = activeZone || "Main";
    const categoryCode = field("gen-category")?.value || state.categories[0]?.code || "standard";
    const baseX = placePoint ? placePoint.x : 120;
    const baseY = placePoint ? placePoint.y : 100 + rowIndex * seatSpacing;
    for (let i = 0; i < seatCount; i++) {
      const seatNumber = seatNumberForPosition(i, seatCount, numbering);
      const externalId = makeUniqueExternalId(`${blockLabel}-${rowLabel}-${seatNumber}`, usedIds);
      state.seats.push(
        createSeat({
          external_id: externalId,
          block_label: blockLabel,
          row_label: rowLabel,
          seat_number: String(seatNumber),
          seat_index: i,
          row_index: rowIndex,
          x: snap(baseX + i * seatSpacing),
          y: snap(baseY),
          rotation: 0,
          category_code: categoryCode,
        })
      );
    }
    draw();
  };

  const generateBlock = () => {
    const rowCount = Math.max(1, Math.floor(parseNumber("gen-rows", 5)));
    const seatCount = Math.max(1, Math.floor(parseNumber("gen-seat-count", 20)));
    const rowSpacing = Math.max(5, parseNumber("gen-row-spacing", 28));
    const seatSpacing = Math.max(5, parseNumber("gen-seat-spacing", 28));
    const startX = placePoint ? placePoint.x : parseNumber("gen-start-x", 120);
    const startY = placePoint ? placePoint.y : parseNumber("gen-start-y", 100);
    const numbering = field("gen-numbering")?.value || "sequential";
    const direction = field("gen-direction")?.value || "ltr";
    const categoryCode = field("gen-category")?.value || state.categories[0]?.code || "standard";
    const blockLabel = activeZone || "Main";
    const rowStartLabel = (field("gen-row-start")?.value || "A").trim() || "A";

    saveSnapshot();
    const baseRowIndex = nextRowIndex();
    const usedIds = existingExternalIds();
    const newIds = [];

    for (let r = 0; r < rowCount; r++) {
      const rowLabel = buildRowLabel(rowStartLabel, r);
      const rowIndex = baseRowIndex + r;
      for (let i = 0; i < seatCount; i++) {
        const column = direction === "rtl" ? seatCount - 1 - i : i;
        const seatNumber = seatNumberForPosition(i, seatCount, numbering);
        const externalId = makeUniqueExternalId(`${blockLabel}-${rowLabel}-${seatNumber}`, usedIds);
        newIds.push(externalId);
        state.seats.push(
          createSeat({
            external_id: externalId,
            block_label: blockLabel,
            row_label: rowLabel,
            seat_number: seatNumber,
            seat_index: i,
            row_index: rowIndex,
            x: snap(startX + column * seatSpacing),
            y: snap(startY + r * rowSpacing),
            rotation: 0,
            category_code: categoryCode,
          })
        );
      }
    }
    selected = new Set(newIds);
    selectedArea = null;
    createGroupFromIds(newIds, "Block " + rowStartLabel);
    draw();
  };

  const generateTable = () => {
    const seatCount = Math.max(1, Math.floor(parseNumber("gen-table-seats", 8)));
    const size = Math.max(15, parseNumber("gen-table-size", 45));
    const gap = Math.max(6, parseNumber("gen-table-gap", 20));
    const shape = field("gen-table-shape")?.value || "round";
    const numbering = field("gen-numbering")?.value || "sequential";
    const tableLabel = (field("gen-table-label")?.value || "T1").trim() || "T1";
    const categoryCode = field("gen-category")?.value || state.categories[0]?.code || "standard";
    const cx = snap(placePoint ? placePoint.x : view.x + view.w / 2);
    const cy = snap(placePoint ? placePoint.y : view.y + view.h / 2);

    saveSnapshot();

    // Table shape as a decorative area, linked to the seat group so it moves
    // with the table.
    const tableAreaId = newAreaId();
    if (shape === "rect") {
      state.areas.push({
        id: tableAreaId,
        shape: "rectangle", position: { x: cx - size, y: cy - size * 0.66 }, rotation: 0,
        color: "#7f1d1d", border_color: "#b91c1c", rectangle: { width: size * 2, height: size * 1.32 },
      });
    } else {
      state.areas.push({
        id: tableAreaId,
        shape: "circle", position: { x: cx, y: cy }, rotation: 0,
        color: "#7f1d1d", border_color: "#b91c1c", circle: { radius: size },
      });
    }

    const usedIds = existingExternalIds();
    // Place seats outside the table; for round tables grow the ring so a high
    // seat count never overlaps (≈20px arc length per seat as the minimum).
    const minRingRadius = (seatCount * 20) / (2 * Math.PI);
    const radius = Math.max(size + gap, minRingRadius);
    const rowIndex = nextRowIndex();
    const newIds = [];
    for (let i = 0; i < seatCount; i++) {
      const seatNumber = seatNumberForPosition(i, seatCount, numbering);
      const externalId = makeUniqueExternalId(`${activeZone}-${tableLabel}-${seatNumber}`, usedIds);
      newIds.push(externalId);
      let x, y;
      if (shape === "rect") {
        // distribute along the rectangle perimeter
        const per = seatCount, t = i / per;
        const w = size * 2 + gap, h = size * 1.32 + gap;
        const peri = 2 * (w + h), d = t * peri;
        if (d < w) { x = cx - w / 2 + d; y = cy - h / 2; }
        else if (d < w + h) { x = cx + w / 2; y = cy - h / 2 + (d - w); }
        else if (d < 2 * w + h) { x = cx + w / 2 - (d - w - h); y = cy + h / 2; }
        else { x = cx - w / 2; y = cy + h / 2 - (d - 2 * w - h); }
      } else {
        const ang = (i / seatCount) * 2 * Math.PI - Math.PI / 2;
        x = cx + Math.cos(ang) * radius;
        y = cy + Math.sin(ang) * radius;
      }
      state.seats.push(
        createSeat({
          external_id: externalId,
          block_label: activeZone || "Main",
          row_label: tableLabel,
          seat_number: seatNumber,
          seat_index: i,
          row_index: rowIndex,
          x: snap(x),
          y: snap(y),
          rotation: 0,
          category_code: categoryCode,
        })
      );
    }
    selected = new Set(newIds);
    selectedArea = null;
    ensureZones();
    createGroupFromIds(newIds, "Table " + tableLabel, [tableAreaId]);
    draw();
  };

  const generateArcRows = ({ semicircle = false } = {}) => {
    // The "Arc shape" dropdown (Arc / Semicircle) is the single source now that
    // the separate generate buttons are gone.
    const shapeField = field("gen-arc-shape");
    if (shapeField) semicircle = shapeField.value === "semicircle";
    const rowCount = Math.max(1, Math.floor(parseNumber("gen-rows", 1)));
    const seatCount = Math.max(1, Math.floor(parseNumber("gen-seat-count", 20)));
    const centerX = placePoint ? placePoint.x : parseNumber("gen-center-x", width / 2);
    const centerY = placePoint ? placePoint.y : parseNumber("gen-center-y", height / 2);
    const radiusStart = Math.max(20, parseNumber("gen-radius-start", 200));
    const rowSpacing = Math.max(5, parseNumber("gen-row-spacing", 26));
    const startAngleInput = semicircle ? -90 : parseNumber("gen-angle-start", -70);
    const endAngleInput = semicircle ? 90 : parseNumber("gen-angle-end", 70);
    const direction = field("gen-direction")?.value || "ltr";
    const numbering = field("gen-numbering")?.value || "sequential";
    const categoryCode = field("gen-category")?.value || "standard";
    const blockLabel = activeZone || "Main";
    const rowStartLabel = (field("gen-row-start")?.value || "A").trim() || "A";

    if (startAngleInput === endAngleInput) {
      alert("Start and end angle must be different.");
      return;
    }

    saveSnapshot();
    const baseRowIndex = nextRowIndex();
    const usedIds = existingExternalIds();

    for (let r = 0; r < rowCount; r++) {
      const rowLabel = buildRowLabel(rowStartLabel, r);
      const rowIndex = baseRowIndex + r;
      const radius = radiusStart + r * rowSpacing;
      for (let i = 0; i < seatCount; i++) {
        const ratio = seatCount === 1 ? 0.5 : i / (seatCount - 1);
        const linearAngle = startAngleInput + (endAngleInput - startAngleInput) * ratio;
        const angle = direction === "rtl" ? endAngleInput - (endAngleInput - startAngleInput) * ratio : linearAngle;
        const rad = (angle * Math.PI) / 180;
        const seatNumber = seatNumberForPosition(i, seatCount, numbering);
        const externalId = makeUniqueExternalId(`${blockLabel}-${rowLabel}-${seatNumber}`, usedIds);
        state.seats.push(
          createSeat({
            external_id: externalId,
            block_label: blockLabel,
            row_label: rowLabel,
            seat_number: seatNumber,
            seat_index: i,
            row_index: rowIndex,
            x: snap(centerX + Math.cos(rad) * radius),
            y: snap(centerY + Math.sin(rad) * radius),
            rotation: angle + 90,
            category_code: categoryCode,
            metadata: {
              curve: {
                center_x: centerX,
                center_y: centerY,
                radius,
                start_angle: startAngleInput,
                end_angle: endAngleInput,
              },
            },
          })
        );
      }
    }
    draw();
  };

  const deleteSelected = () => {
    if (!selected.size) return;
    saveSnapshot();
    state.seats = state.seats.filter((seat) => !selected.has(seat.external_id));
    selected.clear();
    sanitizeGroups();
    draw();
  };

  const duplicateSelected = () => {
    if (!selected.size) return;
    saveSnapshot();
    const usedIds = existingExternalIds();
    const newSeats = [];
    state.seats.forEach((seat) => {
      if (!selected.has(seat.external_id)) return;
      const proposed = `${seat.external_id}-copy`;
      const externalId = makeUniqueExternalId(proposed, usedIds);
      newSeats.push(
        createSeat({
          ...seat,
          external_id: externalId,
          seat_index: Number(seat.seat_index || 0) + 1000,
          x: snap(Number(seat.x || 0) + 18),
          y: snap(Number(seat.y || 0) + 18),
        })
      );
    });
    state.seats = state.seats.concat(newSeats);
    selected = new Set(newSeats.map((seat) => seat.external_id));
    draw();
  };

  // Mirror the selected seats around the centre of their bounding box.
  const mirrorSelected = (axis) => {
    const sel = state.seats.filter((s) => selected.has(s.external_id));
    if (sel.length < 1) return;
    let mn = Infinity, mx = -Infinity;
    sel.forEach((s) => { const v = axis === "h" ? s.x : s.y; mn = Math.min(mn, v); mx = Math.max(mx, v); });
    saveSnapshot();
    sel.forEach((s) => {
      if (axis === "h") s.x = snap(mn + mx - s.x);
      else s.y = snap(mn + mx - s.y);
    });
    draw();
  };

  // Re-number the selected seats: cluster into rows by y, sort by x (or reverse),
  // assign sequential seat numbers from a start value; optionally relabel rows.
  const renumberSelected = () => {
    if (!selected.size) return;
    const start = Math.floor(parseNumber("renum-start", 1));
    const dir = field("renum-scheme")?.value || "ltr";
    const rowBase = (field("renum-row")?.value || "").trim();
    const sel = state.seats.filter((s) => selected.has(s.external_id)).slice();
    sel.sort((a, b) => a.y - b.y || a.x - b.x);
    const BAND = 14;
    const rows = [];
    let cur = null;
    sel.forEach((s) => {
      if (!cur || Math.abs(s.y - cur.y) > BAND) { cur = { y: s.y, seats: [] }; rows.push(cur); }
      cur.seats.push(s);
    });
    saveSnapshot();
    rows.forEach((row, ri) => {
      row.seats.sort((a, b) => (dir === "rtl" ? b.x - a.x : a.x - b.x));
      row.seats.forEach((s, i) => {
        s.seat_number = String(start + i);
        if (rowBase) s.row_label = buildRowLabel(rowBase, ri);
      });
    });
    draw();
  };

  // Re-shape the selected seats as rows (seats.io-style row properties):
  // uniform seat spacing plus an optional curve (sag in px; positive bows the
  // row upwards). Rows are detected by y-position, anchored at their first seat.
  const reshapeRows = () => {
    if (!selected.size) return;
    const spacing = Math.max(5, parseNumber("rowshape-spacing", 28));
    const sag = parseNumber("rowshape-curve", 0);
    const sel = state.seats.filter((s) => selected.has(s.external_id)).slice();
    sel.sort((a, b) => a.y - b.y || a.x - b.x);
    const BAND = 14;
    const rows = [];
    let cur = null;
    sel.forEach((s) => {
      if (!cur || Math.abs(s.y - cur.y) > BAND) { cur = { y: s.y, seats: [] }; rows.push(cur); }
      cur.seats.push(s);
    });
    saveSnapshot();
    rows.forEach((row) => {
      row.seats.sort((a, b) => a.x - b.x);
      const n = row.seats.length;
      const first = row.seats[0];
      const baseX = first.x, baseY = row.y;
      row.seats.forEach((s, i) => {
        const t = n > 1 ? i / (n - 1) : 0.5;
        s.x = clampX(snap(baseX + i * spacing));
        s.y = clampY(snap(baseY - sag * (4 * t * (1 - t))));
      });
    });
    draw();
  };

  // Copy / paste of a seat selection (paste lands with a small offset).
  let clipboard = null;
  const copySelection = () => {
    if (!selected.size) return;
    clipboard = state.seats.filter((s) => selected.has(s.external_id))
      .map((s) => JSON.parse(JSON.stringify(s)));
  };
  const pasteClipboard = (at) => {
    if (!clipboard || !clipboard.length) return;
    saveSnapshot();
    const usedIds = existingExternalIds();
    // Default: small offset. With a target point (context menu "Paste here"),
    // the clipboard's top-left corner lands at the click position.
    let dx = 24, dy = 24;
    if (at) {
      let mnx = Infinity, mny = Infinity;
      clipboard.forEach((s) => { mnx = Math.min(mnx, Number(s.x || 0)); mny = Math.min(mny, Number(s.y || 0)); });
      dx = at.x - mnx; dy = at.y - mny;
    }
    const newSeats = clipboard.map((s) => createSeat({
      ...s,
      external_id: makeUniqueExternalId(`${s.external_id}-copy`, usedIds),
      seat_index: Number(s.seat_index || 0) + 1000,
      x: clampX(snap(Number(s.x || 0) + dx)),
      y: clampY(snap(Number(s.y || 0) + dy)),
    }));
    state.seats = state.seats.concat(newSeats);
    selected = new Set(newSeats.map((s) => s.external_id));
    draw();
  };

  // ─── Plan validation report ───────────────────────────────────────────────
  const validatePlan = () => {
    const issues = [];
    const cats = new Set((state.categories || []).map((c) => c.code));
    if (!state.seats.length) issues.push({ level: "error", msg: "Plan contains no seats." });
    if (!(state.categories || []).length) issues.push({ level: "error", msg: "No categories (price zones) defined." });
    const noCat = state.seats.filter((s) => !s.category_code || !cats.has(s.category_code));
    if (noCat.length) issues.push({
      level: "error", msg: `${noCat.length} seat(s) without a valid category`,
      examples: noCat.slice(0, 5).map((s) => `${s.row_label || "?"}${s.seat_number || "?"}`),
    });
    const seen = new Set(), dups = new Set();
    state.seats.forEach((s) => {
      const k = `${s.block_label || ""}|${s.row_label || ""}|${s.seat_number || ""}`;
      if (seen.has(k)) dups.add(`${s.row_label || "?"}${s.seat_number || "?"}`); else seen.add(k);
    });
    if (dups.size) issues.push({ level: "warn", msg: `${dups.size} duplicate seat label(s)`, examples: [...dups].slice(0, 5) });
    const W = canvasW(), H = canvasH();
    const out = state.seats.filter((s) => s.x < 0 || s.x > W || s.y < 0 || s.y > H);
    if (out.length) issues.push({ level: "warn", msg: `${out.length} seat(s) outside the canvas` });
    const used = new Set(state.seats.map((s) => s.category_code));
    const unused = (state.categories || []).filter((c) => !used.has(c.code));
    if (unused.length) issues.push({ level: "info", msg: `${unused.length} category(ies) with no seats`, examples: unused.map((c) => c.name).slice(0, 5) });
    return issues;
  };

  const renderValidation = () => {
    const el = document.getElementById("smartseat-validation");
    if (!el) return;
    el.innerHTML = "";
    const issues = validatePlan();
    if (!issues.length) {
      const ok = document.createElement("p");
      ok.className = "smartseat-valid-ok";
      ok.textContent = "✓ No problems found — ready to apply.";
      el.appendChild(ok);
      return;
    }
    issues.forEach((i) => {
      const row = document.createElement("div");
      row.className = "smartseat-valid-item " + i.level;
      row.textContent = i.msg + (i.examples && i.examples.length ? ` (${i.examples.join(", ")})` : "");
      el.appendChild(row);
    });
  };

  const undo = () => {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(state));
    state = JSON.parse(undoStack.pop());
    selected.clear();
    selectedArea = null;
    ensureZones();
    populateCategoryOptions();
    populateInspectorCategorySelect();
    refreshCategoryList();
    refreshGroupList();
    refreshZoneList();
    draw();
    refreshTemplatePanel();
  };

  const redo = () => {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(state));
    state = JSON.parse(redoStack.pop());
    selected.clear();
    selectedArea = null;
    ensureZones();
    populateCategoryOptions();
    populateInspectorCategorySelect();
    refreshCategoryList();
    refreshGroupList();
    refreshZoneList();
    draw();
    refreshTemplatePanel();
  };

  const save = async () => {
    const response = await fetch(saveUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
      body: JSON.stringify({
        seats: state.seats,
        categories: state.categories,
        areas: state.areas,
        groups: state.groups,
        zones: state.zones,
        plan: state.plan,
        bounds: state.bounds,
      }),
      credentials: "same-origin",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showSaveFeedback(false, (data.issues || []).map((i) => i.message || i.code).join(" · ") || "Save failed");
      return false;
    }
    showSaveFeedback(true);
    return true;
  };

  // Transient saved overlay with an animated check mark (replaces alert()).
  const showSaveFeedback = (ok, message) => {
    const wrap = document.createElement("div");
    wrap.className = "smartseat-saved" + (ok ? "" : " is-error");
    if (ok) {
      wrap.innerHTML =
        '<div class="smartseat-saved-badge">' +
        '<svg width="64" height="64" viewBox="0 0 60 60" aria-hidden="true">' +
        '<circle class="smartseat-check-circle" cx="30" cy="30" r="27"/>' +
        '<path class="smartseat-check-mark" d="M18 31 L26 39 L43 20"/>' +
        "</svg></div>";
      setTimeout(() => wrap.remove(), 1500);
    } else {
      wrap.innerHTML =
        '<div class="smartseat-saved-badge">' +
        '<svg width="64" height="64" viewBox="0 0 60 60" aria-hidden="true">' +
        '<circle class="smartseat-check-circle smartseat-x-circle" cx="30" cy="30" r="27"/>' +
        '<path class="smartseat-check-mark smartseat-x-mark" d="M20 20 L40 40 M40 20 L20 40"/>' +
        "</svg>" +
        '<div class="smartseat-saved-text"></div></div>';
      wrap.querySelector(".smartseat-saved-text").textContent = message || "Save failed";
      setTimeout(() => wrap.remove(), 3500);
    }
    document.body.appendChild(wrap);
  };

  const load = async () => {
    try {
      const response = await fetch(exportUrl, { credentials: "same-origin" });
      if (response.ok) {
        const data = await response.json();
        state = {
          plan: data.plan,
          categories: data.categories?.length ? data.categories : state.categories,
          seats: data.seats || [],
          areas: data.areas || [],
          groups: data.groups || [],
          zones: data.zones && data.zones.length ? data.zones : [{ name: "Main" }],
          template_assets: [],
          bounds: { width: data.plan.width, height: data.plan.height },
        };
      }
    } catch (_err) {
      // Keep fallback state.
    }
    sanitizeGroups(); // drop stale/orphaned group references from older saves
    field("gen-center-x").value = Math.round(state.bounds.width / 2);
    field("gen-center-y").value = Math.round(state.bounds.height / 2);
    if (field("plan-width")) field("plan-width").value = state.bounds.width;
    if (field("plan-height")) field("plan-height").value = state.bounds.height;
    activeZone = (state.zones && state.zones[0] && state.zones[0].name) || "Main";
    ensureZones();
    populateCategoryOptions();
    populateInspectorCategorySelect();
    refreshCategoryList();
    refreshGroupList();
    refreshZoneList();
    await fetchTemplateAssets();
    resetView(); // fit the freshly loaded plan into the viewport (also draws)
  };

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
      event.preventDefault();
      duplicateSelected();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      if (selectedArea !== null) deleteArea(selectedArea);
      else deleteSelected();
    }
  });

  // ─── Zones (first-class; a seat's block_label is its zone name) ────────────
  const zoneListEl = document.getElementById("smartseat-zone-list");

  const ensureZones = () => {
    if (!Array.isArray(state.zones)) state.zones = [];
    const names = state.zones.map((z) => z.name);
    state.seats.forEach((s) => {
      const z = s.block_label || "Main";
      if (!names.includes(z)) { names.push(z); state.zones.push({ name: z }); }
    });
    if (!state.zones.length) state.zones = [{ name: "Main" }];
    if (!state.zones.some((z) => z.name === activeZone)) activeZone = state.zones[0].name;
  };

  const uniqueZoneName = (base) => {
    const used = new Set(state.zones.map((z) => z.name));
    let name = base, i = 2;
    while (used.has(name)) name = `${base} ${i++}`;
    return name;
  };

  const addZone = () => {
    saveSnapshot();
    const name = uniqueZoneName("Zone");
    state.zones.push({ name });
    activeZone = name;
    refreshZoneList();
  };

  const setActiveZone = (name) => {
    activeZone = name;
    // Selecting a zone selects its seats (faithful to seats.pretix.eu).
    selected = new Set(state.seats.filter((s) => (s.block_label || "Main") === name).map((s) => s.external_id));
    selectedArea = null;
    refreshZoneList();
    draw();
  };

  const renameZone = (oldName, newName) => {
    newName = (newName || "").trim();
    if (!newName || newName === oldName) { refreshZoneList(); return; }
    if (state.zones.some((z) => z.name === newName)) { refreshZoneList(); return; } // no collision
    saveSnapshot();
    state.zones.forEach((z) => { if (z.name === oldName) z.name = newName; });
    state.seats.forEach((s) => { if ((s.block_label || "Main") === oldName) s.block_label = newName; });
    if (activeZone === oldName) activeZone = newName;
    refreshZoneList();
    draw();
  };

  const deleteZone = (name) => {
    if (state.zones.length <= 1) { alert("At least one zone is required."); return; }
    const count = state.seats.filter((s) => (s.block_label || "Main") === name).length;
    if (!confirm(`Delete zone "${name}"${count ? ` and its ${count} seat(s)` : ""}?`)) return;
    saveSnapshot();
    state.seats = state.seats.filter((s) => (s.block_label || "Main") !== name);
    state.zones = state.zones.filter((z) => z.name !== name);
    if (activeZone === name) activeZone = state.zones[0].name;
    selected = new Set();
    refreshZoneList();
    draw();
  };

  const refreshZoneList = () => {
    if (!zoneListEl) return;
    ensureZones();
    zoneListEl.innerHTML = "";
    state.zones.forEach((z) => {
      const count = state.seats.filter((s) => (s.block_label || "Main") === z.name).length;
      const row = document.createElement("div");
      row.className = "smartseat-zone-row" + (z.name === activeZone ? " active" : "");
      const dot = document.createElement("button");
      dot.type = "button"; dot.className = "smartseat-zone-dot"; dot.title = "Make active & select";
      dot.textContent = z.name === activeZone ? "◉" : "◯";
      dot.addEventListener("click", () => setActiveZone(z.name));
      const name = document.createElement("input");
      name.type = "text"; name.value = z.name;
      name.addEventListener("change", () => renameZone(z.name, name.value));
      const cnt = document.createElement("span");
      cnt.className = "smartseat-zone-count"; cnt.textContent = String(count);
      const del = document.createElement("button");
      del.type = "button"; del.className = "smartseat-zone-del"; del.textContent = "⨯"; del.title = "Delete zone";
      del.addEventListener("click", () => deleteZone(z.name));
      row.append(dot, name, cnt, del);
      zoneListEl.appendChild(row);
    });
  };

  // ─── Groups (flat + nestable) ──────────────────────────────────────────────
  const groupListEl = document.getElementById("smartseat-group-list");
  const childrenOf = (gid) => (state.groups || []).filter((g) => g.parent === gid);
  const groupSeatIds = (g) => {
    let ids = [...(g.seat_ids || [])];
    childrenOf(g.id).forEach((c) => { ids = ids.concat(groupSeatIds(c)); });
    return ids;
  };
  const newGroupId = () => "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Self-heal groups: drop references to seats that no longer exist and remove
  // groups that end up empty (e.g. after deleting seats, or stale data from an
  // older save). Without this a group can reference dead seat ids and a table
  // then looks "ungrouped".
  const sanitizeGroups = () => {
    if (!state.groups || !state.groups.length) return;
    const live = new Set(state.seats.map((s) => s.external_id));
    const liveAreas = new Set((state.areas || []).map((a) => a.id).filter(Boolean));
    state.groups.forEach((g) => {
      g.seat_ids = (g.seat_ids || []).filter((id) => live.has(id));
      if (g.area_ids) g.area_ids = g.area_ids.filter((id) => liveAreas.has(id));
    });
    const hasChildren = (id) => state.groups.some((g) => g.parent === id);
    state.groups = state.groups.filter((g) => (g.seat_ids && g.seat_ids.length) || hasChildren(g.id));
    const ids = new Set(state.groups.map((g) => g.id));
    state.groups.forEach((g) => { if (g.parent && !ids.has(g.parent)) g.parent = null; });
  };

  // Areas linked to groups whose seats are ALL currently selected → move with
  // the selection (e.g. a table shape together with its surrounding seats).
  const linkedAreasForSelection = () => {
    const out = [], seen = new Set();
    (state.groups || []).forEach((g) => {
      if (!g.area_ids || !g.area_ids.length) return;
      const ids = groupSeatIds(g);
      if (!ids.length || !ids.every((id) => selected.has(id))) return;
      g.area_ids.forEach((aid) => {
        const idx = (state.areas || []).findIndex((a) => a.id === aid);
        if (idx >= 0 && !seen.has(idx)) {
          seen.add(idx);
          const a = state.areas[idx];
          out.push({ idx, x: Number(a.position?.x || 0), y: Number(a.position?.y || 0) });
        }
      });
    });
    return out;
  };

  // The outermost (top-level) group a seat belongs to, or null.
  const topGroupForSeat = (seatId) => {
    const groups = state.groups || [];
    let found = null;
    for (const g of groups) {
      if (groupSeatIds(g).includes(seatId)) { found = g; break; }
    }
    if (!found) return null;
    let top = found, guard = 0;
    while (top.parent && guard++ < 50) {
      const p = groups.find((x) => x.id === top.parent);
      if (!p) break;
      top = p;
    }
    return top;
  };

  // Seat ids to select when a seat is clicked.
  //  - Alt held → always just the single seat.
  //  - We're inside this seat's group (double-clicked into it) → single seat.
  //  - Otherwise → the whole group (and we leave any entered group).
  const groupAwareIds = (seatId, alt) => {
    if (alt) return [seatId];
    const g = topGroupForSeat(seatId);
    if (!g) { activeGroup = null; return [seatId]; }
    if (activeGroup === g.id) return [seatId];
    activeGroup = null;
    const live = groupSeatIds(g).filter((id) => state.seats.some((s) => s.external_id === id));
    return live.length ? live : [seatId];
  };

  // Create a group straight from a list of seat ids (used by the table / block
  // generators so a placed table or block is grouped right away).
  const createGroupFromIds = (ids, name, areaIds) => {
    if (!ids || !ids.length) return null;
    if (!state.groups) state.groups = [];
    const id = newGroupId();
    state.groups.push({
      id, parent: null, seat_ids: [...ids],
      area_ids: areaIds ? [...areaIds] : [],
      name: name || "Group " + (state.groups.length + 1),
    });
    refreshGroupList();
    return id;
  };

  const groupSelected = () => {
    if (!selected.size) return;
    saveSnapshot();
    const id = newGroupId();
    const directSeatIds = new Set(selected);
    // Existing top-level groups fully inside the selection become children.
    (state.groups || []).forEach((g) => {
      if (g.parent) return;
      const gids = groupSeatIds(g);
      if (gids.length && gids.every((sid) => selected.has(sid))) {
        g.parent = id;
        gids.forEach((sid) => directSeatIds.delete(sid));
      }
    });
    state.groups.push({ id, name: "Group " + (state.groups.length + 1), seat_ids: [...directSeatIds], parent: null });
    refreshGroupList();
    draw();
  };

  const selectGroup = (gid) => {
    const g = (state.groups || []).find((x) => x.id === gid);
    if (!g) return;
    selected = new Set(groupSeatIds(g).filter((sid) => state.seats.some((s) => s.external_id === sid)));
    selectedArea = null;
    draw();
  };

  const ungroup = (gid) => {
    const g = (state.groups || []).find((x) => x.id === gid);
    if (!g) return;
    saveSnapshot();
    childrenOf(gid).forEach((c) => { c.parent = g.parent; });
    state.groups = state.groups.filter((x) => x.id !== gid);
    refreshGroupList();
  };

  const refreshGroupList = () => {
    if (!groupListEl) return;
    groupListEl.innerHTML = "";
    const tops = (state.groups || []).filter((g) => !g.parent);
    if (!tops.length) {
      groupListEl.innerHTML = '<p class="smartseat-insp-hint">No groups yet.</p>';
      return;
    }
    const renderRow = (g, depth) => {
      const row = document.createElement("div");
      row.className = "smartseat-group-row";
      row.style.paddingLeft = `${depth * 14}px`;
      const name = document.createElement("input");
      name.type = "text";
      name.value = g.name || "Group";
      name.addEventListener("change", () => { g.name = name.value; });
      const selBtn = document.createElement("button");
      selBtn.type = "button";
      selBtn.textContent = "◉";
      selBtn.title = "Select group";
      selBtn.addEventListener("click", () => selectGroup(g.id));
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.textContent = "⨯";
      delBtn.title = "Ungroup";
      delBtn.addEventListener("click", () => ungroup(g.id));
      const count = document.createElement("span");
      count.className = "smartseat-group-count";
      count.textContent = groupSeatIds(g).length + "♦";
      row.append(selBtn, name, count, delBtn);
      groupListEl.appendChild(row);
      childrenOf(g.id).forEach((c) => renderRow(c, depth + 1));
    };
    tops.forEach((g) => renderRow(g, 0));
  };

  // ─── Action routing (top bar + tool actions + inspector buttons) ───────────
  const handleAction = (action) => {
    switch (action) {
      case "add-row": addGeneratedRow(); break;
      case "generate-block": generateBlock(); break;
      case "generate-arc": generateArcRows({ semicircle: false }); break;
      case "generate-semicircle": generateArcRows({ semicircle: true }); break;
      case "generate-table": generateTable(); break;
      case "add-stage": addArea("rectangle"); break;
      case "add-ellipse": addArea("ellipse"); break;
      case "add-label": addArea("text"); break;
      case "generate-sector": generateSector(); break;
      case "set-focal": setFocalPoint(); break;
      case "duplicate-selected": duplicateSelected(); break;
      case "delete-selected": deleteSelected(); break;
      case "group-selected": groupSelected(); break;
      case "mirror-h": mirrorSelected("h"); break;
      case "mirror-v": mirrorSelected("v"); break;
      case "renumber-selected": renumberSelected(); break;
      case "reshape-rows": reshapeRows(); break;
      case "validate-plan": renderValidation(); break;
      case "add-zone": addZone(); break;
      case "add-category": addCategory(); break;
      case "delete-area": if (selectedArea !== null) deleteArea(selectedArea); break;
      case "undo": undo(); break;
      case "redo": redo(); break;
      case "save": save(); break;
      default: break;
    }
  };
  document.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleAction(btn.getAttribute("data-action")));
  });
  document.querySelectorAll("[data-tool-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleAction(btn.getAttribute("data-tool-action")));
  });

  // ─── Context menu (right-click on seats / areas / canvas) ──────────────────
  const ctxMenu = document.createElement("div");
  ctxMenu.className = "smartseat-ctx";
  ctxMenu.hidden = true;
  host.appendChild(ctxMenu);
  const hideCtx = () => { ctxMenu.hidden = true; };
  window.addEventListener("pointerdown", (e) => { if (!ctxMenu.contains(e.target)) hideCtx(); }, true);
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") hideCtx(); });
  svg.addEventListener("wheel", hideCtx, { passive: true });

  const showCtx = (event, items) => {
    ctxMenu.innerHTML = "";
    items.forEach((it) => {
      if (it === "-") {
        const sep = document.createElement("div");
        sep.className = "smartseat-ctx-sep";
        ctxMenu.appendChild(sep);
        return;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = it.label;
      if (it.disabled) b.disabled = true;
      b.addEventListener("click", () => { hideCtx(); it.run(); });
      ctxMenu.appendChild(b);
    });
    const hostRect = host.getBoundingClientRect();
    ctxMenu.hidden = false;
    ctxMenu.style.left = Math.min(event.clientX - hostRect.left, hostRect.width - 190) + "px";
    ctxMenu.style.top = Math.min(event.clientY - hostRect.top, hostRect.height - items.length * 32 - 16) + "px";
  };

  svg.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const svgPt = clientToSvg(event.clientX, event.clientY);
    const seatId = event.target?.getAttribute?.("data-id");
    const areaEl = event.target?.closest?.("[data-area-index]");

    if (seatId) {
      // Right-click outside the current selection re-targets it first.
      if (!selected.has(seatId)) {
        selected = new Set(groupAwareIds(seatId, event.altKey));
        selectedArea = null;
        draw();
      }
      showCtx(event, [
        { label: "Duplicate", run: duplicateSelected },
        { label: "Copy", run: copySelection },
        { label: "Mirror horizontally", run: () => mirrorSelected("h") },
        { label: "Mirror vertically", run: () => mirrorSelected("v") },
        { label: "Group", run: groupSelected },
        "-",
        { label: "Delete", run: deleteSelected },
      ]);
      return;
    }
    if (areaEl) {
      const idx = parseInt(areaEl.getAttribute("data-area-index"), 10);
      selectedArea = idx;
      selected = new Set();
      draw();
      setSidebarTab("edit");
      showCtx(event, [
        { label: "Delete area", run: () => deleteArea(idx) },
      ]);
      return;
    }
    showCtx(event, [
      { label: "Paste here", disabled: !clipboard || !clipboard.length,
        run: () => pasteClipboard({ x: clampX(snap(svgPt.x)), y: clampY(snap(svgPt.y)) }) },
      { label: "Fit view", run: resetView },
    ]);
  });

  // ─── Tool palette ──────────────────────────────────────────────────────────
  const TOOL_TITLES = {
    select: "Select / move", row: "Add row", block: "Add block",
    arc: "Add arc / semicircle", table: "Add table",
    stage: "Add stage / area", round: "Add round area", label: "Add label",
    polygon: "Draw polygon", curve: "Draw curve (decoration)",
    sector: "Ring sector (grandstand)", focal: "Set focal point",
  };
  const setTool = (tool) => {
    if (isPolyTool() && tool !== "polygon" && tool !== "curve" && polyPoints) cancelPolygon();
    activeTool = tool;
    document.querySelectorAll(".smartseat-tool").forEach((b) =>
      b.classList.toggle("active", b.getAttribute("data-tool") === tool));
    document.querySelectorAll("[data-tools]").forEach((el) => {
      const tools = (el.getAttribute("data-tools") || "").split(/\s+/);
      el.hidden = !tools.includes(tool);
    });
    const title = document.querySelector('[data-role="tool-title"]');
    if (title) title.textContent = TOOL_TITLES[tool] || "Tool";
    // A creation tool turns the canvas into a "click to place" surface.
    svg.classList.toggle("smartseat-placing", !!GENERATOR_TOOLS[tool] || tool === "polygon" || tool === "curve");
  };
  document.querySelectorAll(".smartseat-tool").forEach((b) => {
    b.addEventListener("click", () => {
      const t = b.getAttribute("data-tool");
      setTool(t);
      // Creation tools live on the Build tab; jump there for their settings.
      if (t !== "select") setSidebarTab("build");
    });
  });

  // ─── Sidebar tabs ───────────────────────────────────────────────────────────
  const setSidebarTab = (name) => {
    document.querySelectorAll("[data-tab-btn]").forEach((b) =>
      b.classList.toggle("active", b.getAttribute("data-tab-btn") === name));
    document.querySelectorAll("[data-tab]").forEach((sec) => {
      sec.hidden = sec.getAttribute("data-tab") !== name;
    });
    if (name === "edit") applyEditContext();
  };
  document.querySelectorAll("[data-tab-btn]").forEach((b) => {
    b.addEventListener("click", () => setSidebarTab(b.getAttribute("data-tab-btn")));
  });

  setTool("select");
  setSidebarTab("build");

  // "Apply to event" must use the latest edits → save first, then navigate.
  var applyLink = document.getElementById("smartseat-apply");
  if (applyLink) {
    applyLink.addEventListener("click", function (event) {
      event.preventDefault();
      var href = applyLink.getAttribute("href");
      Promise.resolve(save()).then(function (ok) {
        if (ok) window.location.href = href;
      });
    });
  }

  field("insp-category")?.addEventListener("change", (event) => {
    const code = event.target.value;
    if (code === "") return; // "mixed / keep" → leave as-is
    applyToSelection((s) => {
      s.category_code = code;
    });
  });

  field("insp-seat-type")?.addEventListener("change", (event) => {
    const type = event.target.value;
    if (type === "") return;
    applyToSelection((s) => {
      s.seat_type = type;
      // Seat type is the single source of truth; derive the legacy flags so
      // rendering and the native export (blocked) stay consistent.
      s.is_accessible = type === "wheelchair";
      s.is_companion = type === "companion";
      s.is_technical_blocked = type === "technical";
    });
  });

  // "Blocked (not sold)" is an independent status (e.g. a broken seat),
  // separate from the seat type.
  field("insp-blocked")?.addEventListener("change", (event) => {
    applyToSelection((s) => { s.is_blocked = event.target.checked; });
  });

  const wirePlanDim = (fieldName, key) => {
    field(fieldName)?.addEventListener("change", (event) => {
      const v = Math.max(100, parseInt(event.target.value, 10) || 0);
      saveSnapshot();
      state.plan[key] = v;
      state.bounds[key] = v;
      resetView();
    });
  };
  wirePlanDim("plan-width", "width");
  wirePlanDim("plan-height", "height");

  document.querySelectorAll("[data-align]").forEach((btn) => {
    btn.addEventListener("click", () => alignSelection(btn.getAttribute("data-align")));
  });
  document.querySelectorAll("[data-dist]").forEach((btn) => {
    btn.addEventListener("click", () => distributeSelection(btn.getAttribute("data-dist")));
  });

  load();
})();

