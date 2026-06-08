/*
 * Smart Seating — read-only auto-seat helper for the native pretix seating page.
 *
 * Fetches a suggested seat group from the plugin's read-only endpoint and shows
 * the recommended seats to the customer. Booking itself is performed by the
 * customer in pretix' own seating widget; this helper never writes state.
 */
(function () {
  "use strict";

  function readConfig() {
    var el = document.getElementById("smartseating-shop-config");
    if (!el) return null;
    try {
      return JSON.parse(el.textContent || "{}");
    } catch (e) {
      return null;
    }
  }

  function t(s) {
    // Minimal i18n hook; pretix exposes gettext on the seating page when available.
    return (typeof window.gettext === "function") ? window.gettext(s) : s;
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === "class") node.className = attrs[k];
      else if (k === "text") node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  function currentSubevent() {
    var input = document.querySelector('input[name="subevent"]');
    return input && input.value ? input.value : "";
  }

  function highlightSeats(guids) {
    // Best-effort: if the rendered plan exposes per-seat DOM nodes, mark them.
    // Many pretix seat maps are canvas-based and expose nothing — in that case
    // we silently fall back to showing labels only.
    var marked = 0;
    guids.forEach(function (guid) {
      var nodes = document.querySelectorAll('[data-seat-guid="' + (window.CSS && CSS.escape ? CSS.escape(guid) : guid) + '"]');
      nodes.forEach(function (n) { n.classList.add("smartseat-suggested"); marked += 1; });
    });
    return marked;
  }

  function build(config) {
    var qty = el("input", {
      type: "number", min: "1", max: "20", value: "2",
      class: "smartseat-as-qty", "aria-label": t("Number of seats"),
    });
    var mode = el("select", { class: "smartseat-as-mode", "aria-label": t("Seating preference") });
    [["strict_adjacent", t("Seats next to each other")],
     ["nearby_row_flexible", t("Close together")],
     ["best_available", t("Best available")]].forEach(function (m) {
      mode.appendChild(el("option", { value: m[0], text: m[1] }));
    });

    var button = el("button", {
      type: "button", class: "btn btn-primary smartseat-as-btn", text: t("Suggest best seats"),
    });
    var result = el("div", { class: "smartseat-as-result", role: "status", "aria-live": "polite" });

    var panel = el("div", { class: "smartseat-as-panel", role: "region", "aria-label": t("Auto seat helper") }, [
      el("div", { class: "smartseat-as-row" }, [
        el("label", { class: "smartseat-as-label", text: t("How many seats?") }), qty,
      ]),
      el("div", { class: "smartseat-as-row" }, [
        el("label", { class: "smartseat-as-label", text: t("Preference") }), mode,
      ]),
      button,
      result,
    ]);

    button.addEventListener("click", function () {
      var n = parseInt(qty.value, 10);
      if (!n || n < 1 || n > 20) { result.textContent = t("Please enter a valid number of seats."); return; }
      button.disabled = true;
      result.textContent = t("Searching for the best seats…");
      var url = config.suggestUrl + "?quantity=" + n + "&mode=" + encodeURIComponent(mode.value);
      var se = currentSubevent();
      if (se) url += "&subevent=" + encodeURIComponent(se);

      fetch(url, { headers: { "Accept": "application/json" }, credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          button.disabled = false;
          if (!data || !data.ok || !data.seats || !data.seats.length) {
            result.textContent = t("No matching group of free seats was found. Try fewer seats or another preference.");
            return;
          }
          var labels = data.seats.map(function (s) { return s.label; }).filter(Boolean);
          var marked = highlightSeats(data.seats.map(function (s) { return s.seat_guid; }));
          result.innerHTML = "";
          result.appendChild(el("strong", { text: t("Recommended seats:") }));
          result.appendChild(el("div", { class: "smartseat-as-list", text: labels.join(" · ") }));
          result.appendChild(el("div", {
            class: "smartseat-as-hint",
            text: marked > 0
              ? t("They are highlighted in the plan — click them to select.")
              : t("Find and select these seats in the plan above."),
          }));
        })
        .catch(function () {
          button.disabled = false;
          result.textContent = t("The seat suggestion service is currently unavailable.");
        });
    });

    return panel;
  }

  function init() {
    var config = readConfig();
    if (!config || !config.suggestUrl) return;
    var host = document.querySelector(".full-screen-seating") || document.body;
    if (!host) return;
    host.appendChild(build(config));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
