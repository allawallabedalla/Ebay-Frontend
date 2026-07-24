/**
 * Kleinanzeigen-Suchassistent — Cloudflare Worker (Dashboard-Version, EINE Datei)
 *
 * Diese Datei ist zum direkten Einfuegen in den Cloudflare-Dashboard-Editor
 * gedacht (kein Terminal noetig). Sie ist inhaltlich identisch mit
 * src/index.js, hat aber die Taxonomie fest eingebaut statt sie zu importieren.
 *
 * Setup im Dashboard:
 *   1. Neuen Worker anlegen, diesen gesamten Code hineinkopieren, Deploy.
 *   2. Settings -> Variables and Secrets -> Secret hinzufuegen:
 *        Name:  ANTHROPIC_API_KEY   Wert: dein sk-ant-... Key
 *   3. Die workers.dev-URL kopieren und in docs/app.js bei WORKER_URL eintragen.
 */

// --- Taxonomie (Orte + Kategorien -> kleinanzeigen.de-IDs), leicht erweiterbar ---
const taxonomy = {
  orte: {
    fulda: {
      locId: '4878',
      slug: 'fulda',
      label: 'Fulda',
      aliase: ['fulda', '36037', '36039', '36041', '36043'],
    },
  },
  kategorien: {
    monitore: {
      catId: '225',
      slug: 'pc-zubehoer-software',
      label: 'PC-Zubehör & Software / Monitore',
      aliase: [
        'monitor', 'monitore', 'bildschirm', 'bildschirme', 'display',
        'gaming-monitor', 'gaming monitor', 'pc-zubehoer', 'pc zubehör', 'pc-zubehör',
      ],
    },
  },
  defaults: { ort: 'fulda', kategorie: 'monitore' },
};

const MODEL = 'claude-sonnet-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

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
      return json({ error: 'internal_error', detail: String((err && err.message) || err) }, 500);
    }
  },
};

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

async function callClaude(env, { system, user, maxTokens = 2000 }) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY ist nicht gesetzt (Dashboard -> Settings -> Variables and Secrets).');
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
      // deterministischen JSON-Extraktionen brauchen wir es nicht.
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

