#!/usr/bin/env node
/**
 * fetch-rss.js
 * Eseguito da GitHub Actions (Node >= 20, zero dipendenze).
 *
 * Strategia di raccolta notizie:
 *  1. GDELT DOC 2.0 API  — API accademica pubblica, senza chiavi, pensata per
 *     query programmatiche. Restituisce JSON con titolo, URL, data, fonte.
 *     Resistente ai blocchi IP perché è un servizio progettato per CI/bot.
 *  2. Feed RSS diretti    — tentativo secondario per le fonti regionali che
 *     potrebbero rispondere (fallback silenzioso se 403/timeout).
 *
 * Output: data/news.json con le notizie già filtrate per ogni tematica.
 */

const fs   = require('node:fs');
const path = require('node:path');

const OUTPUT_FILE       = path.join(__dirname, '..', 'data', 'news.json');
const RSS_MAX_ITEMS     = 20;
const FETCH_TIMEOUT_MS  = 18000;
const MAX_RETRIES       = 2;
const STAGGER_MS        = 500;
const MAX_ITEM_AGE_DAYS = 45;

// Lingue dei feed RSS (usate per il campo lang degli item)
// I feed in inglese non specificano una lingua nel feed stesso,
// quindi la mappiamo per fonte.
const RSS_FEED_LANG = {
  'BBC Africa':         'en',
  'BBC World':          'en',
  'Agenzia Nova':       'it',
  'ANSA English':       'en',
  'ANSAmed (ar)':       'ar',
  'Horn Observer':      'en',
  'Crisis Group':       'en',
  'The New Humanitarian': 'en',
  'Africanews':         'en',
  'AllAfrica':          'en',
};

// Mappa il campo language di GDELT (stringa lunga in inglese) → codice breve
function gdeltLangCode(gdeltLang) {
  const map = {
    english: 'en', italian: 'it', arabic: 'ar', french: 'fr',
    spanish: 'es', german: 'de', portuguese: 'pt', amharic: 'am',
    somali: 'so', swahili: 'sw', turkish: 'tr', chinese: 'zh',
  };
  return map[(gdeltLang || '').toLowerCase()] || 'en';
}

/* ------------------------------------------------------------------
   GDELT DOC 2.0 API
   Docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
   Endpoint: https://api.gdeltproject.org/api/v2/doc/doc
   mode=ArtList → lista articoli (JSON, max 250)
   maxrecords=75
   startdatetime/enddatetime → range esplicito (più affidabile di timespan)
   format=json
   sourcelang:eng → solo articoli in inglese (titoli leggibili e match keyword)
   ------------------------------------------------------------------ */
const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';

// GDELT vuole il formato YYYYMMDDHHMMSS in UTC
function gdeltDateStamp(date) {
  const p = n => String(n).padStart(2, '0');
  return (
    date.getUTCFullYear() +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds())
  );
}

function gdeltUrl(query) {
  const now   = new Date();
  const start = new Date(now.getTime() - MAX_ITEM_AGE_DAYS * 86400000);

  const params = new URLSearchParams({
    query:         query,
    mode:          'ArtList',
    maxrecords:    '75',
    startdatetime: gdeltDateStamp(start),
    enddatetime:   gdeltDateStamp(now),
    sort:          'DateDesc',
    format:        'json',
  });
  return `${GDELT_BASE}?${params}`;
}

/* ------------------------------------------------------------------
   Feed RSS di fallback (fonti regionali che spesso non bloccano)
   ------------------------------------------------------------------ */
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'application/rss+xml, application/rdf+xml, application/atom+xml, ' +
    'application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
  'Cache-Control':   'no-cache',
};

