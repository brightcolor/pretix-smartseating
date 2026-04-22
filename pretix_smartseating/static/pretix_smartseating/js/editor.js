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
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  host.appendChild(svg);

  let state = {
    seats: [],
    template_assets: [],
    categories: [{ code: "standard", name: "Standard", color: "#3B82F6", price_rank: 100 }],
    bounds: { width, height },
    plan: { width, height, grid_size: 10, snap_enabled: true },
  };
  let selected = new Set();
  const undoStack = [];
  const redoStack = [];

  const seatColor = (seat) => {
    if (seat.is_blocked) return "#8892a2";
    const category = state.categories.find((entry) => entry.code === seat.category_code);
    return category?.color || "#3B82F6";
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
      option.textContent = `${category.name} (${category.code})`;
      select.appendChild(option);
    });
    if (!state.categories.find((category) => category.code === current)) {
      select.value = state.categories[0]?.code || "standard";
    } else {
      select.value = current;
    }
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

  const draw = () => {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    drawBackgroundAssets();
    state.seats.forEach((seat) => {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", seat.x);
      circle.setAttribute("cy", seat.y);
      circle.setAttribute("r", 8);
      circle.setAttribute("fill", seatColor(seat));
      circle.setAttribute("class", `smartseat-seat ${selected.has(seat.external_id) ? "selected" : ""}`);
      circle.setAttribute("data-id", seat.external_id);
      circle.addEventListener("click", (event) => {
        if (event.shiftKey) {
          if (selected.has(seat.external_id)) selected.delete(seat.external_id);
          else selected.add(seat.external_id);
        } else {
          selected = new Set([seat.external_id]);
        }
        draw();
      });
      svg.appendChild(circle);

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", seat.x + 10);
      label.setAttribute("y", seat.y + 4);
      label.setAttribute("font-size", "10");
      label.textContent = `${seat.row_label}${seat.seat_number}`;
      svg.appendChild(label);
    });
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
    for (let i = 0; i < 20; i++) {
      const seatNumber = i + 1;
      const externalId = makeUniqueExternalId(`A-${rowLabel}-${seatNumber}`, usedIds);
      state.seats.push(
        createSeat({
          external_id: externalId,
          block_label: "A",
          row_label: rowLabel,
          seat_number: String(seatNumber),
          seat_index: i,
          row_index: rowIndex,
          x: snap(120 + i * 28),
          y: snap(100 + rowIndex * 28),
          rotation: 0,
          category_code: field("gen-category")?.value || "standard",
        })
      );
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

  const bulkBlock = (value) => {
    if (!selected.size) return;
    saveSnapshot();
    state.seats = state.seats.map((seat) => (selected.has(seat.external_id) ? { ...seat, is_blocked: value } : seat));
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
    populateCategoryOptions();
    draw();
    refreshTemplatePanel();
  };

  const redo = () => {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(state));
    state = JSON.parse(redoStack.pop());
    selected.clear();
    populateCategoryOptions();
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
          template_assets: [],
          bounds: { width: data.plan.width, height: data.plan.height },
        };
      }
    } catch (_err) {
      // Keep fallback state.
    }
    field("gen-center-x").value = Math.round(state.bounds.width / 2);
    field("gen-center-y").value = Math.round(state.bounds.height / 2);
    populateCategoryOptions();
    await fetchTemplateAssets();
    draw();
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
      deleteSelected();
    }
  });

  document.querySelectorAll(".smartseat-toolbar [data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-action");
      if (action === "add-row") addGeneratedRow();
      else if (action === "generate-arc") generateArcRows({ semicircle: false });
      else if (action === "generate-semicircle") generateArcRows({ semicircle: true });
      else if (action === "duplicate-selected") duplicateSelected();
      else if (action === "delete-selected") deleteSelected();
      else if (action === "bulk-block") bulkBlock(true);
      else if (action === "bulk-unblock") bulkBlock(false);
      else if (action === "undo") undo();
      else if (action === "redo") redo();
      else if (action === "save") save();
    });
  });

  load();
})();

