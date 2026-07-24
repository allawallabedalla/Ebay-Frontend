/* ==========================================================================
 * Kleinanzeigen-Suchassistent — Frontend (Vanilla JS, keine Dependencies)
 *
 * ▶ HIER die eigene Worker-URL eintragen (nach `wrangler deploy`):
 * ========================================================================== */
const WORKER_URL = 'https://kleinanzeigen-suchassisten.abseits.workers.dev';

// Muss mit APP_TOKEN im Worker uebereinstimmen. KEIN echtes Geheimnis (im
// oeffentlichen Frontend sichtbar) – nur ein einfacher Bot-/Fremd-Traffic-Filter.
const APP_TOKEN = 'ka-suche-2f9c7a';

/* -------------------------------------------------------------------------- */

// Letzte Suche im Speicher halten (kein localStorage noetig).
const state = {
  query: '',
  filter: null,   // Ergebnis von /parse-query
  items: [],      // Roh-Treffer von /search
  ranked: [],     // bewertete Treffer von /rank
};

const $ = (id) => document.getElementById(id);

const el = {
  form: $('searchForm'),
  query: $('query'),
  submit: $('submitBtn'),
  phases: $('phases'),
  filterCard: $('filterCard'),
  runSearch: $('runSearchBtn'),
  rawLink: $('rawLink'),
  status: $('status'),
  results: $('results'),
};

// -------------------------------------------------------------------------
// Phasen-Anzeige
// -------------------------------------------------------------------------

function setPhase(name, status /* 'active' | 'done' */) {
  el.phases.hidden = false;
  const li = el.phases.querySelector(`[data-phase="${name}"]`);
  if (!li) return;
  li.classList.remove('active', 'done');
  if (status) li.classList.add(status);
}

function resetPhases() {
  el.phases.querySelectorAll('li').forEach((li) => li.classList.remove('active', 'done'));
}

function showStatus(msg, isError = false) {
  el.status.hidden = false;
  el.status.textContent = msg;
  el.status.classList.toggle('error', isError);
}

function clearStatus() {
  el.status.hidden = true;
  el.status.textContent = '';
  el.status.classList.remove('error');
}

// -------------------------------------------------------------------------
// Worker-Aufrufe
// -------------------------------------------------------------------------

async function post(path, body) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-token': APP_TOKEN },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || data.error || `Fehler ${res.status} bei ${path}`);
  }
  return data;
}

// -------------------------------------------------------------------------
// Schritt 1: Verstehen (parse-query) -> Filter zur Bestaetigung anzeigen
// -------------------------------------------------------------------------

// Hauptbutton „Suchen“: versteht die Anfrage, zeigt das Parameterfeld an UND
// startet direkt die Suche + Bewertung (ohne extra Bestaetigungsklick).
el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = el.query.value.trim();
  if (!query) return;

  state.query = query;
  el.results.innerHTML = '';
  el.filterCard.hidden = true;
  clearStatus();
  resetPhases();
  lock(true);

  let filter;
  try {
    setPhase('parse', 'active');
    filter = await post('/parse-query', { query });
    state.filter = filter;
    setPhase('parse', 'done');
    fillFilterForm(filter);
    el.filterCard.hidden = false; // Parameterfeld sofort einblenden
  } catch (err) {
    showStatus(`Konnte die Anfrage nicht verstehen: ${err.message}`, true);
    lock(false);
    return;
  }

  // Direkt weiter mit Suchen + Bewerten. Falls du danach etwas aenderst,
  // startet der Button in der Karte die Suche erneut.
  await performSearch(readFilterForm());
});

// Button in der Filter-Karte: nach manueller Aenderung erneut suchen.
el.runSearch.addEventListener('click', () => {
  performSearch(readFilterForm());
});

// -------------------------------------------------------------------------
// Suchen (search) + Bewerten (rank) — gemeinsame Logik
// -------------------------------------------------------------------------

async function performSearch(filter) {
  state.filter = filter;
  state.items = [];
  state.ranked = [];
  el.results.innerHTML = '';
  clearStatus();
  lock(true);

  try {
    // --- Suchen ---
    setPhase('search', 'active');
    const searchRes = await post('/search', filter);
    state.items = searchRes.items || [];
    if (searchRes.url) {
      el.rawLink.href = searchRes.url;
      el.rawLink.hidden = false;
    }
    setPhase('search', 'done');

    if (state.items.length === 0) {
      showStatus('Keine Treffer gefunden. Passe die Filter an (z. B. breiterer Suchbegriff) und suche erneut.');
      return;
    }

    // --- Bewerten ---
    setPhase('rank', 'active');
    showStatus(`${state.items.length} Treffer gefunden, werden bewertet …`);
    const rankRes = await post('/rank', {
      items: state.items,
      soft_filter: filter.soft_filter,
      original_query: state.query,
    });
    state.ranked = rankRes.items || [];
    setPhase('rank', 'done');
    clearStatus();

    renderResults(state.ranked);
    if (state.ranked.length === 0) {
      showStatus('Nach der Bewertung blieb kein Treffer uebrig (alle hart ausgeschlossen).');
    }
  } catch (err) {
    showStatus(`Fehler: ${err.message}`, true);
    resetPhases();
  } finally {
    lock(false);
  }
}

