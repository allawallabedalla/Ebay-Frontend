/**
 * Kleinanzeigen-Suchassistent — Cloudflare Worker (Backend-Proxy)
 *
 * Drei Endpunkte:
 *   POST /parse-query  -> Freitext  -> strukturierte Filter (Claude)
 *   POST /search       -> Filter    -> kleinanzeigen.de scrapen -> Roh-Trefferliste
 *   POST /rank         -> Treffer    -> begruendet sortierte Liste (Claude)
 *
 * Das Frontend spricht ausschliesslich mit diesem Worker. Der ANTHROPIC_API_KEY
 * liegt als Wrangler-Secret vor und verlaesst den Worker nie.
 */

import taxonomy from './taxonomy.json';

const MODEL = 'claude-sonnet-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Realistischer Browser-User-Agent fuer die kleinanzeigen.de-Requests.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return preflight();

    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/parse-query') {
        return json(await handleParseQuery(request, env));
      }
      if (request.method === 'POST' && url.pathname === '/search') {
        return json(await handleSearch(request, env));
      }
      if (request.method === 'POST' && url.pathname === '/rank') {
        return json(await handleRank(request, env));
      }
      if (request.method === 'GET' && url.pathname === '/') {
        return json({ ok: true, service: 'kleinanzeigen-suchassistent', model: MODEL });
      }
      return json({ error: 'not_found' }, 404);
    } catch (err) {
      return json({ error: 'internal_error', detail: String(err && err.message || err) }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

// ---------------------------------------------------------------------------
// Anthropic-Aufruf
// ---------------------------------------------------------------------------

async function callClaude(env, { system, user, maxTokens = 2000 }) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY ist nicht gesetzt (wrangler secret put ANTHROPIC_API_KEY).');
  }
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      // Sonnet 5 hat adaptives Thinking standardmaessig an. Fuer diese
      // deterministischen JSON-Extraktionen brauchen wir es nicht und wollen
      // das max_tokens-Budget nicht anteilig fuer Thinking verbrauchen.
      thinking: { type: 'disabled' },
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic-API ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === 'text');
  return block ? block.text : '';
}

