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
      var pad = 30;
      view = { x: -pad, y: -pad, w: (sz.width || 1000) + 2 * pad, h: (sz.height || 600) + 2 * pad };
      applyViewBox();

      // Decorative areas (stage / bar / labels) as non-interactive background.
      (data.areas || []).forEach(function (a) { drawArea(a); });

      var R = 11;
      (data.seats || []).forEach(function (seat) {
        var g = document.createElementNS(SVGNS, "g");
        var state = seat.blocked ? "blk" : (!seat.available ? "taken" : "free");
        g.setAttribute("class", "smartseat-shop-seat " + state);
        g.setAttribute("transform", "translate(" + seat.x + "," + seat.y + ")");

        var c = document.createElementNS(SVGNS, "circle");
        c.setAttribute("cx", 0); c.setAttribute("cy", 0); c.setAttribute("r", R);
        c.setAttribute("class", "smartseat-shop-dotc");
        if (seat.available) c.setAttribute("fill", seat.color || "#16a34a");
        g.appendChild(c);

        // seat number inside the circle
        var num = (seat.label || "").split(/[\s,]+/).pop();
        if (num) {
          var txt = document.createElementNS(SVGNS, "text");
          txt.setAttribute("x", 0); txt.setAttribute("y", 3.5);
          txt.setAttribute("text-anchor", "middle");
          txt.setAttribute("class", "smartseat-shop-num");
          txt.textContent = num.length > 3 ? num.slice(-3) : num;
          g.appendChild(txt);
        }

        var priceTxt = fmtPrice(seat.price, currency);
        var label = (seat.label || "") + (priceTxt ? " · " + priceTxt : "")
          + (seat.available ? "" : " (" + t("unavailable") + ")");
        g.setAttribute("tabindex", seat.available ? "0" : "-1");
        g.setAttribute("role", "button");
        g.setAttribute("aria-label", label);
        var title = document.createElementNS(SVGNS, "title");
        title.textContent = label; g.appendChild(title);
        if (seat.available) {
          g.addEventListener("click", function () { toggle(seat, g); });
          g.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(seat, g); }
          });
        }
        svg.appendChild(g);
        nodes[seat.guid] = g;
      });
      var free = (data.seats || []).filter(function (s) { return s.available; }).length;
      status.textContent = free ? t("Pick your seats on the map.") : t("No seats are currently available.");
    }

    function drawArea(a) {
      var g = document.createElementNS(SVGNS, "g");
      g.setAttribute("class", "smartseat-shop-area");
      var px = (a.position && a.position.x) || 0, py = (a.position && a.position.y) || 0;
      g.setAttribute("transform", "translate(" + px + "," + py + ") rotate(" + (a.rotation || 0) + ")");
      var fill = a.color || "rgba(148,163,184,0.5)", stroke = a.border_color || "#64748b";
      var sh = null;
      if (a.shape === "rectangle" && a.rectangle) {
        sh = document.createElementNS(SVGNS, "rect");
        sh.setAttribute("x", 0); sh.setAttribute("y", 0);
        sh.setAttribute("rx", 6);
        sh.setAttribute("width", a.rectangle.width || 100); sh.setAttribute("height", a.rectangle.height || 40);
      } else if (a.shape === "circle" && a.circle) {
        sh = document.createElementNS(SVGNS, "circle");
        sh.setAttribute("cx", 0); sh.setAttribute("cy", 0); sh.setAttribute("r", a.circle.radius || 50);
      } else if (a.shape === "ellipse" && a.ellipse) {
        sh = document.createElementNS(SVGNS, "ellipse");
        sh.setAttribute("cx", 0); sh.setAttribute("cy", 0);
        sh.setAttribute("rx", (a.ellipse.radius && a.ellipse.radius.x) || 80);
        sh.setAttribute("ry", (a.ellipse.radius && a.ellipse.radius.y) || 50);
      } else if (a.shape === "text" && a.text) {
        sh = document.createElementNS(SVGNS, "text");
        sh.setAttribute("x", (a.text.position && a.text.position.x) || 0);
        sh.setAttribute("y", (a.text.position && a.text.position.y) || 0);
        sh.setAttribute("font-size", a.text.size || 18);
        sh.setAttribute("fill", a.text.color || "#475569");
        sh.setAttribute("font-weight", "600");
        sh.textContent = a.text.text || "";
      }
      if (!sh) return;
      if (a.shape !== "text") { sh.setAttribute("fill", fill); sh.setAttribute("stroke", stroke); }
      g.appendChild(sh);
      svg.appendChild(g);
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