function stripToJson(text) {
  let t = (text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
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

const PARSE_SYSTEM = `Du bist ein Parser, der eine deutsche Freitext-Suche fuer kleinanzeigen.de
in strukturierte Filter uebersetzt. Antworte AUSSCHLIESSLICH mit einem JSON-Objekt,
ohne Markdown-Fences, ohne Erklaerung. Das Schema ist exakt:

{
  "keywords": string,            // BREITER, marktueblicher Suchbegriff (1-2 Woerter, nur Kern-Substantiv)
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
- "keywords" ist der wichtigste Hebel. Waehle einen BREITEN, marktueblichen
  Suchbegriff, wie ihn Verkaeufer im Anzeigentitel schreiben. So allgemein wie
  moeglich (Ziel: viele Treffer), meist nur 1-2 Woerter, nur das Kern-Substantiv.
  KEINE Adjektive (nicht "gaming", "curved", "4k"), KEINE Zoll/Groessen, KEINE
  Zustaende, KEINE Wunschfloskeln. All das kommt in soft_filter bzw. wird erst
  beim Ranking angewendet.
  Beispiele:
    "Gaming-Monitor in Fulda, 24-34 Zoll, wenig genutzt" -> keywords: "monitor"
    "guenstiges iPhone 13 Pro mit wenig Gebrauchsspuren"  -> keywords: "iphone 13"
    "gebrauchtes Trekking-Herrenrad, 28 Zoll"             -> keywords: "fahrrad"
- "muss_enthalten": nur echte Pflichtbegriffe (z.B. ein konkretes Modell, das
  zwingend vorkommen muss). Adjektive wie "gaming" gehoeren NICHT hierher, sonst
  werden passende Anzeigen zu Unrecht ausgeschlossen. Solche Praeferenzen fliessen
  ueber die Original-Anfrage automatisch ins Ranking ein.
- Wuensche wie "bestes Preis-Leistungs-Verhaeltnis" sind KEINE Filter.
- Zollangaben wie "24-34 Zoll" gehoeren nach groesse_zoll [24, 34].
- Zustand ("wenig genutzt", "neu", "defekt") gehoert nach soft_filter.zustand.
- Arrays niemals null, sondern [] wenn leer.`;

async function handleParseQuery(request, env) {
  const { query } = await request.json();
  if (!query || typeof query !== 'string') throw new Error('Feld "query" (string) fehlt.');

  const parseOnce = async () => {
    const raw = await callClaude(env, { system: PARSE_SYSTEM, user: `Suchanfrage: ${query}`, maxTokens: 1000 });
    return JSON.parse(stripToJson(raw));
  };

  let parsed;
  try {
    parsed = await parseOnce();
  } catch (_e) {
    parsed = await parseOnce(); // ein Retry
  }
  return validateParsed(parsed);
}

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

const MAX_PAGES = 3;
const PAGE_DELAY_MS = 1000;
const FETCH_TIMEOUT_MS = 10000;

async function handleSearch(request, env) {
  const filter = validateParsed(await request.json());
  const items = [];
  const seen = new Set();
  let debugUrl = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = buildKleinanzeigenUrl(filter, page);
    if (page === 1) debugUrl = url;

    // -----------------------------------------------------------------------
    // Hinweis zum Scraping / Rate-Limit:
    // Die AGB von kleinanzeigen.de untersagen automatisierten Zugriff. Dieses
    // Tool ist ausschliesslich fuer private, manuell ausgeloeste Einzelabfragen
    // gedacht. Rate-Limit bewusst niedrig halten (max. 3 Seiten pro Suche, 1s
    // Pause, 10s Timeout). Kein Dauer-Crawler, keine Automatisierung.
    // -----------------------------------------------------------------------
    let html;
    try {
      html = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    } catch (_e) {
      break;
    }

    const pageItems = await parseListings(html);
    if (pageItems.length === 0) break;

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

  if (filter.preis_min != null || filter.preis_max != null) {
    const min = filter.preis_min != null ? filter.preis_min : '';
    const max = filter.preis_max != null ? filter.preis_max : '';
    segments.push(`preis:${min}:${max}`);
  }
  if (page > 1) segments.push(`seite:${page}`);

  const catId = kat ? kat.catId : '0';
  const locId = ort ? ort.locId : '';
  segments.push(`k0c${catId}${locId ? 'l' + locId : ''}`);

  return `https://www.kleinanzeigen.de/${segments.join('/')}`;
}

function matchOrt(name) {
  return matchTaxonomy(taxonomy.orte, name) || taxonomy.orte[taxonomy.defaults.ort] || null;
}
function matchKategorie(name) {
  return matchTaxonomy(taxonomy.kategorien, name) || taxonomy.kategorien[taxonomy.defaults.kategorie] || null;
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

async function parseListings(html) {
  const parser = new ListingParser();
  const rewriter = new HTMLRewriter()
    .on('article.aditem', { element(el) { parser.startItem(el); } })
    .on('article.aditem .aditem-main--middle--description', { text(t) { parser.append('beschreibung_snippet', t.text); } })
    .on('article.aditem h2.text-module-begin a.ellipsis', { text(t) { parser.append('titel', t.text); } })
    .on('article.aditem .aditem-main--middle--price-shipping--price', { text(t) { parser.append('_preisRaw', t.text); } })
    .on('article.aditem .aditem-main--top--left', { text(t) { parser.append('_ortRaw', t.text); } })
    .on('article.aditem .aditem-main--top--right', { text(t) { parser.append('datum', t.text); } })
    .on('article.aditem .aditem-main--bottom .simpletag', {
      element() { parser.pushTagStart(); },
      text(t) { parser.append('_tagBuf', t.text); },
    });

  await rewriter.transform(new Response(html)).text();
  return parser.finalize();
}

class ListingParser {
  constructor() { this.items = []; this.current = null; }
  startItem(el) {
    if (this.current) this.items.push(this.current);
    this.current = {
      id: el.getAttribute('data-adid') || null,
      _href: el.getAttribute('data-href') || null,
      titel: '', beschreibung_snippet: '', _preisRaw: '', _ortRaw: '', datum: '',
      _tags: [], _tagBuf: '',
    };
  }
  append(field, text) {
    if (!this.current) return;
    this.current[field] = (this.current[field] || '') + text;
  }
  pushTagStart() {
    if (!this.current) return;
    if (this.current._tagBuf.trim()) this.current._tags.push(this.current._tagBuf.trim());
    this.current._tagBuf = '';
  }
  finalize() {
    if (this.current) this.items.push(this.current);
    this.current = null;
    return this.items.map(normalizeItem).filter((it) => it.titel);
  }
}

function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

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
    preis, preis_typ, plz, ort,
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

  const batches = [];
  for (let i = 0; i < items.length; i += RANK_BATCH_SIZE) {
    batches.push(items.slice(i, i + RANK_BATCH_SIZE));
  }

  const byId = new Map(items.map((it) => [String(it.id), it]));
  const rankings = [];

  for (const batch of batches) {
    const compact = batch.map((it) => ({
      id: it.id, titel: it.titel, beschreibung: it.beschreibung_snippet,
      preis: it.preis, preis_typ: it.preis_typ, ort: it.ort,
    }));
    const user =
      `Urspruengliche Anfrage: ${original_query}\n\n` +
      `soft_filter: ${JSON.stringify(soft_filter)}\n\n` +
      `Angebote:\n${JSON.stringify(compact)}`;

    const runOnce = async () => {
      const raw = await callClaude(env, { system: RANK_SYSTEM, user, maxTokens: 4000 });
      return JSON.parse(stripToJson(raw));
    };
    let parsed;
    try {
      parsed = await runOnce();
    } catch (_e) {
      parsed = await runOnce();
    }
    if (Array.isArray(parsed)) rankings.push(...parsed);
  }

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