/** Entfernt versehentliche ```json ... ``` Fences und schneidet auf das erste JSON zu. */
function stripToJson(text) {
  let t = (text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Falls Modell doch Text drum herum liefert: erstes { bzw. [ bis passendes Ende.
  const firstObj = t.indexOf('{');
  const firstArr = t.indexOf('[');
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start > 0) t = t.slice(start);
  const lastObj = t.lastIndexOf('}');
  const lastArr = t.lastIndexOf(']');
  const end = Math.max(lastObj, lastArr);
  if (end !== -1 && end < t.length - 1) t = t.slice(0, end + 1);
  return t.trim();
}

// ---------------------------------------------------------------------------
// /parse-query
// ---------------------------------------------------------------------------

const PARSE_SYSTEM = `Du bist ein Parser, der eine deutsche Freitext-Suche fuer kleinanzeigen.de
in strukturierte Filter uebersetzt. Antworte AUSSCHLIESSLICH mit einem JSON-Objekt,
ohne Markdown-Fences, ohne Erklaerung. Das Schema ist exakt:

{
  "keywords": string,            // knapper Suchbegriff fuer die URL, z.B. "gaming monitor"
  "ort": string|null,            // Ortsname, z.B. "Fulda", sonst null
  "radius_km": number|null,      // Umkreis in km, sonst null
  "preis_min": number|null,      // Mindestpreis in Euro, sonst null
  "preis_max": number|null,      // Hoechstpreis in Euro, sonst null
  "kategorie": string|null,      // freie Kategorie, z.B. "Monitore", sonst null
  "soft_filter": {
    "groesse_zoll": [number|null, number|null],   // [min, max] Zoll, sonst [null, null]
    "zustand": string|null,       // z.B. "wenig genutzt", "neu", "defekt", sonst null
    "muss_enthalten": string[],   // Begriffe, die im Angebot vorkommen muessen
    "darf_nicht_enthalten": string[]  // Ausschlussbegriffe, z.B. "Halterung", "Kabel"
  }
}

Regeln:
- Extrahiere nur, was tatsaechlich in der Anfrage steht; erfinde nichts.
- "keywords" enthaelt das Kern-Produkt, keine Orte/Preise/Zustaende.
- Wuensche wie "bestes Preis-Leistungs-Verhaeltnis" sind KEINE Filter, ignoriere sie hier.
- Zollangaben wie "24-34 Zoll" gehoeren nach groesse_zoll [24, 34].
- Arrays niemals null, sondern [] wenn leer.`;

async function handleParseQuery(request, env) {
  const { query } = await request.json();
  if (!query || typeof query !== 'string') {
    throw new Error('Feld "query" (string) fehlt.');
  }

  const parseOnce = async () => {
    const raw = await callClaude(env, {
      system: PARSE_SYSTEM,
      user: `Suchanfrage: ${query}`,
      maxTokens: 1000,
    });
    return JSON.parse(stripToJson(raw));
  };

  let parsed;
  try {
    parsed = await parseOnce();
  } catch (_e) {
    // Bei Parse-Fehler EINMAL retryen (Anforderung).
    parsed = await parseOnce();
  }

  return validateParsed(parsed);
}

/** Erzwingt das Schema und setzt Defaults, damit /search sich darauf verlassen kann. */
function validateParsed(p) {
  const num = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v : null);
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
  const sf = (p && p.soft_filter) || {};
  const zoll = Array.isArray(sf.groesse_zoll) ? sf.groesse_zoll : [null, null];

  return {
    keywords: str(p && p.keywords) || '',
    ort: str(p && p.ort),
    radius_km: num(p && p.radius_km),
    preis_min: num(p && p.preis_min),
    preis_max: num(p && p.preis_max),
    kategorie: str(p && p.kategorie),
    soft_filter: {
      groesse_zoll: [num(zoll[0]), num(zoll[1])],
      zustand: str(sf.zustand),
      muss_enthalten: arr(sf.muss_enthalten),
      darf_nicht_enthalten: arr(sf.darf_nicht_enthalten),
    },
  };
}

// ---------------------------------------------------------------------------
// /search
// ---------------------------------------------------------------------------

const MAX_PAGES = 3;
const PAGE_DELAY_MS = 1000; // 1s zwischen den Requests
const FETCH_TIMEOUT_MS = 10000;

async function handleSearch(request, env) {
  const filter = validateParsed(await request.json());

  const items = [];
  const seen = new Set();
  let debugUrl = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = buildKleinanzeigenUrl(filter, page);
    if (page === 1) debugUrl = url;

    // ---------------------------------------------------------------------
    // Hinweis zum Scraping / Rate-Limit:
    // Die AGB von kleinanzeigen.de untersagen automatisierten Zugriff. Dieses
    // Tool ist ausschliesslich fuer private, manuell ausgeloeste Einzelabfragen
    // gedacht. Deshalb: Rate-Limit bewusst niedrig halten (max. 3 Seiten pro
    // Suche, 1s Pause zwischen den Requests, 10s Timeout). Keinen Dauer-Crawler
    // bauen, keine Automatisierung/Cronjobs anhaengen.
    // ---------------------------------------------------------------------
    let html;
    try {
      html = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    } catch (_e) {
      break; // Netzwerk/Timeout: mit dem aufhoeren, was wir haben.
    }

    const pageItems = await parseListings(html);
    if (pageItems.length === 0) break; // keine Treffer mehr -> Ende.

    for (const it of pageItems) {
      if (it.id && seen.has(it.id)) continue;
      if (it.id) seen.add(it.id);
      items.push(it);
    }

    if (page < MAX_PAGES) await sleep(PAGE_DELAY_MS);
  }

  return { url: debugUrl, count: items.length, items };
}

function buildKleinanzeigenUrl(filter, page) {
  const ort = matchOrt(filter.ort);
  const kat = matchKategorie(filter.kategorie || filter.keywords);

  const slug = kat ? kat.slug : 's';
  const ortSlug = ort ? ort.slug : (filter.ort ? slugify(filter.ort) : '');
  const keywords = slugify(filter.keywords || (filter.kategorie || ''));

  const segments = [`s-${slug}`];
  if (ortSlug) segments.push(ortSlug);
  if (keywords) segments.push(keywords);

  // Preisfilter als Pfadsegment: /preis:{min}:{max}/
  if (filter.preis_min != null || filter.preis_max != null) {
    const min = filter.preis_min != null ? filter.preis_min : '';
    const max = filter.preis_max != null ? filter.preis_max : '';
    segments.push(`preis:${min}:${max}`);
  }

  // Seiten: /seite:{n}/
  if (page > 1) segments.push(`seite:${page}`);

  // Kategorie-/Orts-IDs: k0c{catId}l{locId}
  const catId = kat ? kat.catId : '0';
  const locId = ort ? ort.locId : '';
  segments.push(`k0c${catId}${locId ? 'l' + locId : ''}`);

  return `https://www.kleinanzeigen.de/${segments.join('/')}`;
}

