# Sitzplan-Editor – die komplette Anleitung

Mit **Smart Seating** baust du in pretix grafische Saalpläne: Sitzreihen, Tische, Blöcke,
Bögen, Bühnen und freie Flächen. Du weist jedem Bereich eine *Preiskategorie* zu,
veröffentlichst den Plan auf dein Event – und im Shop wählen deine Gäste ihre Plätze direkt
auf der Karte.

> **In 30 Sekunden:** Smart Seating ist *kein* eigenes Verkaufssystem. Es füttert das
> **native Seating von pretix**. Verfügbarkeit, Warenkorb, Bezahlung und Tickets laufen
> komplett über pretix – der Editor liefert nur den Plan und die Zuordnung
> „welcher Sitz = welches Produkt“.

> **Import in BookStack:** Diese Datei im Markdown-Editor einer neuen Seite einfügen.
> Alternativ die beiliegende `sitzplan-anleitung.html` über den WYSIWYG-Quellcode importieren.

---

## 1. Überblick: die drei Bausteine
- **Plan (Editor):** Hier zeichnest du den Saal. Pro Veranstalter als Standort-Preset wiederverwendbar.
- **Kategorien (Preiszonen):** Farbige Gruppen wie „Stalls“, „Balkon“, „Stehplatz“. Werden beim Veröffentlichen auf pretix-Produkte gemappt.
- **Veröffentlichen („Apply to event“):** Überträgt den Plan ins native pretix-Seating und erzeugt die echten, buchbaren Sitze.

## 2. Schnellstart
1. Im Backend links auf **Smart Seating**.
2. **„Create plan“** (oder aus einem Standort-Preset).
3. In der Plan-Liste auf **„Edit“** – der Editor öffnet sich.
4. Werkzeug wählen, auf die Fläche klicken, Plätze setzen.
5. Kategorien anlegen und Sitzen zuweisen.
6. **„Save“**, dann **„Apply to event“**.

## 3. Die Editor-Oberfläche
- **Obere Werkzeugleiste:** Save, Apply to event, Undo/Redo, die Zeichen-Werkzeuge, Export/Import.
- **Canvas (Mitte):** die Zeichenfläche.
- **Sidebar (rechts):** drei Reiter – **Build** (Zonen + aktives Werkzeug), **Edit** (Auswahl + Flächen), **Plan** (Plangröße, Kategorien, Gruppen, Hintergrund).

**Navigieren:** Mausrad = Zoom · mittlere Maustaste / Leertaste + ziehen = Pan · Doppelklick auf leere Fläche = Einpassen.

## 4. Elemente platzieren – „Click-to-Place“
1. Werkzeug oben anklicken (z. B. **Table**).
2. Im Build-Reiter Optionen einstellen (Größe, Sitzanzahl, Kategorie …).
3. **Auf den Plan klicken**, wo das Element hin soll.
4. **Esc** zurück zum Auswahl-Werkzeug.

| Werkzeug | Erzeugt |
|---|---|
| **Row** | Eine einzelne Sitzreihe. |
| **Block** | Rechteckiger Block aus Reihen × Sitzen. |
| **Arc** | Gebogene Reihen / Halbkreis (Zentrum, Radius, Winkel). |
| **Table** | Runder/rechteckiger Tisch mit umlaufenden Stühlen. Stuhlanzahl über *„Seats at table“*; runde Tische wachsen bei vielen Stühlen automatisch. |
| **Stage / Round / Label** | Dekorative Flächen: Bühne, runde Fläche, Textlabel. |
| **Polygon** | Freie Vielecke: Ecke für Ecke klicken; Klick auf ersten Punkt / Doppelklick / **Enter** schließt, **Esc** bricht ab. |
| **Curve** | Wie Polygon, aber zu einer weichen, gerundeten Form geglättet – ideal als Bereichs-Markierung. |

## 5. Auswählen & Verschieben
| Aktion | So geht’s |
|---|---|
| Sitz / ganze Gruppe wählen | Sitz anklicken (gehört er zu einer Gruppe → ganze Gruppe) |
| Genau einen Sitz der Gruppe | **Alt + Klick** |
| Mehrere frei (Rechteck) | Auf leerer Fläche aufziehen |
| Auswahl umschalten | **Shift + Klick** |
| Verschieben | Markiertes ziehen |
| Auswahl aufheben | Leere Fläche klicken / **Esc** |

> **Alles bleibt im Canvas:** Verschieben, Skalieren und Platzieren werden auf die Plangröße
> begrenzt – nichts fällt heraus.

## 6. Gruppen (Tische & Blöcke als Einheit)
Tische und Blöcke werden **beim Platzieren automatisch gruppiert** („Table T1“, „Block A“) und
mit gestricheltem Rahmen + Namen angezeigt.