const RSS_FEEDS = [
  { source: 'BBC Africa',       url: 'https://feeds.bbci.co.uk/news/world/africa/rss.xml' },
  { source: 'BBC World',        url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { source: 'Agenzia Nova',     url: 'https://www.agenzianova.com/rss/tuttiititolidinova' },
  { source: 'ANSA English',     url: 'https://www.ansa.it/english/news/english_nr_rss.xml' },
  { source: 'ANSAmed (ar)',     url: 'https://www.ansa.it/ansamednew/ar/notizie/ansamedar_nr_rss.xml' },
  { source: 'Horn Observer',    url: 'https://hornobserver.com/assets/rss.php?cid=1' },
  { source: 'Crisis Group',     url: 'https://www.crisisgroup.org/rss/1' },
  { source: 'The New Humanitarian', url: 'https://www.thenewhumanitarian.org/rss/all.xml' },
  { source: 'Africanews',       url: 'https://www.africanews.com/feed/rss' },
  { source: 'AllAfrica',        url: 'https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf' },
];

/* ------------------------------------------------------------------
   Tematiche — query GDELT + keyword per il matching RSS
   ------------------------------------------------------------------ */
const TOPICS = {
  'egypt-somalia': {
    title:       'Accordi Egitto-Somalia',
    // Query GDELT: AND implicito tra i due gruppi; OR interno al secondo gruppo
    gdeltQuery:  '(Egypt Somalia) (agreement OR military OR security OR defense OR cooperation OR pact OR treaty OR deal) sourcelang:eng',
    minMatches:  2,
    keywords: [
      // Gruppo 1 — soggetto geografico (obbligatorio)
      ['egypt', 'egitto', 'egizian', 'cairo', 'il cairo'],
      // Gruppo 2 — controparte (obbligatorio)
      ['somalia', 'somal', 'mogadiscio', 'mogadishu'],
      // Gruppo 3 — tema relazionale
      ['agreement', 'accordo', 'intesa', 'patto', 'trattato', 'mou',
       'memorandum', 'military', 'militar', 'difesa', 'defense',
       'security', 'sicurezza', 'cooperaz', 'cooperation', 'deal',
       'pact', 'treaty', 'partner', 'alliance', 'alleanz', 'weapon',
       'arm', 'naval', 'navale', 'port', 'porto', 'base'],
    ],
  },

  somaliland: {
    title:       'Dossier Somaliland',
    gdeltQuery:  'Somaliland (Ethiopia OR port OR Berbera OR agreement OR memorandum OR recognition OR corridor) sourcelang:eng',
    minMatches:  2,
    keywords: [
      // Gruppo 1 — Somaliland (termine univoco, da solo obbligatorio)
      ['somaliland'],
      // Gruppo 2 — attori collegati
      ['ethiopia', 'etiopia', 'etiop', 'addis abeba', 'addis ababa',
       'abiy ahmed', 'hargeisa', 'somalia', 'djibouti', 'gibuti',
       'kenya', 'gulf', 'golfo', 'uae', 'emirati'],
      // Gruppo 3 — temi
      ['agreement', 'accordo', 'intesa', 'mou', 'memorandum',
       'recognition', 'riconosciment', 'port', 'porto', 'berbera',
       'corridor', 'corridoio', 'deal', 'pact', 'naval', 'base',
       'independence', 'indipenden', 'secession', 'secessione',
       'autonomy', 'autonomia'],
    ],
  },

  'ethiopia-sea-access': {
    title:       'Accesso etiope al mare',
    gdeltQuery:  'Ethiopia (port OR "Red Sea" OR Berbera OR "sea access" OR landlocked OR corridor OR coastline OR maritime OR Djibouti OR Eritrea) sourcelang:eng',
    minMatches:  2,
    keywords: [
      // Gruppo 1 — soggetto (obbligatorio)
      ['ethiopia', 'etiopia', 'etiop', 'addis abeba', 'addis ababa', 'abiy'],
      // Gruppo 2 — tema geografico/marittimo
      ['sea access', 'accesso al mare', 'sbocco al mare', 'landlocked',
       'senza sbocco', 'port', 'porto', 'red sea', 'mar rosso',
       'berbera', 'corridoio', 'corridor', 'coast', 'costa', 'maritime',
       'marittim', 'naval', 'navale', 'gulf', 'golfo', 'aden',
       'djibouti', 'gibuti', 'eritrea', 'assab', 'massawa'],
      // Gruppo 3 — dinamica geopolitica
      ['agreement', 'accordo', 'intesa', 'deal', 'negotiat', 'negoziat',
       'somaliland', 'somalia', 'tension', 'tensione', 'dispute',
       'disputa', 'conflict', 'conflitto', 'strategic', 'strategico'],
    ],
  },

  'egypt-economy': {
    title:       'Fragilità economica egiziana',
    // "Egyptian" cattura articoli che usano l'aggettivo invece del nome proprio
    // (es. "Egyptian pound", "Egyptian economy") che GDELT non trova con solo "Egypt"
    gdeltQuery:  '(Egypt OR Egyptian) (economy OR economic OR inflation OR debt OR currency OR deficit OR IMF OR "Suez Canal" OR finance OR austerity OR "foreign reserves" OR pound OR GDP) sourcelang:eng',
    minMatches:  2,
    keywords: [
      // Gruppo 1 — soggetto (obbligatorio)
      ['egypt', 'egyptian', 'egitto', 'egizian', 'cairo', 'il cairo', 'sisi'],
      // Gruppo 2 — tema economico (prefissi IT + termini EN interi)
      ['econom', 'imf', 'fmi', 'inflation', 'inflazion', 'debt', 'debito',
       'currency', 'valut', 'pound', 'sterlina', 'deficit', 'fiscal',
       'fiscale', 'austerity', 'austerità', 'gdp', 'pil', 'recession',
       'recessione', 'finance', 'financial', 'finanz', 'budget', 'bilancio',
       'investment', 'investiment', 'trade', 'commerc', 'suez', 'revenue',
       'ricavi', 'crisis', 'crisi', 'reserves', 'riserve', 'devaluat',
       'svalutaz', 'loan', 'prestito', 'bailout', 'subsid', 'sussid',
       'reform', 'riforma', 'privatiz', 'bond', 'obbligaz'],
    ],
  },

  'gerd-opacity': {
    title:       'Opacità sui rilasci GERD',
    // IMPORTANTE: non usare mai "GERD" isolato nella query → cattura
    // articoli sul calciatore Gerd Müller o altri omonimi.
    // Usiamo sempre la forma lunga o combinazioni disambiguanti.
    gdeltQuery:  '("Grand Ethiopian Renaissance Dam" OR "Renaissance Dam" OR "Nile dam" OR "Ethiopian dam") (Egypt OR Ethiopia OR Sudan OR water OR Nile OR negotiation OR filling OR flow OR reservoir) sourcelang:eng',
    minMatches:  2,
    keywords: [
      // Gruppo 1 — identificatori della diga senza "gerd" isolato
      // Per il matching RSS (che usa includes()) "gerd" da solo è ancora
      // troppo generico: lo disambiguiamo richiedendo sempre un secondo
      // termine dello stesso gruppo tramite il gruppo 2 obbligatorio.
      ['renaissance dam', 'grand ethiopian', 'grande diga etiopica',
       'nile dam', 'diga del nilo', 'diga etiope', 'hedase',
       'gerd nile', 'gerd ethiopia', 'gerd egypt', 'gerd filling',
       'gerd water', 'gerd dam', 'gerd reservoir', 'gerd release',
       'gerd negotiat', 'gerd accord', 'gerd etiop', 'gerd egitt',
       'gerd nilo', 'gerd sudan'],
      // Gruppo 2 — paesi coinvolti (obbligatorio, disambigua "gerd")
      ['egypt', 'egitto', 'egizian', 'ethiopia', 'etiopia', 'etiop',
       'sudan', 'khartoum', 'cairo', 'il cairo', 'addis abeba', 'nile', 'nilo'],
      // Gruppo 3 — tema idrico/diplomatico
      ['water', 'acqua', 'idric', 'flow', 'flusso',
       'release', 'rilascio', 'rilasci', 'filling', 'riempimento',
       'level', 'livello', 'dam', 'diga', 'reservoir', 'invaso',
       'negotiation', 'negoziat', 'agreement', 'accordo', 'dispute',
       'disputa', 'tension', 'tensione', 'transparen', 'trasparenz',
       'monitor', 'overflow', 'drought', 'siccità',
       'irrigation', 'irrigazione', 'downstream', 'upstream'],
    ],
  },
};

/* ------------------------------------------------------------------
   Utilità
   ------------------------------------------------------------------ */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------
   GDELT: fetch + parse JSON
   ------------------------------------------------------------------ */
async function fetchGdelt(topicKey, topic) {
  const url = gdeltUrl(topic.gdeltQuery);
  console.log(`[GDELT:${topicKey}] query: ${topic.gdeltQuery}`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'egyeth-rss/1.0' },
      });

      if (!res.ok) {
        console.warn(`[GDELT:${topicKey}] HTTP ${res.status} (tentativo ${attempt})`);
        if (attempt < MAX_RETRIES) { await delay(2 ** attempt * 1000); continue; }
        return [];
      }

      // GDELT a volte risponde 200 ma con un messaggio di errore in testo
      // (es. query non valida) invece che JSON. Leggiamo come testo e
      // proviamo a parsare in modo difensivo.
      const raw = await res.text();
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        const snippet = raw.slice(0, 120).replace(/\s+/g, ' ').trim();
        console.warn(`[GDELT:${topicKey}] risposta non-JSON: "${snippet}" (tentativo ${attempt})`);
        if (attempt < MAX_RETRIES) { await delay(2 ** attempt * 1000); continue; }
        return [];
      }

      const articles = Array.isArray(json?.articles) ? json.articles : [];

      const items = articles.map(a => ({
        title:   (a.title || '').trim(),
        link:    normalizeUrl(a.url),
        source:  (a.domain || a.sourcecountry || 'GDELT').trim(),
        pubDate: parseGdeltDate(a.seendate),
        lang:    gdeltLangCode(a.language),
        description: '',
      })).filter(i => i.title && i.link);

      console.log(`[GDELT:${topicKey}] OK — ${items.length} articoli`);
      return items;

    } catch (err) {
      console.warn(`[GDELT:${topicKey}] errore: ${err.message} (tentativo ${attempt})`);
      if (attempt < MAX_RETRIES) await delay(2 ** attempt * 1000);
    }
  }
  return [];
}