// -- Taxonomie-Matching ------------------------------------------------------

function matchOrt(name) {
  return matchTaxonomy(taxonomy.orte, name) || taxonomy.orte[taxonomy.defaults.ort] || null;
}

function matchKategorie(name) {
  return matchTaxonomy(taxonomy.kategorien, name) ||
    taxonomy.kategorien[taxonomy.defaults.kategorie] || null;
}

function matchTaxonomy(map, name) {
  if (!name) return null;
  const needle = name.toLowerCase();
  for (const key of Object.keys(map)) {
    if (key.startsWith('_')) continue;
    const entry = map[key];
    const candidates = [entry.label, ...(entry.aliase || [])].map((s) => s.toLowerCase());
    if (candidates.some((c) => needle.includes(c) || c.includes(needle))) return entry;
  }
  return null;
}

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// -- HTML-Parsing via HTMLRewriter ------------------------------------------

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Parst die Trefferliste einer kleinanzeigen.de-Ergebnisseite (Struktur:
 * <article class="aditem" data-adid data-href> ...). HTMLRewriter arbeitet
 * streaming und in Dokumentreihenfolge; wir tracken das jeweils aktuelle Item.
 */
async function parseListings(html) {
  const parser = new ListingParser();
  const rewriter = new HTMLRewriter()
    .on('article.aditem', {
      element(el) { parser.startItem(el); },
    })
    .on('article.aditem .aditem-main--middle--description', {
      text(t) { parser.append('beschreibung_snippet', t.text); },
    })
    .on('article.aditem h2.text-module-begin a.ellipsis', {
      text(t) { parser.append('titel', t.text); },
    })
    .on('article.aditem .aditem-main--middle--price-shipping--price', {
      text(t) { parser.append('_preisRaw', t.text); },
    })
    .on('article.aditem .aditem-main--top--left', {
      text(t) { parser.append('_ortRaw', t.text); },
    })
    .on('article.aditem .aditem-main--top--right', {
      text(t) { parser.append('datum', t.text); },
    })
    .on('article.aditem .aditem-main--bottom .simpletag', {
      element() { parser.pushTagStart(); },
      text(t) { parser.append('_tagBuf', t.text); },
    });

  // HTMLRewriter braucht eine Response, die es durchstreamt.
  await rewriter.transform(new Response(html)).text();
  return parser.finalize();
}

class ListingParser {
  constructor() {
    this.items = [];
    this.current = null;
  }

  startItem(el) {
    // Vorheriges Item abschliessen.
    if (this.current) this.items.push(this.current);
    this.current = {
      id: el.getAttribute('data-adid') || null,
      _href: el.getAttribute('data-href') || null,
      titel: '',
      beschreibung_snippet: '',
      _preisRaw: '',
      _ortRaw: '',
      datum: '',
      _tags: [],
      _tagBuf: '',
    };
  }

  append(field, text) {
    if (!this.current) return;
    this.current[field] = (this.current[field] || '') + text;
  }

  pushTagStart() {
    if (!this.current) return;
    // Vorherigen Tag-Puffer sichern, neuen beginnen.
    if (this.current._tagBuf.trim()) this.current._tags.push(this.current._tagBuf.trim());
    this.current._tagBuf = '';
  }

  finalize() {
    if (this.current) this.items.push(this.current);
    this.current = null;
    return this.items.map(normalizeItem).filter((it) => it.titel);
  }
}

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function normalizeItem(raw) {
  const tags = [...(raw._tags || [])];
  if (raw._tagBuf && raw._tagBuf.trim()) tags.push(raw._tagBuf.trim());
  const tagsLc = tags.map((t) => t.toLowerCase());

  const { preis, preis_typ } = parsePreis(raw._preisRaw);
  const { plz, ort } = parseOrt(raw._ortRaw);

  const href = raw._href || '';
  const url = href.startsWith('http')
    ? href
    : (href ? `https://www.kleinanzeigen.de${href.startsWith('/') ? '' : '/'}${href}` : null);

  return {
    id: raw.id,
    titel: clean(raw.titel),
    beschreibung_snippet: clean(raw.beschreibung_snippet),
    preis,
    preis_typ,
    plz,
    ort,
    datum: clean(raw.datum),
    url,
    versand_moeglich: tagsLc.some((t) => t.includes('versand')),
    direkt_kaufen: tagsLc.some((t) => t.includes('direkt kaufen') || t.includes('direktkauf')),
  };
}