- **Einfachklick** → die ganze Gruppe (als Einheit verschiebbar).
- **Doppelklick** irgendwo auf die Gruppe (auch Tisch/Lücke) → du bist *in* der Gruppe
  (Rahmen durchgezogen, „… — editing“); Klicks wählen jetzt einzelne Sitze.
- **Esc** oder Klick außerhalb verlässt die Gruppe.

## 7. Fläche mit Sitzen füllen
1. Fläche auswählen (Edit-Reiter zeigt ihre Eigenschaften).
2. Unter **„Fill with seats“** *Number of seats* und *Category* wählen.
3. **„Fill with seats“** klicken – Sitze werden gleichmäßig innerhalb der Form verteilt und als Gruppe angelegt.

## 8. Flächen-Rollen: Interaktiv vs. Deko
Im Edit-Reiter unter **„Use as“**:
- **Interactive** – anklick-/bearbeitbares Objekt.
- **Decoration** – gesperrte, **klick-durchlässige** Markierung (stört die Sitzauswahl nicht). Kurven sind standardmäßig Deko.

Gesperrte Deko wieder bearbeiten: **„Edit locked decorations“** im Edit-Reiter aktivieren.

## 9. Bearbeiten: Rotation, Ausrichten, Größe
- **Rotations-Griff:** runder Griff oben bei Auswahl; ziehen dreht, **Shift** = 15°-Raster.
- **Größe (Flächen):** acht Anfasser zum Skalieren.
- **Ausrichten & Verteilen:** bei 2+ Sitzen im Edit-Reiter.
- **Ausricht-Hilfslinien:** rasten beim Ziehen an Nachbar-x/y ein.

## 10. Kategorien (Preiszonen) & Sitztypen
Plan-Reiter → „Categories“: Name + Farbe anlegen. Sitze bekommen die Kategorie beim Erzeugen
(Werkzeug-Option „Category“) oder nachträglich (auswählen → Edit-Reiter → „Category“).
**Sitztypen:** Normal, Rollstuhl, Begleitung, Technisch, VIP. „Blocked“ = vom Verkauf genommen.

## 11. Zonen
Build-Reiter → Zonen (z. B. „Parkett“, „Rang“). Neue Sitze gehen in die aktive Zone (◉).

## 12. Hintergrund-Vorlagen
Plan-Reiter: Bilder (PNG/JPG/WEBP/GIF/SVG) oder PDF als Layer mit Position/Skalierung/
Rotation/Deckkraft/Sperre – zum Nachzeichnen vorhandener Pläne.

## 13. Speichern & Veröffentlichen
1. **Save** sichert Layout, Kategorien, Gruppen, Zonen.
2. **Apply to event** erzeugt die nativen Sitze und fragt das Mapping **„Kategorie → pretix-Produkt“** ab.

> **Wichtig:** Ab dem Veröffentlichen ist **pretix** die einzige Wahrheit für Verfügbarkeit und
> Verkauf. Plan geändert? Erneut speichern und „Apply to event“.

## 14. Import / Export
- **Export / Import** – plugin-eigenes JSON (volles Layout inkl. Gruppen/Zonen).
- **Export pretix** – natives pretix-/seats.pretix.eu-Format; Import erkennt das Format automatisch.

## 15. Der Shop (Gäste-Ansicht)
- Gäste klicken Sitze an; eine Karte zeigt Reihe, Platz, Preiszone, Preis.
- **„Best available“** wählt automatisch benachbarte Plätze.
- **„Add selected seats to cart“** legt die Plätze in den Warenkorb; Checkout läuft über pretix.
- Verfügbarkeit ist quoten-genau (ausverkaufte Preiszone ⇒ Sitze nicht wählbar).
- Legende: 🟢 Frei · 🔵 Ausgewählt · ⚪ Belegt · ⚫ Gesperrt.

## 16. Tastenkürzel
| Taste | Funktion |
|---|---|
| Leertaste + ziehen | Pan |
| Mausrad | Zoom |
| Doppelklick (leer) | Einpassen |
| Doppelklick (Gruppe) | Gruppe betreten |
| Alt + Klick | Einzelnen Sitz wählen |
| Shift + Klick | Auswahl umschalten |
| Enter | Polygon / Kurve abschließen |
| Esc | Gruppe verlassen / Zeichnen abbrechen / „Select“ |

## 17. Tipps & Problemlösung
- **Änderungen erscheinen nicht?** Hart neu laden: **Strg/⌘ + Shift + R**.
- **Großer Plan ruckelt?** Es werden nur sichtbare Sitze gerendert; Labels werden bei sehr vielen ausgeblendet. Realistisch bis ~5000 Sitze.
- **Sitz nicht einzeln bearbeitbar?** Er ist in einer Gruppe – Doppelklick hinein oder Alt-Klick.
- **Deko stört beim Auswählen?** Fläche auf „Decoration“ setzen (klick-durchlässig).

---
*Smart Seating für pretix · Editor-Anleitung. Stand: Plugin-Version 0.7.x.*