// Normalizza/valida l'URL di un articolo: deve essere http(s) assoluto.
function normalizeUrl(value) {
  const url = (value || '').trim();
  if (!/^https?:\/\//i.test(url)) return '';
  return url;
}

// GDELT seendate può essere "20240615T120000Z" oppure "20240615120000".
// Restituisce ISO 8601 o '' se non parsabile.
function parseGdeltDate(value) {
  const s = (value || '').trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return '';
  const [, y, mo, d, h, mi, se] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}Z`;
  const ts = new Date(iso).getTime();
  return Number.isNaN(ts) ? '' : iso;
}

/* ------------------------------------------------------------------
   RSS: parsing XML (RSS 2.0 / RDF 1.0 / Atom)
   ------------------------------------------------------------------ */
function decodeEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g,            (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g,  '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractTag(block, tagNames) {
  for (const tag of tagNames) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m  = block.match(re);
    if (m && m[1].trim()) return decodeEntities(m[1]);
  }
  return '';
}

function extractLink(block) {
  const plain = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (plain && plain[1].trim()) return decodeEntities(plain[1]);
  for (const [, attrs] of block.matchAll(/<link\b([^>]*?)\/?>(?:<\/link>)?/gi)) {
    const href = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!href) continue;
    const rel  = attrs.match(/rel\s*=\s*["']([^"']+)["']/i);
    if (!rel || rel[1].toLowerCase() === 'alternate') return decodeEntities(href[1]);
  }
  return '';
}

function parseFeed(xml, sourceName) {
  const blocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ];
  return blocks.map(([, block]) => ({
    title:       extractTag(block, ['title']),
    link:        extractLink(block),
    description: extractTag(block, ['description', 'summary', 'content', 'content:encoded']).slice(0, 600),
    pubDate:     extractTag(block, ['pubDate', 'dc:date', 'published', 'updated', 'date']),
    guid:        extractTag(block, ['guid', 'id']),
    source:      sourceName,
    lang:        RSS_FEED_LANG[sourceName] || 'en',
  })).filter(i => i.title);
}

async function fetchRssFeed(feed, index) {
  if (index > 0) await delay(index * STAGGER_MS);
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(feed.url, { headers: BROWSER_HEADERS });
      if (res.status === 429 || res.status === 403) {
        if (attempt === MAX_RETRIES) return null;
        await delay(2 ** attempt * 1500);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml   = await res.text();
      const items = parseFeed(xml, feed.source);
      console.log(`[RSS:${feed.source}] OK — ${items.length} elementi`);
      return items;
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.warn(`[RSS:${feed.source}] FALLITO: ${err.message}`);
        return null;
      }
      await delay(2 ** attempt * 1000);
    }
  }
  return null;
}

/* ------------------------------------------------------------------
   Filtro keyword (usato solo sugli item RSS, non su GDELT che filtra
   già via query)
   ------------------------------------------------------------------ */
function matchesTopic(item, topic) {
  const text    = `${item.title} ${item.description || ''}`.toLowerCase();
  const matched = topic.keywords.filter(group =>
    group.some(kw => text.includes(kw.toLowerCase()))
  ).length;
  return matched >= (topic.minMatches || topic.keywords.length);
}

/* ------------------------------------------------------------------
   Deduplication e timestamp
   ------------------------------------------------------------------ */
function getTimestamp(item) {
  const t = item.pubDate ? new Date(item.pubDate).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = (item.link || item.guid || item.title || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ------------------------------------------------------------------
   Traduzione titoli via API Claude
   Traduce in italiano tutti i titoli non già in italiano, in un
   unico batch per minimizzare le chiamate API.
   Richiede la variabile d'ambiente ANTHROPIC_API_KEY.
   Se non disponibile o se la chiamata fallisce, usa il titolo originale.
   ------------------------------------------------------------------ */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

async function translateTitles(items) {
  if (!ANTHROPIC_API_KEY) {
    console.warn('[Traduzione] ANTHROPIC_API_KEY non impostata — uso titoli originali.');
    return items.map(i => ({ ...i, titleIt: i.title }));
  }

  // Separa gli item che hanno già il titolo in italiano
  const toTranslate = items.filter(i => i.lang !== 'it');
  const alreadyIt   = items.filter(i => i.lang === 'it');

  if (!toTranslate.length) {
    return items.map(i => ({ ...i, titleIt: i.title }));
  }

  // Costruisce il prompt: un titolo per riga numerata
  const numbered = toTranslate.map((item, idx) =>
    `${idx + 1}. [${item.lang}] ${item.title}`
  ).join('\n');

  const prompt =
    'Traduci in italiano i seguenti titoli di articoli giornalistici. ' +
    'Mantieni nomi propri, sigle (GERD, IMF, ecc.) e termini tecnici invariati. ' +
    'Rispondi SOLO con le traduzioni numerate nello stesso ordine, ' +
    'una per riga, senza spiegazioni né testo aggiuntivo.\n\n' + numbered;

  try {
    const res = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method:  'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 2048,
          messages:   [{ role: 'user', content: prompt }],
        }),
      },
      30000   // timeout più lungo per la traduzione
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 120)}`);
    }

    const json  = await res.json();
    const text  = (json?.content?.[0]?.text || '').trim();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    // Estrae il testo della traduzione rimuovendo il numero iniziale (es. "1. ")
    const translations = lines.map(l => l.replace(/^\d+\.\s*/, '').trim());

    if (translations.length !== toTranslate.length) {
      console.warn(
        `[Traduzione] Numero di righe ricevute (${translations.length}) ` +
        `diverso dall'atteso (${toTranslate.length}) — uso titoli originali.`
      );
      return items.map(i => ({ ...i, titleIt: i.title }));
    }

    const translated = toTranslate.map((item, idx) => ({
      ...item,
      titleIt: translations[idx] || item.title,
    }));

    console.log(`[Traduzione] OK — ${translated.length} titoli tradotti.`);

    // Ricompone preservando l'ordine originale tramite Map per link
    const translatedMap = new Map(translated.map(i => [i.link || i.title, i]));
    return items.map(i =>
      translatedMap.has(i.link || i.title)
        ? translatedMap.get(i.link || i.title)
        : { ...i, titleIt: i.title }
    );

  } catch (err) {
    console.warn(`[Traduzione] Errore: ${err.message} — uso titoli originali.`);
    return items.map(i => ({ ...i, titleIt: i.title }));
  }
}


