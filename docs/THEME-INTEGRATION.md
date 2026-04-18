# Theme Integration

## Ziel

Das Shop-Widget soll im gewünschten Schritt der pretix-Presale-Ansicht eingebunden werden.

## 1. Template-Override im Theme

Beispiel für ein Theme-Template:

`pretixpresale/event/checkout_questions.html`

```django
{% extends "pretixpresale/event/checkout_questions.html" %}
{% load smartseating_tags %}

{% block questions_bottom %}
  {{ block.super }}
  {% smartseating_selector %}
{% endblock %}
```

Hinweis:
- Die Position (`questions_bottom`) kann je nach Theme angepasst werden.
- Das Inclusion-Tag erwartet, dass `event` im Template-Kontext vorhanden ist (in pretix-Presale standardmäßig gegeben).

## 2. Styling

Das Selector-Snippet lädt selbst:
- `pretix_smartseating/css/editor.css`

Damit sind Legende, Statusfarben, Canvas/SVG-Container und Toolbar-Elemente sofort verfügbar.

## 3. Verhalten im Shop

- Seat-Plan + Verfügbarkeit werden über die Plugin-API geladen.
- Bei Auto-Seat wird direkt ein Hold erzeugt.
- Holds werden beim Verlassen der Seite nach Möglichkeit freigegeben (`beforeunload`).

## 4. Empfohlene UX-Ergänzungen

- Im Theme einen klaren Hinweis einblenden, dass Sitz-Holds zeitlich ablaufen.
- Fortschrittsanzeige ergänzen, z. B. „Sitze ausgewählt: X“ neben dem Weiter-Button.

