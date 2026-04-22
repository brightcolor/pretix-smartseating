(function () {
  const host = document.getElementById("smartseat-editor");
  if (!host) return;

  const width = Number(host.dataset.width || 1200);
  const height = Number(host.dataset.height || 800);
  const saveUrl = host.dataset.saveUrl;
  const exportUrl = host.dataset.exportUrl;
  const csrf = host.dataset.csrf;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  host.appendChild(svg);

  let state = {
    seats: [],
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

  const saveSnapshot = () => {
    undoStack.push(JSON.stringify(state));
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  };

  const field = (name) => document.querySelector(`[data-field="${name}"]`);

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
    for (const ch of cleaned) {
      value = value * 26 + (ch.charCodeAt(0) - 64);
    }
    return value;
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

  const draw = () => {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
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
          x: 120 + i * 28,
          y: 100 + rowIndex * 28,
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
            x: centerX + Math.cos(rad) * radius,
            y: centerY + Math.sin(rad) * radius,
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

  const undo = () => {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(state));
    state = JSON.parse(undoStack.pop());
    selected.clear();
    populateCategoryOptions();
    draw();
  };

  const redo = () => {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(state));
    state = JSON.parse(redoStack.pop());
    selected.clear();
    populateCategoryOptions();
    draw();
  };

  const save = async () => {
    const response = await fetch(saveUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
      body: JSON.stringify(state),
      credentials: "same-origin",
    });
    const data = await response.json();
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
          bounds: { width: data.plan.width, height: data.plan.height },
        };
      }
    } catch (_err) {
      // Keep fallback state.
    }
    field("gen-center-x").value = Math.round(state.bounds.width / 2);
    field("gen-center-y").value = Math.round(state.bounds.height / 2);
    populateCategoryOptions();
    draw();
  };

  document.querySelectorAll(".smartseat-toolbar [data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-action");
      if (action === "add-row") addGeneratedRow();
      else if (action === "generate-arc") generateArcRows({ semicircle: false });
      else if (action === "generate-semicircle") generateArcRows({ semicircle: true });
      else if (action === "bulk-block") bulkBlock(true);
      else if (action === "bulk-unblock") bulkBlock(false);
      else if (action === "undo") undo();
      else if (action === "redo") redo();
      else if (action === "save") save();
    });
  });

  load();
})();

