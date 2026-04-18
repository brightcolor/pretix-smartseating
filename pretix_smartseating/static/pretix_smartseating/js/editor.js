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

  const saveSnapshot = () => {
    undoStack.push(JSON.stringify(state));
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  };

  const seatColor = (seat) => (seat.is_blocked ? "#8892a2" : seat.category_code === "vip" ? "#ff7f50" : "#3B82F6");

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
    const rowIndex = state.seats.reduce((max, seat) => Math.max(max, seat.row_index), -1) + 1;
    const rowLabel = String.fromCharCode(65 + rowIndex);
    for (let i = 0; i < 20; i++) {
      const seatNumber = i + 1;
      state.seats.push({
        external_id: `A-${rowLabel}-${seatNumber}`,
        display_name: `${rowLabel}-${seatNumber}`,
        block_label: "A",
        row_label: rowLabel,
        seat_number: String(seatNumber),
        seat_index: i,
        row_index: rowIndex,
        x: 120 + i * 28,
        y: 100 + rowIndex * 28,
        rotation: 0,
        category_code: "standard",
        seat_type: "normal",
        is_accessible: false,
        is_companion: false,
        is_hidden: false,
        is_blocked: false,
        is_technical_blocked: false,
        notes: "",
        metadata: {},
      });
    }
    draw();
  };

  const bulkBlock = (value) => {
    if (!selected.size) return;
    saveSnapshot();
    state.seats = state.seats.map((seat) =>
      selected.has(seat.external_id) ? { ...seat, is_blocked: value } : seat
    );
    draw();
  };

  const undo = () => {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(state));
    state = JSON.parse(undoStack.pop());
    selected.clear();
    draw();
  };

  const redo = () => {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(state));
    state = JSON.parse(redoStack.pop());
    selected.clear();
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
          categories: data.categories,
          seats: data.seats,
          bounds: { width: data.plan.width, height: data.plan.height },
        };
      }
    } catch (_err) {
      // Keep fallback state.
    }
    draw();
  };

  document.querySelectorAll(".smartseat-toolbar [data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.getAttribute("data-action");
      if (action === "add-row") addGeneratedRow();
      else if (action === "bulk-block") bulkBlock(true);
      else if (action === "bulk-unblock") bulkBlock(false);
      else if (action === "undo") undo();
      else if (action === "redo") redo();
      else if (action === "save") save();
    });
  });

  load();
})();