// -------------------------------------------------------------------------
// Filter-Formular <-> Objekt
// -------------------------------------------------------------------------

function fillFilterForm(f) {
  $('f_keywords').value = f.keywords || '';
  $('f_ort').value = f.ort || '';
  $('f_radius').value = f.radius_km ?? '';
  $('f_kategorie').value = f.kategorie || '';
  $('f_preis_min').value = f.preis_min ?? '';
  $('f_preis_max').value = f.preis_max ?? '';
  const z = (f.soft_filter && f.soft_filter.groesse_zoll) || [null, null];
  $('f_zoll_min').value = z[0] ?? '';
  $('f_zoll_max').value = z[1] ?? '';
  $('f_zustand').value = (f.soft_filter && f.soft_filter.zustand) || '';
  $('f_muss').value = ((f.soft_filter && f.soft_filter.muss_enthalten) || []).join(', ');
  $('f_nicht').value = ((f.soft_filter && f.soft_filter.darf_nicht_enthalten) || []).join(', ');
}

function readFilterForm() {
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
  return {
    keywords: $('f_keywords').value.trim(),
    ort: $('f_ort').value.trim() || null,
    radius_km: num($('f_radius').value),
    kategorie: $('f_kategorie').value.trim() || null,
    preis_min: num($('f_preis_min').value),
    preis_max: num($('f_preis_max').value),
    soft_filter: {
      groesse_zoll: [num($('f_zoll_min').value), num($('f_zoll_max').value)],
      zustand: $('f_zustand').value.trim() || null,
      muss_enthalten: list($('f_muss').value),
      darf_nicht_enthalten: list($('f_nicht').value),
    },
  };
}

// -------------------------------------------------------------------------
// Ergebnisse rendern
// -------------------------------------------------------------------------

function renderResults(items) {
  el.results.innerHTML = '';
  for (const it of items) {
    el.results.appendChild(renderCard(it));
  }
}

function renderCard(it) {
  const card = document.createElement('article');
  card.className = 'result';

  const score = Math.max(0, Math.min(100, Number(it.score) || 0));
  const preis = formatPreis(it);

  card.innerHTML = `
    <div class="result-head">
      <a href="${escapeAttr(it.url || '#')}" target="_blank" rel="noopener">${escapeHtml(it.titel || 'Ohne Titel')}</a>
      <span class="price">${escapeHtml(preis)}</span>
    </div>
    <div class="meta">
      ${it.ort ? `<span>${escapeHtml([it.plz, it.ort].filter(Boolean).join(' '))}</span>` : ''}
      ${it.datum ? `<span>${escapeHtml(it.datum)}</span>` : ''}
      ${it.versand_moeglich ? `<span class="tag">Versand</span>` : ''}
      ${it.direkt_kaufen ? `<span class="tag">Direkt kaufen</span>` : ''}
    </div>
    <div class="scorebar">
      <div class="track"><div class="fill" style="width:${score}%"></div></div>
      <span class="num">${score}/100</span>
    </div>
    <div class="reason">
      ${escapeHtml(it.begruendung || '')}
      ${it.unklar ? `<span class="badge-unklar">unklar</span>` : ''}
    </div>
    ${it.beschreibung_snippet ? `<div class="snippet">${escapeHtml(it.beschreibung_snippet)}</div>` : ''}
  `;
  return card;
}

function formatPreis(it) {
  if (it.preis_typ === 'verschenken') return 'Zu verschenken';
  if (it.preis == null) return 'Preis k. A.';
  const p = `${it.preis} €`;
  return it.preis_typ === 'VB' ? `${p} VB` : p;
}

// -------------------------------------------------------------------------
// Helfer
// -------------------------------------------------------------------------

function lock(isLocked) {
  el.submit.disabled = isLocked;
  el.runSearch.disabled = isLocked;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) {
  return escapeHtml(s);
}

// Warnung, falls die Worker-URL nicht gesetzt wurde.
if (WORKER_URL.includes('DEIN-SUBDOMAIN')) {
  window.addEventListener('DOMContentLoaded', () => {
    showStatus('Hinweis: In docs/app.js die WORKER_URL auf deine Cloudflare-Worker-Adresse setzen.', true);
  });
}
