# Kleinanzeigen-Suchassistent

Zweiteiliges Projekt:

- **`/docs`** – statisches Frontend (Vanilla HTML/CSS/JS) für GitHub Pages
- **`/worker`** – Cloudflare Worker als Backend-Proxy (hält den `ANTHROPIC_API_KEY`)

Du gibst eine Suche in natürlicher Sprache ein, z. B.
*„Gaming-Monitor in Fulda, 24–34 Zoll, wenig genutzt, bestes Preis-Leistungs-Verhältnis“*,
und bekommst eine gefilterte, begründet sortierte Trefferliste von kleinanzeigen.de –
mit direktem Link zu jeder Anzeige.

## Ablauf

```
Frontend ── /parse-query ──▶ Worker ──▶ Claude (Freitext → Filter)
   │  (Filter editierbar bestätigen)
   ├─ /search  ──▶ Worker ──▶ kleinanzeigen.de (Seiten 1–3, HTMLRewriter)
   └─ /rank    ──▶ Worker ──▶ Claude (harte Ausschlüsse + Score + Begründung)
```

Das Frontend spricht **ausschließlich** mit dem Worker, nie direkt mit der Anthropic-API.

---

## 1. Cloudflare Worker deployen

Voraussetzung: [Node.js](https://nodejs.org/) und ein Cloudflare-Account.

```bash
cd worker
npm install
npx wrangler login        # einmalig: Browser-Login bei Cloudflare
```

### Secret setzen (ANTHROPIC_API_KEY)

Der API-Key wird **nicht** in eine Datei geschrieben, sondern als Wrangler-Secret gespeichert:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
# -> Key aus https://console.anthropic.com/ einfügen
```

### Deployen

```bash
npx wrangler deploy
```

Wrangler gibt danach die Worker-URL aus, z. B.:

```
https://kleinanzeigen-suchassistent.DEIN-SUBDOMAIN.workers.dev
```

**Diese URL brauchst du gleich im Frontend.**

### Lokal testen (optional)

```bash
# Key nur für lokale Tests in worker/.dev.vars (nicht committen, steht in .gitignore):
echo 'ANTHROPIC_API_KEY = "sk-ant-..."' > .dev.vars
npx wrangler dev
```

---

## 2. Worker-URL im Frontend eintragen

In **`docs/app.js`** ganz oben:

```js
const WORKER_URL = 'https://kleinanzeigen-suchassistent.DEIN-SUBDOMAIN.workers.dev';
```

durch deine tatsächliche Worker-URL ersetzen (ohne abschließenden `/`).

---

## 3. GitHub Pages aktivieren

1. Änderungen committen und pushen (Branch `main`).
2. Im Repo auf **Settings → Pages**.
3. Unter **Build and deployment → Source**: „Deploy from a branch“.
4. **Branch:** `main`, **Ordner:** `/docs` → **Save**.
5. Nach ein paar Minuten ist die Seite unter
   `https://DEIN-USER.github.io/DEIN-REPO/` erreichbar.

Fertig – Suche eingeben, Filter bestätigen, Treffer ansehen.

---

## Modell & Endpunkte

Das Worker-Backend nutzt **`claude-sonnet-5`**. Endpunkte:

| Endpunkt        | Eingabe                                          | Ausgabe |
|-----------------|--------------------------------------------------|---------|
| `POST /parse-query` | `{ query }`                                  | strukturierte Filter (JSON) |
| `POST /search`      | Filter-JSON                                  | Roh-Trefferliste (Array) |
| `POST /rank`        | `{ items, soft_filter, original_query }`     | bewertete, sortierte Liste |

### Kategorie-/Orts-IDs erweitern

Die Zuordnung von Orten und Kategorien zu kleinanzeigen.de-IDs steht in
**`worker/src/taxonomy.json`**. Im Auslieferungszustand sind **Fulda (`l4878`)**
und **PC-Zubehör/Monitore (`c225`)** hinterlegt. Neue Einträge einfach unter
`orte` bzw. `kategorien` mit `locId`/`catId`, `slug`, `label` und optionalen
`aliase` ergänzen und den Worker neu deployen.

---

## Sicherheit / Missbrauchsschutz

Der Worker ist über eine öffentliche URL erreichbar. Absicherung in drei Stufen:

1. **Anthropic-Ausgabenlimit (wichtigster Schutz):** In der Anthropic Console ein
   monatliches Spend-Limit setzen. Das ist die einzige harte Kostengrenze — bitte
   unbedingt setzen.
2. **CORS + App-Token:** Der Worker akzeptiert nur Anfragen von der eigenen
   GitHub-Pages-Domain (`ALLOWED_ORIGIN`) und mit passendem Header `x-app-token`
   (`APP_TOKEN`). Der Token steht sowohl im Worker (`APP_TOKEN`) als auch im
   Frontend (`docs/app.js`) und muss **identisch** sein. Er ist im öffentlichen
   Frontend sichtbar und daher **kein echtes Geheimnis** — er filtert nur
   zufälligen Fremd-Traffic/Bots ab. Willst du ihn ändern, an **beiden** Stellen
   anpassen und Worker neu deployen.
3. Ein echtes Rate-Limit bräuchte eine eigene Domain (Cloudflare Rate Limiting
   Rules) oder das Workers-Rate-Limit-Binding — für ein privates Tool i. d. R.
   unnötig.

## Rechtliches / Fair Use

Die AGB von kleinanzeigen.de untersagen automatisierten Zugriff. Dieses Werkzeug ist
ausschließlich für **private, manuell ausgelöste Einzelabfragen** gedacht. Deshalb hält
der Worker das Rate-Limit bewusst niedrig: **max. 3 Seiten pro Suche, 1 s Pause zwischen
den Requests, 10 s Timeout**, kein Dauer-Crawler, kein Cronjob, keine Datenbank. Bitte so
belassen und nur sparsam nutzen.