async function main() {
  // 1. Fetch GDELT per ogni tematica — sequenziale con stagger per
  //    rispettare il rate limit di GDELT (~1 richiesta ogni 1-2s).
  const gdeltResults = {};
  const topicEntries = Object.entries(TOPICS);
  for (let i = 0; i < topicEntries.length; i++) {
    const [key, topic] = topicEntries[i];
    if (i > 0) await delay(1500);
    gdeltResults[key] = await fetchGdelt(key, topic);
  }

  // 2. Fetch RSS di fallback (in parallelo)
  const rssRaw = await Promise.allSettled(
    RSS_FEEDS.map((feed, idx) => fetchRssFeed(feed, idx))
  );

  const rssItems    = [];
  let   rssOk       = 0;
  rssRaw.forEach(res => {
    if (res.status === 'fulfilled' && Array.isArray(res.value)) {
      rssOk++;
      rssItems.push(...res.value);
    }
  });
  console.log(`RSS: ${rssOk}/${RSS_FEEDS.length} feed riusciti, ${rssItems.length} articoli totali`);

  // 3. Combina e filtra per tematica
  const minTimestamp = Date.now() - MAX_ITEM_AGE_DAYS * 86400000;
  const topics       = {};
  let   totalItems   = 0;

  for (const [key, topic] of topicEntries) {
    // GDELT già filtrato per query; RSS filtrato per keyword
    const rssFiltered = rssItems.filter(item => matchesTopic(item, topic));

    const combined = dedupe([...gdeltResults[key], ...rssFiltered])
      .filter(item => {
        const ts = getTimestamp(item);
        return ts === 0 || ts >= minTimestamp;
      })
      .sort((a, b) => getTimestamp(b) - getTimestamp(a))
      .slice(0, RSS_MAX_ITEMS)
      .map(({ guid, ...rest }) => rest);  // rimuove guid dall'output

    topics[key] = { title: topic.title, items: combined };
    totalItems += combined.length;
    console.log(`Tematica "${key}": ${combined.length} notizie (${gdeltResults[key].length} GDELT + ${rssFiltered.length} RSS)`);
  }

  // 4. Traduzione titoli in italiano (unico batch su tutti gli item)
  //    Raccoglie tutti gli item, traduce, poi ridistribuisce.
  const allCombined = Object.values(topics).flatMap(t => t.items);
  totalItems = allCombined.length;
  console.log(`[Traduzione] ${allCombined.filter(i => i.lang !== 'it').length} titoli da tradurre su ${totalItems} totali.`);

  const allTranslated = await translateTitles(allCombined);

  // Ridistribuisce i titoli tradotti nelle tematiche via Map link→titleIt
  const translMap = new Map(allTranslated.map(i => [i.link || i.title, i.titleIt || i.title]));
  for (const topicData of Object.values(topics)) {
    topicData.items = topicData.items.map(item => ({
      ...item,
      titleIt: translMap.get(item.link || item.title) || item.title,
    }));
  }

  // 5. Scrivi output
  const payload = {
    generatedAt:    new Date().toISOString(),
    feedsChecked:   rssOk,
    feedsAttempted: RSS_FEEDS.length,
    topics,
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`Scritto ${OUTPUT_FILE} (${totalItems} notizie totali)`);

  // Esci con errore solo se GDELT ha fallito per tutte le tematiche
  // E i feed RSS sono tutti falliti — situazione di rete totalmente compromessa
  const gdeltTotal = Object.values(gdeltResults).reduce((s, a) => s + a.length, 0);
  if (gdeltTotal === 0 && rssOk === 0) {
    console.error('Nessuna fonte raggiungibile: esco con errore.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exit(1);
});
