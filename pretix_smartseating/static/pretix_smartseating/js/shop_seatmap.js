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

  // CSP-safe colour swatch: an inline SVG (fill is an attribute, not an inline
  // style, so it isn't blocked by pretix' Content-Security-Policy).
  function swatch(color) {
    var s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("width", "13"); s.setAttribute("height", "13");
    s.setAttribute("class", "smartseat-shop-swatch");
    var c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("cx", "6.5"); c.setAttribute("cy", "6.5"); c.setAttribute("r", "6");
    c.setAttribute("fill", color || "#3B82F6");
    c.setAttribute("stroke", "#1b2736"); c.setAttribute("stroke-width", "1");
    s.appendChild(c);
    return s;
  }

  function init() {
    var host = document.getElementById("smartseat-shop");
    if (!host) return;
    var url = host.getAttribute("data-seatmap-url");
    if (!url) return;
    var suggestUrl = url.replace("/seatmap/", "/autoseat-suggest/");
    var form = host.closest("form");
    if (form) form.appendChild(host); // show tickets first, plan below

    host.appendChild(el("h3", { class: "smartseat-shop-heading", text: t("Plätze auswählen") }));
    var priceLegend = el("div", { class: "smartseat-shop-prices" });
    host.appendChild(priceLegend);

    var legend = el("div", { class: "smartseat-shop-legend" });
    [["free", t("Verfügbar")], ["sel", t("Ausgewählt")], ["taken", t("Belegt")], ["blk", t("Gesperrt")]]
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
    var zin = el("button", { type: "button", class: "smartseat-zoom-btn", title: t("Vergrößern"), text: "+" });
    var zout = el("button", { type: "button", class: "smartseat-zoom-btn", title: t("Verkleinern"), text: "−" });
    var zfit = el("button", { type: "button", class: "smartseat-zoom-btn", title: t("Einpassen"), text: "⤢" });
    zoomBar.append(zin, zout, zfit);
    var canvas = el("div", { class: "smartseat-shop-canvas" }, [svg, zoomBar]);
    host.appendChild(canvas);

    var tip = el("div", { class: "smartseat-shop-tip", role: "tooltip" });
    tip.hidden = true;
    host.appendChild(tip);

    // Sticky action bar: best-available + status + submit
    var qty = el("input", { type: "number", min: "1", max: "20", value: "2", class: "smartseat-shop-qty",
      "aria-label": t("Anzahl Plätze") });
    var best = el("button", { type: "button", class: "btn btn-default btn-sm smartseat-shop-best",
      text: t("Beste Plätze") });
    var status = el("div", { class: "smartseat-shop-status", role: "status", "aria-live": "polite",
      text: t("Plätze werden geladen…") });
    var submit = el("button", { type: "submit", class: "btn btn-primary smartseat-shop-submit",
      disabled: "disabled", text: t("Plätze in den Warenkorb") });
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
    var productCounts = {};       // pretix item id -> chosen quantity (product areas)
    var productAreas = {};        // pretix item id -> { info, badge update fn }

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
        // Product areas → pretix' native `item_<id>` quantity fields. Reuse an
        // existing field if pretix already renders one for the product, else add
        // a hidden field so the same cart-add submit books it.
        Array.prototype.slice.call(form.querySelectorAll(".smartseat-product-input")).forEach(function (i) { i.remove(); });
        Object.keys(productCounts).forEach(function (pid) {
          var qty = productCounts[pid];
          if (!qty) return;
          var existing = form.querySelector('[name="item_' + pid + '"]');
          if (existing) { existing.value = qty; return; }
          var inp = document.createElement("input");
          inp.type = "hidden"; inp.className = "smartseat-product-input";
          inp.name = "item_" + pid; inp.value = qty;
          form.appendChild(inp);
        });
      }
      var nSeats = Object.keys(selected).length;
      var nProducts = 0, prodTotal = 0;
      Object.keys(productCounts).forEach(function (pid) {
        var q = productCounts[pid]; if (!q) return;
        nProducts += q;
        var pa = productAreas[pid];
        if (pa && pa.info && pa.info.price != null) prodTotal += (parseFloat(pa.info.price) || 0) * q;
      });
      var n = nSeats + nProducts;
      submit.disabled = n === 0;
      if (!n) { status.textContent = t("Wähle deine Plätze auf der Karte."); return; }
      var total = prodTotal, haveAll = true;
      Object.keys(selected).forEach(function (guid) {
        var p = priceByProduct[selected[guid]];
        if (p && p.price != null) total += parseFloat(p.price) || 0; else haveAll = false;
      });
      var parts = [];
      if (nSeats) parts.push(t("Ausgewählte Plätze:") + " " + nSeats);
      if (nProducts) parts.push(t("Tickets:") + " " + nProducts);
      status.textContent = parts.join(" · ")
        + (haveAll ? " · " + t("Gesamt:") + " " + fmtPrice(total.toFixed(2), currency) : "");
    }

    function setSelected(seat, on) {
      var g = nodes[seat.guid];
      if (on) { selected[seat.guid] = seat.product; if (g) g.classList.add("sel"); }
      else { delete selected[seat.guid]; if (g) g.classList.remove("sel"); }
    }
    function toggle(seat) { if (seat.available) { setSelected(seat, !selected[seat.guid]); syncForm(); } }

    function bestAvailable() {
      var n = parseInt(qty.value, 10) || 1;
      best.disabled = true; status.textContent = t("Suche nach den besten Plätzen…");
      // The seatmap URL may already carry "?subevent=<id>" (event series), so
      // the extra params must not introduce a second "?".
      var sep = suggestUrl.indexOf("?") === -1 ? "?" : "&";
      fetch(suggestUrl + sep + "quantity=" + n + "&mode=strict_adjacent",
        { headers: { Accept: "application/json" }, credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          best.disabled = false;
          if (!d || !d.seats || !d.seats.length) { status.textContent = t("Keine passende Sitzgruppe gefunden."); return; }
          Object.keys(selected).forEach(function (g) { setSelected({ guid: g }, false); });
          d.seats.forEach(function (s) {
            var seat = seatsByGuid[s.seat_guid];
            if (seat && seat.available) setSelected(seat, true);
          });
          syncForm();
        })
        .catch(function () { best.disabled = false; status.textContent = t("Der Vorschlagsdienst ist nicht verfügbar."); });
    }

    function textOn(bg) {
      // pick black/white text for contrast on a hex colour
      var c = (bg || "").replace("#", "");
      if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
      var r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
      if (isNaN(r)) return "#fff";
      return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#1f2937" : "#ffffff";
    }

    function showTip(evt, seat) {
      var price = fmtPrice(seat.price, currency);
      // Row/seat labels are organizer-defined → DOM text nodes only, never
      // concatenated into markup (stored-XSS guard for the shop frontend).
      tip.innerHTML =
        '<div class="smartseat-tip-head"></div>' +
        '<div class="smartseat-tip-cat"><span class="nm"></span><span class="pr"></span></div>';
      var head = tip.querySelector(".smartseat-tip-head");
      function cell(lbl, val) {
        head.appendChild(el("div", { class: "cell" }, [
          el("span", { class: "lbl", text: lbl }),
          el("span", { class: "val", text: String(val) }),
        ]));
      }
      if (seat.row) cell(t("Reihe"), seat.row);
      cell(t("Platz"), seat.number || "?");
      var cat = tip.querySelector(".smartseat-tip-cat");
      cat.querySelector(".nm").textContent = seat.available ? (seat.cat || t("Platz")) : t("Nicht verfügbar");
      cat.querySelector(".pr").textContent = seat.available ? price : "";
      var bg = seat.available ? (seat.color || "#6b7280") : "#6b7280";
      cat.style.backgroundColor = bg;          // CSSOM (CSP-safe), unlike a style="" attribute
      cat.style.color = textOn(bg);
      head.style.display = seat.row || seat.number ? "" : "none";

      tip.hidden = false;
      var hr = host.getBoundingClientRect();
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      var x = evt.clientX - hr.left, y = evt.clientY - hr.top;
      // anchor centered above the cursor; flip below if not enough room
      var left = Math.max(4, Math.min(x - tw / 2, hr.width - tw - 4));
      var top = y - th - 14;
      if (top < 0) top = y + 18;
      tip.style.left = left + "px";
      tip.style.top = top + "px";
    }
    function hideTip() { tip.hidden = true; }

    function drawArea(a) {
      var g = document.createElementNS(SVGNS, "g");
      g.setAttribute("class", "smartseat-shop-area");
      var px = (a.position && a.position.x) || 0, py = (a.position && a.position.y) || 0;
      g.setAttribute("transform", "translate(" + px + "," + py + ") rotate(" + (a.rotation || 0) + ")");
      var fill = a.color || "rgba(148,163,184,0.5)", stroke = a.border_color || "#64748b", sh = null;
      var center = { x: 0, y: 0 };
      if (a.shape === "rectangle" && a.rectangle) {
        var w = a.rectangle.width || 100, h = a.rectangle.height || 40;
        sh = document.createElementNS(SVGNS, "rect");
        sh.setAttribute("x", 0); sh.setAttribute("y", 0); sh.setAttribute("rx", 6);
        sh.setAttribute("width", w); sh.setAttribute("height", h);
        center = { x: w / 2, y: h / 2 };
      } else if (a.shape === "circle" && a.circle) {
        sh = document.createElementNS(SVGNS, "circle");
        sh.setAttribute("cx", 0); sh.setAttribute("cy", 0); sh.setAttribute("r", a.circle.radius || 50);
      } else if (a.shape === "ellipse" && a.ellipse) {
        sh = document.createElementNS(SVGNS, "ellipse");
        sh.setAttribute("cx", 0); sh.setAttribute("cy", 0);
        sh.setAttribute("rx", (a.ellipse.radius && a.ellipse.radius.x) || 80);
        sh.setAttribute("ry", (a.ellipse.radius && a.ellipse.radius.y) || 50);
      } else if (a.shape === "polygon" && a.polygon) {
        var pts = a.polygon.points || [];
        sh = document.createElementNS(SVGNS, "polygon");
        sh.setAttribute("points", pts.map(function (p) { return p.x + "," + p.y; }).join(" "));
        if (pts.length) {
          var sx = 0, sy = 0;
          pts.forEach(function (p) { sx += p.x; sy += p.y; });
          center = { x: sx / pts.length, y: sy / pts.length };
        }
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

      // Product area (standing / GA): clickable region that adds a product by qty.
      if (a.role === "product" && a.product_info && a.product_info.id) {
        drawProductArea(g, a, center);
      }
      // Section: clickable block that zooms the map into that region.
      if (a.role === "section") {
        g.setAttribute("class", "smartseat-shop-area smartseat-shop-section");
        var slbl = document.createElementNS(SVGNS, "text");
        slbl.setAttribute("x", center.x); slbl.setAttribute("y", center.y);
        slbl.setAttribute("text-anchor", "middle");
        slbl.setAttribute("class", "smartseat-shop-section-label");
        slbl.textContent = a.label || t("Abschnitt");
        g.appendChild(slbl);
        g.addEventListener("click", function (e) {
          e.preventDefault(); e.stopPropagation();
          var bnd = areaBounds(a);
          if (!bnd) return;
          var pad = 30;
          view = { x: bnd.x - pad, y: bnd.y - pad, w: bnd.w + 2 * pad, h: bnd.h + 2 * pad };
          applyViewBox();
        });
      }
      svg.appendChild(g);
    }

    // World-space bounding box of an area (rotation ignored — navigation only).
    function areaBounds(a) {
      var px = (a.position && a.position.x) || 0, py = (a.position && a.position.y) || 0;
      if (a.shape === "rectangle" && a.rectangle) return { x: px, y: py, w: a.rectangle.width || 100, h: a.rectangle.height || 40 };
      if (a.shape === "circle" && a.circle) { var r = a.circle.radius || 50; return { x: px - r, y: py - r, w: 2 * r, h: 2 * r }; }
      if (a.shape === "ellipse" && a.ellipse) {
        var rx = (a.ellipse.radius && a.ellipse.radius.x) || 80, ry = (a.ellipse.radius && a.ellipse.radius.y) || 50;
        return { x: px - rx, y: py - ry, w: 2 * rx, h: 2 * ry };
      }
      if (a.shape === "polygon" && a.polygon) {
        var pts = a.polygon.points || [];
        if (!pts.length) return null;
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        pts.forEach(function (p) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
        return { x: px + x0, y: py + y0, w: x1 - x0, h: y1 - y0 };
      }
      return null;
    }

    function drawProductArea(g, a, center) {
      var info = a.product_info;
      var pid = info.id;
      productAreas[pid] = { info: info };
      var avail = !!info.available;
      g.setAttribute("class", "smartseat-shop-area smartseat-shop-product" + (avail ? "" : " unavail"));
      var lbl = document.createElementNS(SVGNS, "text");
      lbl.setAttribute("x", center.x); lbl.setAttribute("y", center.y);
      lbl.setAttribute("text-anchor", "middle");
      lbl.setAttribute("class", "smartseat-shop-product-label");
      function priceTxt() { return info.price != null ? fmtPrice(info.price, currency) : ""; }
      function refresh() {
        var q = productCounts[pid] || 0;
        lbl.textContent = (info.name || t("Tickets")) + (priceTxt() ? " · " + priceTxt() : "")
          + (q ? "  ×" + q : "");
        if (q) g.classList.add("chosen"); else g.classList.remove("chosen");
      }
      productAreas[pid].refresh = refresh;
      g.appendChild(lbl);
      refresh();
      if (!avail) return;
      g.style.cursor = "pointer";
      g.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        var q = productCounts[pid] || 0;
        // Plain click adds one; Shift/Alt-click removes one.
        q = (e.shiftKey || e.altKey) ? Math.max(0, q - 1) : q + 1;
        productCounts[pid] = q;
        refresh();
        syncForm();
      });
    }

    function render(data) {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      nodes = {}; seatsByGuid = {}; productAreas = {};
      currency = data.currency || "";
      priceByProduct = {};
      (data.products || []).forEach(function (p) { priceByProduct[p.id] = p; });

      priceLegend.innerHTML = "";
      (data.products || []).forEach(function (p) {
        priceLegend.appendChild(el("span", { class: "smartseat-shop-price" }, [
          swatch(p.color || "#3B82F6"),
          document.createTextNode(" " + (p.name || t("Platz")) + " — " + fmtPrice(p.price, currency)),
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
          + (seat.available ? "" : " (" + t("nicht verfügbar") + ")"));
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
      status.textContent = free ? t("Wähle deine Plätze auf der Karte.") : t("Derzeit keine Plätze verfügbar.");
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
      .then(function (data) { if (data && data.ok) { render(data); syncForm(); } else { status.textContent = t("Sitzplan konnte nicht geladen werden."); } })
      .catch(function () { status.textContent = t("Sitzplan konnte nicht geladen werden."); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
