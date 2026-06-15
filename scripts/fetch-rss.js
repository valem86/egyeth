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

/* ------------------------------------------------------------------
   GDELT DOC 2.0 API
   Docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
   Endpoint: https://api.gdeltproject.org/api/v2/doc/doc
   mode=ArtList → lista articoli (JSON, max 250)
   maxrecords=50
   timespan=45d
   format=json
   ------------------------------------------------------------------ */
const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';

function gdeltUrl(query) {
  const params = new URLSearchParams({
    query:      query,
    mode:       'ArtList',
    maxrecords: '50',
    timespan:   `${MAX_ITEM_AGE_DAYS}d`,
    sort:       'DateDesc',
    format:     'json',
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
    gdeltQuery:  'Egypt Somalia (agreement OR military OR security OR MoU OR defense)',
    minMatches:  2,
    keywords: [
      ['Egypt', 'Egitto'],
      ['Somalia'],
      ['agreement', 'accordo', 'MoU', 'military', 'security'],
    ],
  },
  somaliland: {
    title:       'Dossier Somaliland',
    gdeltQuery:  'Somaliland (Ethiopia OR port OR Berbera OR agreement OR MoU)',
    minMatches:  2,
    keywords: [
      ['Ethiopia', 'Etiopia'],
      ['Somaliland'],
      ['agreement', 'MoU', 'port', 'Berbera'],
    ],
  },
  'ethiopia-sea-access': {
    title:       'Accesso etiope al mare',
    gdeltQuery:  'Ethiopia ("sea access" OR port OR "Red Sea" OR Berbera OR Somalia) (agreement OR deal OR corridor)',
    minMatches:  2,
    keywords: [
      ['Ethiopia', 'Etiopia'],
      ['sea access', 'port', 'Red Sea', 'Berbera'],
      ['agreement', 'deal', 'Somalia'],
    ],
  },
  'egypt-economy': {
    title:       'Fragilità economica egiziana',
    gdeltQuery:  'Egypt (econom OR IMF OR inflation OR debt OR currency OR deficit OR "Suez Canal" OR finance OR GDP)',
    minMatches:  2,
    keywords: [
      ['Egypt', 'Egitto'],
      ['econom', 'IMF', 'FMI', 'inflation', 'debt', 'currency', 'pound',
       'deficit', 'fiscal', 'GDP', 'finance', 'financial', 'budget',
       'investment', 'trade', 'Suez Canal', 'revenue', 'crisis'],
    ],
  },
  'gerd-opacity': {
    title:       'Opacità sui rilasci GERD',
    gdeltQuery:  'GERD OR "Grand Ethiopian Renaissance Dam" (Egypt OR Ethiopia OR water OR Nile OR negotiation OR agreement OR dam)',
    minMatches:  2,
    keywords: [
      ['GERD', 'dam', 'Renaissance Dam'],
      ['Egypt', 'Ethiopia'],
      ['water', 'Nile', 'data', 'negotiation', 'agreement'],
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
        headers: { Accept: 'application/json' },
      });

      if (!res.ok) {
        console.warn(`[GDELT:${topicKey}] HTTP ${res.status} (tentativo ${attempt})`);
        if (attempt < MAX_RETRIES) { await delay(2 ** attempt * 1000); continue; }
        return [];
      }

      const json = await res.json();
      const articles = json?.articles ?? [];

      const items = articles.map(a => ({
        title:   (a.title   || '').trim(),
        link:    (a.url     || '').trim(),
        source:  (a.domain  || a.sourcecountry || 'GDELT'),
        pubDate: a.seendate
          // GDELT format: "20240615T120000Z"
          ? a.seendate.replace(
              /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
              '$1-$2-$3T$4:$5:$6Z'
            )
          : '',
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
   main
   ------------------------------------------------------------------ */
async function main() {
  // 1. Fetch GDELT per ogni tematica (in parallelo, con piccolo stagger)
  const gdeltResults = {};
  const topicEntries = Object.entries(TOPICS);
  for (let i = 0; i < topicEntries.length; i++) {
    const [key, topic] = topicEntries[i];
    if (i > 0) await delay(800);
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

  // 4. Scrivi output
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
