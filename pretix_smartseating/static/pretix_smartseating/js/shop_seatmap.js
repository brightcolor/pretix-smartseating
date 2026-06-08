/*
 * Smart Seating — interactive shop seat map.
 *
 * Open-source pretix emits `render_seating_plan` but ships no shop renderer.
 * This draws the map from native availability and submits the chosen seats as
 * `seat_<product>=<guid>` hidden inputs into pretix' own cart-add <form>.
 */
(function () {
  "use strict";
  var SVGNS = "http://www.w3.org/2000/svg";

  function t(s) { return (typeof window.gettext === "function") ? window.gettext(s) : s; }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === "class") n.className = attrs[k]; else if (k === "text") n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }

  function init() {
    var host = document.getElementById("smartseat-shop");
    if (!host) return;
    var url = host.getAttribute("data-seatmap-url");
    if (!url) return;
    var form = host.closest("form");

    // Show normal ticket products first, then the seat plan below them:
    // move our container to the end of the cart form (pretix renders the
    // seating block above the product list by default).
    if (form) form.appendChild(host);

    var heading = el("h3", { class: "smartseat-shop-heading", text: t("Choose your seats") });
    host.appendChild(heading);

    // Price-zone legend (filled after fetch) + seat-state legend
    var priceLegend = el("div", { class: "smartseat-shop-prices" });
    host.appendChild(priceLegend);

    // UI scaffold
    var legend = el("div", { class: "smartseat-shop-legend" });
    [["free", t("Available")], ["sel", t("Selected")], ["taken", t("Unavailable")], ["blk", t("Blocked")]]
      .forEach(function (p) {
        legend.appendChild(el("span", { class: "smartseat-shop-key" }, [
          el("span", { class: "smartseat-shop-dot " + p[0] }), document.createTextNode(" " + p[1]),
        ]));
      });

    var status = el("div", { class: "smartseat-shop-status", role: "status", "aria-live": "polite",
      text: t("Loading seats…") });
    var submit = el("button", { type: "submit", class: "btn btn-primary smartseat-shop-submit", disabled: "disabled",
      text: t("Add selected seats to cart") });

    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "smartseat-shop-svg");
    var wrap = el("div", { class: "smartseat-shop-canvas" });
    wrap.appendChild(svg);

    host.appendChild(legend);
    host.appendChild(wrap);
    host.appendChild(status);
    host.appendChild(submit);

    var view = { x: 0, y: 0, w: 1000, h: 600 };
    var selected = {}; // guid -> product
    var nodes = {};    // guid -> circle
    var currency = "";
    var priceByProduct = {}; // product id -> {price, ...}

    function applyViewBox() { svg.setAttribute("viewBox", view.x + " " + view.y + " " + view.w + " " + view.h); }

    function syncForm() {
      if (!form) return;
      Array.prototype.slice.call(form.querySelectorAll(".smartseat-seat-input")).forEach(function (i) { i.remove(); });
      var n = 0;
      Object.keys(selected).forEach(function (guid) {
        var inp = document.createElement("input");
        inp.type = "hidden"; inp.className = "smartseat-seat-input";
        inp.name = "seat_" + selected[guid]; inp.value = guid;
        form.appendChild(inp); n += 1;
      });
      submit.disabled = n === 0;
      if (!n) {
        status.textContent = t("Pick your seats on the map.");
        return;
      }
      var total = 0, haveAll = true;
      Object.keys(selected).forEach(function (guid) {
        var p = priceByProduct[selected[guid]];
        if (p && p.price !== null && p.price !== undefined) total += parseFloat(p.price) || 0;
        else haveAll = false;
      });
      status.textContent = t("Selected seats:") + " " + n
        + (haveAll ? " · " + t("Total:") + " " + fmtPrice(total.toFixed(2), currency) : "");
    }

    function toggle(seat, circle) {
      if (!seat.available) return;
      if (selected[seat.guid]) { delete selected[seat.guid]; circle.classList.remove("sel"); }
      else { selected[seat.guid] = seat.product; circle.classList.add("sel"); }
      syncForm();
    }

    function fmtPrice(p, cur) {
      if (p === null || p === undefined || p === "") return "";
      var n = parseFloat(p);
      return (isNaN(n) ? p : n.toFixed(2)) + (cur ? " " + cur : "");
    }

    function render(data) {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      nodes = {};
      currency = data.currency || "";
      priceByProduct = {};
      (data.products || []).forEach(function (p) { priceByProduct[p.id] = p; });

      // Price-zone legend
      priceLegend.innerHTML = "";
      (data.products || []).forEach(function (p) {
        priceLegend.appendChild(el("span", { class: "smartseat-shop-price" }, [
          el("span", { class: "smartseat-shop-dot", style: "background:" + (p.color || "#3B82F6") }),
          document.createTextNode(" " + (p.name || t("Seat")) + " — " + fmtPrice(p.price, currency)),
        ]));
      });
      var sz = data.size || { width: 1000, height: 600 };
      view = { x: -20, y: -20, w: (sz.width || 1000) + 40, h: (sz.height || 600) + 40 };
      applyViewBox();
      (data.seats || []).forEach(function (seat) {
        var c = document.createElementNS(SVGNS, "circle");
        c.setAttribute("cx", seat.x); c.setAttribute("cy", seat.y); c.setAttribute("r", 9);
        var cls = "smartseat-shop-seat ";
        if (seat.blocked) cls += "blk"; else if (!seat.available) cls += "taken"; else cls += "free";
        c.setAttribute("class", cls);
        if (seat.available) c.style.fill = seat.color || "#16a34a";
        var priceTxt = fmtPrice(seat.price, currency);
        var label = (seat.label || "") + (priceTxt ? " · " + priceTxt : "")
          + (seat.available ? "" : " (" + t("unavailable") + ")");
        c.setAttribute("tabindex", seat.available ? "0" : "-1");
        c.setAttribute("role", "button");
        c.setAttribute("aria-label", label);
        var title = document.createElementNS(SVGNS, "title");
        title.textContent = label; c.appendChild(title);
        if (seat.available) {
          c.addEventListener("click", function () { toggle(seat, c); });
          c.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(seat, c); }
          });
        }
        svg.appendChild(c);
        nodes[seat.guid] = c;
      });
      var free = (data.seats || []).filter(function (s) { return s.available; }).length;
      status.textContent = free ? t("Pick your seats on the map.") : t("No seats are currently available.");
    }

    // basic wheel zoom + drag pan (touch-friendly)
    svg.addEventListener("wheel", function (e) {
      e.preventDefault();
      var f = e.deltaY < 0 ? 0.85 : 1.18;
      var ctm = svg.getScreenCTM();
      var p = ctm ? new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse()) : { x: view.x, y: view.y };
      var nw = Math.min(Math.max(view.w * f, 80), (view.w) * 6);
      var nh = nw * (view.h / view.w);
      view.x = p.x - (p.x - view.x) * (nw / view.w);
      view.y = p.y - (p.y - view.y) * (nh / view.h);
      view.w = nw; view.h = nh; applyViewBox();
    }, { passive: false });
    var pan = null;
    svg.addEventListener("pointerdown", function (e) {
      if (e.target !== svg) return;
      var ctm = svg.getScreenCTM();
      pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, sx: ctm ? ctm.a : 1, sy: ctm ? ctm.d : 1 };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", function (e) {
      if (!pan) return;
      view.x = pan.vx - (e.clientX - pan.x) / (pan.sx || 1);
      view.y = pan.vy - (e.clientY - pan.y) / (pan.sy || 1);
      applyViewBox();
    });
    var endPan = function () { pan = null; };
    svg.addEventListener("pointerup", endPan);
    svg.addEventListener("pointercancel", endPan);

    fetch(url, { headers: { "Accept": "application/json" }, credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (data) { if (data && data.ok) { render(data); syncForm(); } else { status.textContent = t("Could not load the seat map."); } })
      .catch(function () { status.textContent = t("Could not load the seat map."); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
