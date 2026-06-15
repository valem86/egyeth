#!/usr/bin/env node
/**
 * fetch-rss.js
 * Eseguito da GitHub Actions (Node >= 20, zero dipendenze).
 *
 * Strategia anti 403/429:
 *  - fetch DIRETTO dei feed (nessun proxy pubblico tipo rss2json/rssjson)
 *  - header da browser reale (User-Agent, Accept, Accept-Language)
 *  - richieste scaglionate (delay progressivo tra i feed)
 *  - retry con backoff esponenziale + rispetto di Retry-After su 429
 *  - timeout per singolo feed
 *
 * Output: data/news.json con le notizie già filtrate per ogni tematica.
 * Il frontend legge solo il JSON statico: i visitatori non fanno mai
 * richieste verso i feed, quindi nessun blocco lato client.
 */

const fs = require('node:fs');
const path = require('node:path');

const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'news.json');

const RSS_MAX_ITEMS = 20;
const FETCH_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const STAGGER_MS = 700; // delay progressivo tra i feed
const MAX_ITEM_AGE_DAYS = 45; // scarta notizie troppo vecchie

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'application/rss+xml, application/rdf+xml, application/atom+xml, ' +
    'application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9,it;q=0.8',
  'Cache-Control': 'no-cache'
};

const RSS_FEEDS = [
  { source: 'BBC Africa', url: 'https://feeds.bbci.co.uk/news/world/africa/rss.xml' },
  { source: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { source: 'Agenzia Nova', url: 'https://www.agenzianova.com/rss/tuttiititolidinova' },
  { source: 'ANSA English', url: 'https://www.ansa.it/english/news/english_nr_rss.xml' },
  { source: 'ANSAmed (ar)', url: 'https://www.ansa.it/ansamednew/ar/notizie/ansamedar_nr_rss.xml' },
  { source: 'Horn Observer', url: 'https://hornobserver.com/assets/rss.php?cid=1' },
  { source: 'Crisis Group', url: 'https://www.crisisgroup.org/rss/1' },
  { source: 'The New Humanitarian', url: 'https://www.thenewhumanitarian.org/rss/all.xml' },
  { source: 'Africanews', url: 'https://www.africanews.com/feed/rss' },
  { source: 'AllAfrica', url: 'https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf' }
];

// Parole chiave invariate rispetto alla versione Netlify.
// Ogni gruppo deve avere almeno una corrispondenza nel testo.
const TOPICS = {
  'egypt-somalia': {
    title: 'Accordi Egitto-Somalia',
    minMatches: 2,
    keywords: [
      ['Egypt', 'Egitto'],
      ['Somalia'],
      ['agreement', 'accordo', 'MoU'],
      ['military', 'security']
    ]
  },
  somaliland: {
    title: 'Dossier Somaliland',
    minMatches: 2,
    keywords: [
      ['Ethiopia', 'Etiopia'],
      ['Somaliland'],
      ['agreement', 'MoU'],
      ['port', 'Berbera']
    ]
  },
  'ethiopia-sea-access': {
    title: 'Accesso etiope al mare',
    minMatches: 2,
    keywords: [
      ['Ethiopia', 'Etiopia'],
      ['sea access', 'port'],
      ['Red Sea', 'Somalia', 'Berbera'],
      ['agreement', 'deal']
    ]
  },
  'egypt-economy': {
    title: 'Fragilità economica egiziana',
    minMatches: 2,
    keywords: [
      ['Egypt', 'Egitto'],
      ['IMF', 'FMI'],
      ['inflation', 'debt'],
      ['Suez Canal', 'economy']
    ]
  },
  'gerd-opacity': {
    title: 'Opacità sui rilasci GERD',
    minMatches: 2,
    keywords: [
      ['GERD', 'dam'],
      ['Egypt', 'Ethiopia'],
      ['water', 'data'],
      ['negotiation', 'agreement']
    ]
  }
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/* =========================
   Parsing XML (RSS 2.0 / RDF 1.0 / Atom) senza dipendenze
   ========================= */

function decodeEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/<[^>]*>/g, ' ') // rimuove eventuale HTML residuo nelle descrizioni
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block, tagNames) {
  for (const tag of tagNames) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = block.match(re);
    if (match && match[1].trim()) return decodeEntities(match[1]);
  }
  return '';
}

