(function () {
  const host = document.getElementById("smartseat-editor");
  if (!host) return;

  const width = Number(host.dataset.width || 1200);
  const height = Number(host.dataset.height || 800);
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

  let spaceDown = false;
  let pointerMode = null; // 'pan' | 'rubber' | 'seat-wait' | 'seat-drag'
  let pointerData = {};

  window.addEventListener("keydown", (e) => {
    if (e.key === " " && document.activeElement === document.body) {
      e.preventDefault();
      spaceDown = true;
      svg.classList.add("smartseat-space");
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

    // Resize handle of the selected area takes priority over everything.
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
      // Empty canvas – start rubber-band.
      svg.setPointerCapture(event.pointerId);
      pointerMode = "rubber";
      pointerData = { startClientX: event.clientX, startClientY: event.clientY, startSvgX: svgPt.x, startSvgY: svgPt.y };
    }
  });

  svg.addEventListener("pointermove", (event) => {
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
        // Elevate to drag: make the dragged seat selected if it wasn't.
        if (!selected.has(pointerData.seat.external_id)) {
          selected = new Set([pointerData.seat.external_id]);
          scheduleDraw();
        }
        // Snapshot positions of all selected seats at drag start.
        pointerData.origPositions = {};
        for (const s of state.seats) {
          if (selected.has(s.external_id)) {
            pointerData.origPositions[s.external_id] = { x: s.x, y: s.y };
          }
        }
        svg.classList.add("smartseat-dragging");
        pointerMode = "seat-drag";
      }

      // Compute snapped delta (snap via lead seat so group stays coherent).
      const cur = clientToSvg(event.clientX, event.clientY);
      const rawDx = cur.x - pointerData.startSvgX;
      const rawDy = cur.y - pointerData.startSvgY;
      const leadOrig = pointerData.origPositions[pointerData.seat.external_id];
      const effDx = snap(leadOrig.x + rawDx) - leadOrig.x;
      const effDy = snap(leadOrig.y + rawDy) - leadOrig.y;

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
      const nx = snap(pointerData.orig.x + (cur.x - pointerData.startSvgX));
      const ny = snap(pointerData.orig.y + (cur.y - pointerData.startSvgY));
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
      scheduleDraw();
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
        // Treated as a click on the canvas → clear selection.
        if (selected.size || selectedArea !== null) {
          selected = new Set();
          selectedArea = null;
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
        if (selected.has(pointerData.seat.external_id)) selected.delete(pointerData.seat.external_id);
        else selected.add(pointerData.seat.external_id);
        applySelectionClass(pointerData.seat.external_id);
      } else {
        const prev = Array.from(selected);
        selected = new Set([pointerData.seat.external_id]);
        prev.forEach(applySelectionClass);
        applySelectionClass(pointerData.seat.external_id);
      }
      refreshInspector();
      return;
    }

    if (pointerMode === "seat-drag") {
      pointerMode = null;
      svg.classList.remove("smartseat-dragging");
      // Commit new positions into state.seats.
      saveSnapshot();
      for (const s of state.seats) {
        if (!selected.has(s.external_id)) continue;
        const node = renderedNodes.get(s.external_id);
        if (node) {
          s.x = parseFloat(node.getAttribute("cx"));
          s.y = parseFloat(node.getAttribute("cy"));
        }
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

    pointerMode = null;
  };

  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);
  svg.addEventListener("dblclick", resetView);

  let state = {
    seats: [],
    areas: [],
    groups: [],
    template_assets: [],
    categories: [{ code: "standard", name: "Standard", color: "#3B82F6", price_rank: 100 }],
    bounds: { width, height },
    plan: { width, height, grid_size: 10, snap_enabled: true },
  };
  let selected = new Set();
  let selectedArea = null; // index into state.areas, or null
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

  const refreshInspector = () => {
    refreshPlanInfo();
    const fields = document.querySelector('[data-role="sel-fields"]');
    const empty = document.querySelector('[data-role="sel-empty"]');
    const count = document.querySelector('[data-role="sel-count"]');
    if (count) count.textContent = String(selected.size);
    if (!fields || !empty) return;
    if (!selected.size) {
      fields.hidden = true;
      empty.hidden = false;
      return;
    }
    fields.hidden = false;
    empty.hidden = true;
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
    setCheck("insp-accessible", (s) => !!s.is_accessible);
    setCheck("insp-companion", (s) => !!s.is_companion);
    setCheck("insp-blocked", (s) => !!s.is_blocked);
    setCheck("insp-technical", (s) => !!s.is_technical_blocked);
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
    const section = document.querySelector('[data-role="area-section"]');
    if (!section || !areaFieldsEl) return;
    const area = selectedArea !== null ? state.areas[selectedArea] : null;
    if (!area) {
      section.hidden = true;
      areaFieldsEl.innerHTML = "";
      return;
    }
    section.hidden = false;
    areaFieldsEl.innerHTML = "";

    const typeLine = document.createElement("p");
    typeLine.className = "smartseat-insp-hint";
    typeLine.textContent = "Type: " + area.shape;
    areaFieldsEl.appendChild(typeLine);

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

  const newArea = (shape) => {
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;
    const base = { shape, position: { x: snap(cx), y: snap(cy) }, rotation: 0 };
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
    g.setAttribute("class", `smartseat-area${index === selectedArea ? " selected" : ""}`);

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
    svg.appendChild(g);
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
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", seat.x + 10);
        label.setAttribute("y", seat.y + 4);
        label.setAttribute("font-size", "10");
        label.textContent = `${seat.row_label}${seat.seat_number}`;
        svg.appendChild(label);
      }
    }
    // Resize handles for the selected area, on top of seats.
    if (selectedArea !== null && state.areas[selectedArea]) {
      renderAreaHandles(state.areas[selectedArea], selectedArea);
    }
    // Keep rubber-band rect on top of everything.
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
    const blockLabel = (field("gen-block")?.value || "A").trim() || "A";
    const categoryCode = field("gen-category")?.value || state.categories[0]?.code || "standard";
    for (let i = 0; i < seatCount; i++) {
      const seatNumber = i + 1;
      const externalId = makeUniqueExternalId(`${blockLabel}-${rowLabel}-${seatNumber}`, usedIds);
      state.seats.push(
        createSeat({
          external_id: externalId,
          block_label: blockLabel,
          row_label: rowLabel,
          seat_number: String(seatNumber),
          seat_index: i,
          row_index: rowIndex,
          x: snap(120 + i * seatSpacing),
          y: snap(100 + rowIndex * seatSpacing),
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
    const startX = parseNumber("gen-start-x", 120);
    const startY = parseNumber("gen-start-y", 100);
    const numbering = field("gen-numbering")?.value || "sequential";
    const direction = field("gen-direction")?.value || "ltr";
    const categoryCode = field("gen-category")?.value || state.categories[0]?.code || "standard";
    const blockLabel = (field("gen-block")?.value || "A").trim() || "A";
    const rowStartLabel = (field("gen-row-start")?.value || "A").trim() || "A";

    saveSnapshot();
    const baseRowIndex = nextRowIndex();
    const usedIds = existingExternalIds();

    for (let r = 0; r < rowCount; r++) {
      const rowLabel = buildRowLabel(rowStartLabel, r);
      const rowIndex = baseRowIndex + r;
      for (let i = 0; i < seatCount; i++) {
        const column = direction === "rtl" ? seatCount - 1 - i : i;
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
            x: snap(startX + column * seatSpacing),
            y: snap(startY + r * rowSpacing),
            rotation: 0,
            category_code: categoryCode,
          })
        );
      }
    }
    draw();
  };

  const generateArcRows = ({ semicircle = false } = {}) => {
    const rowCount = Math.max(1, Math.floor(parseNumber("gen-rows", 1)));
    const seatCount = Math.max(1, Math.floor(parseNumber("gen-seat-count", 20)));
    const centerX = parseNumber("gen-center-x", width / 2);
    const centerY = parseNumber("gen-center-y", height / 2);
    const radiusStart = Math.max(20, parseNumber("gen-radius-start", 200));
    const rowSpacing = Math.max(5, parseNumber("gen-row-spacing", 26));
    const startAngleInput = semicircle ? -90 : parseNumber("gen-angle-start", -70);
    const endAngleInput = semicircle ? 90 : parseNumber("gen-angle-end", 70);
    const direction = field("gen-direction")?.value || "ltr";
    const numbering = field("gen-numbering")?.value || "sequential";
    const categoryCode = field("gen-category")?.value || "standard";
    const blockLabel = (field("gen-block")?.value || "A").trim() || "A";
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

  const undo = () => {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(state));
    state = JSON.parse(undoStack.pop());
    selected.clear();
    selectedArea = null;
    populateCategoryOptions();
    populateInspectorCategorySelect();
    refreshCategoryList();
    refreshGroupList();
    draw();
    refreshTemplatePanel();
  };

  const redo = () => {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(state));
    state = JSON.parse(redoStack.pop());
    selected.clear();
    selectedArea = null;
    populateCategoryOptions();
    populateInspectorCategorySelect();
    refreshCategoryList();
    refreshGroupList();
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
        plan: state.plan,
        bounds: state.bounds,
      }),
      credentials: "same-origin",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      alert(`Validation failed: ${JSON.stringify(data.issues || data)}`);
      return;
    }
    alert("Seat plan saved.");
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
          template_assets: [],
          bounds: { width: data.plan.width, height: data.plan.height },
        };
      }
    } catch (_err) {
      // Keep fallback state.
    }
    field("gen-center-x").value = Math.round(state.bounds.width / 2);
    field("gen-center-y").value = Math.round(state.bounds.height / 2);
    if (field("plan-width")) field("plan-width").value = state.bounds.width;
    if (field("plan-height")) field("plan-height").value = state.bounds.height;
    populateCategoryOptions();
    populateInspectorCategorySelect();
    refreshCategoryList();
    refreshGroupList();
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

  // ─── Groups (flat + nestable) ──────────────────────────────────────────────
  const groupListEl = document.getElementById("smartseat-group-list");
  const childrenOf = (gid) => (state.groups || []).filter((g) => g.parent === gid);
  const groupSeatIds = (g) => {
    let ids = [...(g.seat_ids || [])];
    childrenOf(g.id).forEach((c) => { ids = ids.concat(groupSeatIds(c)); });
    return ids;
  };
  const newGroupId = () => "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

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
      case "add-stage": addArea("rectangle"); break;
      case "add-ellipse": addArea("ellipse"); break;
      case "add-label": addArea("text"); break;
      case "duplicate-selected": duplicateSelected(); break;
      case "delete-selected": deleteSelected(); break;
      case "group-selected": groupSelected(); break;
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

  // ─── Tool palette ──────────────────────────────────────────────────────────
  const TOOL_TITLES = {
    select: "Select / move", row: "Add row", block: "Add block",
    arc: "Add arc / semicircle", stage: "Add stage / area",
    round: "Add round area", label: "Add label",
  };
  const setTool = (tool) => {
    document.querySelectorAll(".smartseat-tool").forEach((b) =>
      b.classList.toggle("active", b.getAttribute("data-tool") === tool));
    document.querySelectorAll("[data-tools]").forEach((el) => {
      const tools = (el.getAttribute("data-tools") || "").split(/\s+/);
      el.hidden = !tools.includes(tool);
    });
    const title = document.querySelector('[data-role="tool-title"]');
    if (title) title.textContent = TOOL_TITLES[tool] || "Tool";
  };
  document.querySelectorAll(".smartseat-tool").forEach((b) => {
    b.addEventListener("click", () => setTool(b.getAttribute("data-tool")));
  });
  setTool("select");

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
      if (type === "wheelchair") s.is_accessible = true;
      if (type === "companion") s.is_companion = true;
      if (type === "technical") s.is_technical_blocked = true;
    });
  });

  const wireFlag = (fieldName, prop) => {
    field(fieldName)?.addEventListener("change", (event) => {
      applyToSelection((s) => {
        s[prop] = event.target.checked;
      });
    });
  };
  wireFlag("insp-accessible", "is_accessible");
  wireFlag("insp-companion", "is_companion");
  wireFlag("insp-blocked", "is_blocked");
  wireFlag("insp-technical", "is_technical_blocked");

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