function parsePreis(rawIn) {
  const raw = clean(rawIn);
  const low = raw.toLowerCase();
  if (low.includes('verschenk')) return { preis: 0, preis_typ: 'verschenken' };
  const match = raw.replace(/\./g, '').match(/(\d+)/);
  const preis = match ? parseInt(match[1], 10) : null;
  const preis_typ = low.includes('vb') ? 'VB' : (preis != null ? 'fix' : null);
  return { preis, preis_typ };
}

function parseOrt(rawIn) {
  const raw = clean(rawIn);
  const m = raw.match(/(\d{5})\s+(.+?)(?:\s*\(.*)?$/);
  if (m) return { plz: m[1], ort: clean(m[2]) };
  return { plz: null, ort: raw || null };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// /rank
// ---------------------------------------------------------------------------

const RANK_BATCH_SIZE = 40;

const RANK_SYSTEM = `Du bist ein kritischer Einkaufsassistent fuer kleinanzeigen.de.
Du bekommst eine urspruengliche Nutzeranfrage, weiche Filter (soft_filter) und
eine Liste von Angeboten als JSON. Deine Aufgabe:

1. Harte Ausschluesse anwenden. Entferne ein Angebot, wenn es klar nicht passt:
   - Groesse (Zoll) ausserhalb der Range in soft_filter.groesse_zoll (wenn im Text erkennbar).
   - Es ist Zubehoer (Halterung, Kabel, Ersatzteil) statt des gesuchten Geraets.
   - Ein Begriff aus darf_nicht_enthalten kommt vor.
   - Ein Begriff aus muss_enthalten fehlt eindeutig.
2. Jeden verbleibenden Treffer bewerten:
   - "score": Ganzzahl 0-100 (Passung zur Anfrage inkl. Preis-Leistung).
   - "begruendung": EIN kurzer Satz auf Deutsch.
   - "unklar": true, wenn entscheidende Info im Text fehlt (z.B. kein Modell/keine Zollangabe genannt).

Antworte AUSSCHLIESSLICH mit einem JSON-Array, absteigend nach score sortiert,
ohne Markdown-Fences, ohne Erklaerung. Schema pro Element:
{
  "id": string,          // die id des Angebots unveraendert uebernehmen
  "score": number,
  "begruendung": string,
  "unklar": boolean
}
Gib nur Elemente zurueck, die NICHT hart ausgeschlossen wurden.`;

async function handleRank(request, env) {
  const body = await request.json();
  const items = Array.isArray(body.items) ? body.items : [];
  const soft_filter = body.soft_filter || {};
  const original_query = body.original_query || '';

  if (items.length === 0) return { items: [] };

  // Bei >40 Items batchen, damit der Kontext nicht platzt.
  const batches = [];
  for (let i = 0; i < items.length; i += RANK_BATCH_SIZE) {
    batches.push(items.slice(i, i + RANK_BATCH_SIZE));
  }

  const byId = new Map(items.map((it) => [String(it.id), it]));
  const rankings = [];

  for (const batch of batches) {
    const compact = batch.map((it) => ({
      id: it.id,
      titel: it.titel,
      beschreibung: it.beschreibung_snippet,
      preis: it.preis,
      preis_typ: it.preis_typ,
      ort: it.ort,
    }));

    const user =
      `Urspruengliche Anfrage: ${original_query}\n\n` +
      `soft_filter: ${JSON.stringify(soft_filter)}\n\n` +
      `Angebote:\n${JSON.stringify(compact)}`;

    let parsed;
    const runOnce = async () => {
      const raw = await callClaude(env, { system: RANK_SYSTEM, user, maxTokens: 4000 });
      return JSON.parse(stripToJson(raw));
    };
    try {
      parsed = await runOnce();
    } catch (_e) {
      parsed = await runOnce(); // einmal retryen
    }

    if (Array.isArray(parsed)) rankings.push(...parsed);
  }

  // Rankings mit den Original-Items zusammenfuehren.
  const merged = [];
  for (const r of rankings) {
    const item = byId.get(String(r.id));
    if (!item) continue;
    merged.push({
      ...item,
      score: typeof r.score === 'number' ? r.score : 0,
      begruendung: typeof r.begruendung === 'string' ? r.begruendung : '',
      unklar: !!r.unklar,
    });
  }

  merged.sort((a, b) => b.score - a.score);
  return { items: merged };
}
