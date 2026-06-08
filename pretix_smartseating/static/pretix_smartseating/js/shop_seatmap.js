/*
 * Smart Seating — interactive shop seat map.
 *
 * Open-source pretix emits `render_seating_plan` but ships no shop renderer.
 * This draws the map from native availability and submits the chosen seats as
 * `seat_<product>=<guid>` hidden inputs into pretix' own cart-add <form>.
 *
 * UX patterns follow established seat pickers (seats.io et al.): category
 * colours + legend, hover tooltip with price, visible zoom controls, a
 * sticky action bar with running total, and a "best available" helper.
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

  function fmtPrice(p, cur) {
    if (p === null || p === undefined || p === "") return "";
    var n = parseFloat(p);
    return (isNaN(n) ? p : n.toFixed(2)) + (cur ? " " + cur : "");
  }

  function init() {
    var host = document.getElementById("smartseat-shop");
    if (!host) return;
    var url = host.getAttribute("data-seatmap-url");
    if (!url) return;
    var suggestUrl = url.replace("/seatmap/", "/autoseat-suggest/");
    var form = host.closest("form");
    if (form) form.appendChild(host); // show tickets first, plan below

    host.appendChild(el("h3", { class: "smartseat-shop-heading", text: t("Choose your seats") }));
    var priceLegend = el("div", { class: "smartseat-shop-prices" });
    host.appendChild(priceLegend);

    var legend = el("div", { class: "smartseat-shop-legend" });
    [["free", t("Available")], ["sel", t("Selected")], ["taken", t("Unavailable")], ["blk", t("Blocked")]]
      .forEach(function (p) {
        legend.appendChild(el("span", { class: "smartseat-shop-key" }, [
          el("span", { class: "smartseat-shop-dot " + p[0] }), document.createTextNode(" " + p[1]),
        ]));
      });
    host.appendChild(legend);

    // Canvas + zoom controls overlay
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "smartseat-shop-svg");
    var zoomBar = el("div", { class: "smartseat-shop-zoom" });
    var zin = el("button", { type: "button", class: "smartseat-zoom-btn", title: t("Zoom in"), text: "+" });
    var zout = el("button", { type: "button", class: "smartseat-zoom-btn", title: t("Zoom out"), text: "−" });
    var zfit = el("button", { type: "button", class: "smartseat-zoom-btn", title: t("Fit"), text: "⤢" });
    zoomBar.append(zin, zout, zfit);
    var canvas = el("div", { class: "smartseat-shop-canvas" }, [svg, zoomBar]);
    host.appendChild(canvas);

    var tip = el("div", { class: "smartseat-shop-tip", role: "tooltip" });
    tip.hidden = true;
    host.appendChild(tip);

    // Sticky action bar: best-available + status + submit
    var qty = el("input", { type: "number", min: "1", max: "20", value: "2", class: "smartseat-shop-qty",
      "aria-label": t("Number of seats") });
    var best = el("button", { type: "button", class: "btn btn-default btn-sm smartseat-shop-best",
      text: t("Best available") });
    var status = el("div", { class: "smartseat-shop-status", role: "status", "aria-live": "polite",
      text: t("Loading seats…") });
    var submit = el("button", { type: "submit", class: "btn btn-primary smartseat-shop-submit",
      disabled: "disabled", text: t("Add selected seats to cart") });
    var bar = el("div", { class: "smartseat-shop-bar" }, [
      el("div", { class: "smartseat-shop-bestwrap" }, [qty, best]), status, submit,
    ]);
    host.appendChild(bar);

    var view = { x: 0, y: 0, w: 1000, h: 600 };
    var fullView = { x: 0, y: 0, w: 1000, h: 600 };
    var selected = {};           // guid -> product
    var nodes = {};              // guid -> <g>
    var seatsByGuid = {};        // guid -> seat data
    var currency = "";
    var priceByProduct = {};

    function applyViewBox() { svg.setAttribute("viewBox", view.x + " " + view.y + " " + view.w + " " + view.h); }
    function fit() { view = { x: fullView.x, y: fullView.y, w: fullView.w, h: fullView.h }; applyViewBox(); }
    function zoomBy(f, cx, cy) {
      var nw = Math.min(Math.max(view.w * f, 80), fullView.w * 1.5);
      var nh = nw * (view.h / view.w);
      cx = (cx === undefined) ? view.x + view.w / 2 : cx;
      cy = (cy === undefined) ? view.y + view.h / 2 : cy;
      view.x = cx - (cx - view.x) * (nw / view.w);
      view.y = cy - (cy - view.y) * (nh / view.h);
      view.w = nw; view.h = nh; applyViewBox();
    }

    function syncForm() {
      if (form) {
        Array.prototype.slice.call(form.querySelectorAll(".smartseat-seat-input")).forEach(function (i) { i.remove(); });
        Object.keys(selected).forEach(function (guid) {
          var inp = document.createElement("input");
          inp.type = "hidden"; inp.className = "smartseat-seat-input";
          inp.name = "seat_" + selected[guid]; inp.value = guid;
          form.appendChild(inp);
        });
      }
      var n = Object.keys(selected).length;
      submit.disabled = n === 0;
      if (!n) { status.textContent = t("Pick your seats on the map."); return; }
      var total = 0, haveAll = true;
      Object.keys(selected).forEach(function (guid) {
        var p = priceByProduct[selected[guid]];
        if (p && p.price != null) total += parseFloat(p.price) || 0; else haveAll = false;
      });
      status.textContent = t("Selected seats:") + " " + n
        + (haveAll ? " · " + t("Total:") + " " + fmtPrice(total.toFixed(2), currency) : "");
    }

    function setSelected(seat, on) {
      var g = nodes[seat.guid];
      if (on) { selected[seat.guid] = seat.product; if (g) g.classList.add("sel"); }
      else { delete selected[seat.guid]; if (g) g.classList.remove("sel"); }
    }
    function toggle(seat) { if (seat.available) { setSelected(seat, !selected[seat.guid]); syncForm(); } }

    function bestAvailable() {
      var n = parseInt(qty.value, 10) || 1;
      best.disabled = true; status.textContent = t("Searching for the best seats…");
      fetch(suggestUrl + "?quantity=" + n + "&mode=strict_adjacent",
        { headers: { Accept: "application/json" }, credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          best.disabled = false;
          if (!d || !d.seats || !d.seats.length) { status.textContent = t("No suitable group of seats was found."); return; }
          Object.keys(selected).forEach(function (g) { setSelected({ guid: g }, false); });
          d.seats.forEach(function (s) {
            var seat = seatsByGuid[s.seat_guid];
            if (seat && seat.available) setSelected(seat, true);
          });
          syncForm();
        })
        .catch(function () { best.disabled = false; status.textContent = t("The suggestion service is unavailable."); });
    }

    function showTip(evt, seat) {
      var price = fmtPrice(seat.price, currency);
      tip.textContent = (seat.label || "") + (price ? " · " + price : "")
        + (seat.available ? "" : " — " + t("unavailable"));
      tip.hidden = false;
      var hr = host.getBoundingClientRect();
      tip.style.left = (evt.clientX - hr.left + 12) + "px";
      tip.style.top = (evt.clientY - hr.top + 12) + "px";
    }
    function hideTip() { tip.hidden = true; }

    function drawArea(a) {
      var g = document.createElementNS(SVGNS, "g");
      g.setAttribute("class", "smartseat-shop-area");
      var px = (a.position && a.position.x) || 0, py = (a.position && a.position.y) || 0;
      g.setAttribute("transform", "translate(" + px + "," + py + ") rotate(" + (a.rotation || 0) + ")");
      var fill = a.color || "rgba(148,163,184,0.5)", stroke = a.border_color || "#64748b", sh = null;
      if (a.shape === "rectangle" && a.rectangle) {
        sh = document.createElementNS(SVGNS, "rect");
        sh.setAttribute("x", 0); sh.setAttribute("y", 0); sh.setAttribute("rx", 6);
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
      g.appendChild(sh); svg.appendChild(g);
    }

    function render(data) {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      nodes = {}; seatsByGuid = {};
      currency = data.currency || "";
      priceByProduct = {};
      (data.products || []).forEach(function (p) { priceByProduct[p.id] = p; });

      priceLegend.innerHTML = "";
      (data.products || []).forEach(function (p) {
        priceLegend.appendChild(el("span", { class: "smartseat-shop-price" }, [
          el("span", { class: "smartseat-shop-dot", style: "background:" + (p.color || "#3B82F6") }),
          document.createTextNode(" " + (p.name || t("Seat")) + " — " + fmtPrice(p.price, currency)),
        ]));
      });

      var sz = data.size || { width: 1000, height: 600 }, pad = 30;
      fullView = { x: -pad, y: -pad, w: (sz.width || 1000) + 2 * pad, h: (sz.height || 600) + 2 * pad };
      fit();

      (data.areas || []).forEach(drawArea);

      var R = 11;
      (data.seats || []).forEach(function (seat) {
        seatsByGuid[seat.guid] = seat;
        var g = document.createElementNS(SVGNS, "g");
        var state = seat.blocked ? "blk" : (!seat.available ? "taken" : "free");
        g.setAttribute("class", "smartseat-shop-seat " + state);
        g.setAttribute("transform", "translate(" + seat.x + "," + seat.y + ")");

        var c = document.createElementNS(SVGNS, "circle");
        c.setAttribute("cx", 0); c.setAttribute("cy", 0); c.setAttribute("r", R);
        c.setAttribute("class", "smartseat-shop-dotc");
        if (seat.available) c.setAttribute("fill", seat.color || "#16a34a");
        g.appendChild(c);

        var num = (seat.label || "").split(/[\s,]+/).pop();
        if (num) {
          var txt = document.createElementNS(SVGNS, "text");
          txt.setAttribute("x", 0); txt.setAttribute("y", 3.5);
          txt.setAttribute("text-anchor", "middle"); txt.setAttribute("class", "smartseat-shop-num");
          txt.textContent = num.length > 3 ? num.slice(-3) : num;
          g.appendChild(txt);
        }

        var price = fmtPrice(seat.price, currency);
        g.setAttribute("tabindex", seat.available ? "0" : "-1");
        g.setAttribute("role", "button");
        g.setAttribute("aria-label", (seat.label || "") + (price ? " · " + price : "")
          + (seat.available ? "" : " (" + t("unavailable") + ")"));
        g.addEventListener("pointerover", function (e) { showTip(e, seat); });
        g.addEventListener("pointermove", function (e) { showTip(e, seat); });
        g.addEventListener("pointerout", hideTip);
        if (seat.available) {
          g.addEventListener("click", function () { toggle(seat); });
          g.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(seat); }
          });
        }
        svg.appendChild(g);
        nodes[seat.guid] = g;
      });

      var free = (data.seats || []).filter(function (s) { return s.available; }).length;
      best.disabled = free === 0;
      status.textContent = free ? t("Pick your seats on the map.") : t("No seats are currently available.");
    }

    // Interactions
    zin.addEventListener("click", function () { zoomBy(0.8); });
    zout.addEventListener("click", function () { zoomBy(1.25); });
    zfit.addEventListener("click", fit);
    best.addEventListener("click", bestAvailable);

    svg.addEventListener("wheel", function (e) {
      e.preventDefault();
      var ctm = svg.getScreenCTM();
      var p = ctm ? new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse()) : undefined;
      zoomBy(e.deltaY < 0 ? 0.85 : 1.18, p && p.x, p && p.y);
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

    fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (data) { if (data && data.ok) { render(data); syncForm(); } else { status.textContent = t("Could not load the seat map."); } })
      .catch(function () { status.textContent = t("Could not load the seat map."); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
