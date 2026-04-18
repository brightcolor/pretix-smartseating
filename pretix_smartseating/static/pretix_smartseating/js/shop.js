(function () {
  const root = document.querySelector(".smartseat-shop");
  if (!root) return;

  const svg = root.querySelector('[data-role="canvas"]');
  const modeField = root.querySelector('[data-field="mode"]');
  const quantityField = root.querySelector('[data-field="quantity"]');
  const summary = root.querySelector('[data-role="summary"]');
  let selected = new Set();
  let seatMap = [];
  let statuses = {};
  let holdToken = null;

  const statusColor = (status, isSelected) => {
    if (isSelected) return "#0055cc";
    if (status === "available") return "#1e9e56";
    if (status === "hold") return "#ef8f18";
    if (status === "sold") return "#d63939";
    if (status === "blocked" || status === "technical") return "#727b8b";
    return "#adb5bd";
  };

  const render = () => {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    seatMap.forEach((seat) => {
      const seatStatus = statuses[seat.external_id] || "available";
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", seat.x);
      circle.setAttribute("cy", seat.y);
      circle.setAttribute("r", 8);
      circle.setAttribute("fill", statusColor(seatStatus, selected.has(seat.id)));
      circle.setAttribute("aria-label", `${seat.row_label}-${seat.seat_number} ${seatStatus}`);
      circle.setAttribute("tabindex", "0");
      circle.addEventListener("click", () => {
        if (seatStatus !== "available") return;
        if (selected.has(seat.id)) selected.delete(seat.id);
        else selected.add(seat.id);
        render();
      });
      circle.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" || evt.key === " ") {
          evt.preventDefault();
          circle.dispatchEvent(new MouseEvent("click"));
        }
      });
      svg.appendChild(circle);
    });

    const freeCount = Object.values(statuses).filter((status) => status === "available").length;
    summary.textContent = `${selected.size} selected, ${freeCount} available`;
  };

  const loadPlan = async () => {
    const response = await fetch(root.dataset.planUrl, { credentials: "same-origin" });
    const data = await response.json();
    seatMap = data.seats.map((seat) => ({ ...seat, id: seat.id || seat.external_id }));
    svg.setAttribute("viewBox", `0 0 ${data.plan.width} ${data.plan.height}`);
  };

  const loadAvailability = async () => {
    const response = await fetch(root.dataset.availabilityUrl, { credentials: "same-origin" });
    const data = await response.json();
    statuses = {};
    data.statuses.forEach((entry) => {
      statuses[entry.external_id] = entry.status;
    });
  };

  const holdSelected = async () => {
    if (!selected.size) return;
    const response = await fetch(root.dataset.holdUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat_ids: Array.from(selected) }),
      credentials: "same-origin",
    });
    const data = await response.json();
    if (response.ok && data.token) {
      holdToken = data.token;
      await loadAvailability();
      render();
      return;
    }
    alert("Selected seats are no longer available.");
    await loadAvailability();
    render();
  };

  const autoSeat = async () => {
    const mode = modeField.value;
    if (mode === "manual") {
      await holdSelected();
      return;
    }
    const response = await fetch(root.dataset.autoseatUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        quantity: Number(quantityField.value || 1),
      }),
      credentials: "same-origin",
    });
    const data = await response.json();
    if (!response.ok) {
      alert(data.message || "No matching seats found.");
      return;
    }
    holdToken = data.token;
    selected = new Set(data.seat_ids);
    await loadAvailability();
    render();
  };

  root.querySelector('[data-action="autoseat"]').addEventListener("click", autoSeat);
  window.addEventListener("beforeunload", async () => {
    if (!holdToken) return;
    await fetch(root.dataset.releaseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: holdToken }),
      keepalive: true,
    });
  });

  const bootstrap = async () => {
    await loadPlan();
    await loadAvailability();
    render();
    setInterval(async () => {
      await loadAvailability();
      render();
    }, 8000);
  };

  bootstrap();
})();