function extractLink(block) {
  // RSS / RDF: <link>https://...</link>
  const plain = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (plain && plain[1].trim()) return decodeEntities(plain[1]);

  // Atom: <link rel="alternate" href="..."/> oppure <link href="..."/>
  const linkTags = [...block.matchAll(/<link\b([^>]*?)\/?>(?:<\/link>)?/gi)];
  let fallback = '';
  for (const [, attrs] of linkTags) {
    const href = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!href) continue;
    const rel = attrs.match(/rel\s*=\s*["']([^"']+)["']/i);
    if (!rel || rel[1].toLowerCase() === 'alternate') return decodeEntities(href[1]);
    if (!fallback) fallback = decodeEntities(href[1]);
  }
  return fallback;
}

function parseFeed(xml, sourceName) {
  // RSS 2.0 e RDF usano <item>, Atom usa <entry>
  const blocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)
  ];

  return blocks.map(([, block]) => ({
    title: extractTag(block, ['title']),
    link: extractLink(block),
    description: extractTag(block, ['description', 'summary', 'content', 'content:encoded']).slice(0, 600),
    pubDate: extractTag(block, ['pubDate', 'dc:date', 'published', 'updated', 'date']),
    guid: extractTag(block, ['guid', 'id']),
    source: sourceName
  })).filter(item => item.title);
}

/* =========================
   Fetch con retry + backoff
   ========================= */

async function fetchOnce(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: BROWSER_HEADERS,
      redirect: 'follow'
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFeed(feed, index) {
  // Richieste scaglionate per non sembrare un burst automatizzato
  if (index > 0) await delay(index * STAGGER_MS);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetchOnce(feed.url);

      if (response.status === 429 || response.status === 403) {
        const retryAfter = Number(response.headers.get('retry-after')) || 0;
        const backoff = Math.max(retryAfter * 1000, 2 ** attempt * 1500);
        console.warn(`[${feed.source}] HTTP ${response.status}, retry tra ${backoff}ms (tentativo ${attempt}/${MAX_RETRIES})`);
        if (attempt === MAX_RETRIES) throw new Error(`HTTP ${response.status}`);
        await delay(backoff);
        continue;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const xml = await response.text();
      const items = parseFeed(xml, feed.source);
      console.log(`[${feed.source}] OK, ${items.length} elementi`);
      return items;
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        console.warn(`[${feed.source}] FALLITO: ${error.message}`);
        return null; // null = feed fallito (distinto da [] = feed vuoto)
      }
      await delay(2 ** attempt * 1000);
    }
  }
  return null;
}

/* =========================
   Filtri e output
   ========================= */

function matchesTopic(item, topic) {
  const text = `${item.title} ${item.description || ''}`.toLowerCase();
  const matched = topic.keywords.filter(group =>
    group.some(keyword => text.includes(keyword.toLowerCase()))
  ).length;
  return matched >= (topic.minMatches || topic.keywords.length);
}

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

async function main() {
  const results = await Promise.allSettled(
    RSS_FEEDS.map((feed, index) => fetchFeed(feed, index))
  );

  const allItems = [];
  let feedsChecked = 0;

  results.forEach(res => {
    if (res.status === 'fulfilled' && Array.isArray(res.value)) {
      feedsChecked += 1;
      allItems.push(...res.value);
    }
  });

  const minTimestamp = Date.now() - MAX_ITEM_AGE_DAYS * 86400000;

  const topics = {};
  for (const [key, topic] of Object.entries(TOPICS)) {
    const items = dedupe(
      allItems.filter(item => matchesTopic(item, topic))
    )
      .filter(item => {
        const ts = getTimestamp(item);
        return ts === 0 || ts >= minTimestamp;
      })
      .sort((a, b) => getTimestamp(b) - getTimestamp(a))
      .slice(0, RSS_MAX_ITEMS)
      .map(({ guid, ...rest }) => rest);

    topics[key] = { title: topic.title, items };
    console.log(`Tematica "${key}": ${items.length} notizie`);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    feedsChecked,
    feedsAttempted: RSS_FEEDS.length,
    topics
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`Scritto ${OUTPUT_FILE} (${feedsChecked}/${RSS_FEEDS.length} feed riusciti)`);

  // Non bloccare il commit se almeno metà dei feed ha risposto
  if (feedsChecked === 0) {
    console.error('Nessun feed raggiungibile: esco con errore senza sovrascrivere i dati.');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Errore fatale:', error);
  process.exit(1);
});
