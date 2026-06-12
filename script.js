const header = document.querySelector('[data-header]');
const nav = document.querySelector('[data-nav]');
const navToggle = document.querySelector('[data-nav-toggle]');
const backToTop = document.querySelector('[data-back-to-top]');

function onScroll() {
  const y = window.scrollY || document.documentElement.scrollTop;
  header?.classList.toggle('is-scrolled', y > 8);
  backToTop?.classList.toggle('visible', y > 700);
}

window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

navToggle?.addEventListener('click', () => {
  const open = nav?.classList.toggle('open');
  navToggle.setAttribute('aria-expanded', String(Boolean(open)));
});

nav?.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    nav.classList.remove('open');
    navToggle?.setAttribute('aria-expanded', 'false');
  });
});

backToTop?.addEventListener('click', () =>
  window.scrollTo({ top: 0, behavior: 'smooth' })
);

const sections = [...document.querySelectorAll('main section[id]')];
const navLinks = [...document.querySelectorAll('.site-nav a')];

const activeObserver = new IntersectionObserver(
  entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.getAttribute('id');
        navLinks.forEach(link =>
          link.classList.toggle('active', link.getAttribute('href') === `#${id}`)
        );
      }
    });
  },
  { rootMargin: '-35% 0px -55% 0px', threshold: 0 }
);

sections.forEach(section => activeObserver.observe(section));

const revealEls = document.querySelectorAll('.reveal');
const revealObserver = new IntersectionObserver(
  entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.12 }
);

revealEls.forEach(el => revealObserver.observe(el));

const tooltipTargets = document.querySelectorAll(
  '.cross-impact-table .has-comment[data-tooltip]'
);

tooltipTargets.forEach(el => el.removeAttribute('title'));

let matrixTooltip;

function ensureMatrixTooltip() {
  if (!matrixTooltip) {
    matrixTooltip = document.createElement('div');
    matrixTooltip.className = 'matrix-tooltip';
    document.body.appendChild(matrixTooltip);
  }
  return matrixTooltip;
}

function setTooltipTone(sourceCell) {
  if (!matrixTooltip) return;
  matrixTooltip.classList.remove('tip-positive', 'tip-negative', 'tip-neutral');

  if (sourceCell.classList.contains('positive')) {
    matrixTooltip.classList.add('tip-positive');
  } else if (sourceCell.classList.contains('negative')) {
    matrixTooltip.classList.add('tip-negative');
  } else {
    matrixTooltip.classList.add('tip-neutral');
  }
}

function positionMatrixTooltip(event) {
  if (!matrixTooltip) return;

  const margin = 14;
  const rect = matrixTooltip.getBoundingClientRect();
  let left = event.clientX + margin;
  let top = event.clientY + margin;

  if (left + rect.width > window.innerWidth - margin) {
    left = event.clientX - rect.width - margin;
  }

  if (top + rect.height > window.innerHeight - margin) {
    top = event.clientY - rect.height - margin;
  }

  matrixTooltip.style.left = `${Math.max(margin, left)}px`;
  matrixTooltip.style.top = `${Math.max(margin, top)}px`;
}

tooltipTargets.forEach(el => {
  el.addEventListener('mouseenter', event => {
    const tip = ensureMatrixTooltip();
    tip.textContent = el.getAttribute('data-tooltip') || '';
    setTooltipTone(el);
    tip.classList.add('visible');
    positionMatrixTooltip(event);
  });

  el.addEventListener('mousemove', positionMatrixTooltip);
  el.addEventListener('mouseleave', () => matrixTooltip?.classList.remove('visible'));
});

/* =========================
   RSS monitoring (GitHub Pages)
   =========================
   Le notizie non vengono più scaricate dal browser tramite proxy o
   funzioni serverless: una GitHub Action le raccoglie periodicamente
   lato server e committa "data/news.json" già filtrato per tematica.
   Il frontend legge solo quel file statico (stessa origine):
   zero CORS, zero 403/429 per i visitatori. */

const monitoringFeedButtons = [
  ...document.querySelectorAll('.monitoring-feed-btn[data-feed-key]')
];
const rssMonitoringTitle = document.getElementById('rssMonitoringTitle');
const rssMonitoringStatus = document.getElementById('rssMonitoringStatus');
const rssNewsTrack = document.getElementById('rssNewsTrack');

const RSS_DATA_URL = 'data/news.json';
const RSS_MAX_ITEMS = 20;       // massimo risultati per tematica
const RSS_VISIBLE_ROWS = 5;     // notizie visibili contemporaneamente
const RSS_SECONDS_PER_ITEM = 3; // velocità dello scorrimento verticale
const RSS_REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const MONITORING_TOPICS = {
  'egypt-somalia': 'Accordi Egitto-Somalia',
  somaliland: 'Dossier Somaliland',
  'ethiopia-sea-access': 'Accesso etiope al mare',
  'egypt-economy': 'Fragilità economica egiziana',
  'gerd-opacity': 'Opacità sui rilasci GERD'
};

let rssDataCache = null;
let rssDataPromise = null;
let activeTopic = null;

function getTopicFromButton(button) {
  return button?.dataset?.feedKey || 'egypt-somalia';
}

function getTopicTitle(topic, button) {
  return MONITORING_TOPICS[topic] || button?.textContent?.trim() || 'Notizie monitorate';
}

function setRssLoadingState(title) {
  if (rssMonitoringTitle) rssMonitoringTitle.textContent = title || 'Notizie monitorate';
  if (rssMonitoringStatus) rssMonitoringStatus.textContent = 'Caricamento...';

  if (rssNewsTrack) {
    rssNewsTrack.classList.remove('is-ready');
    rssNewsTrack.innerHTML =
      '<span class="rss-placeholder">Caricamento delle notizie...</span>';
  }
}

function sanitizeRssText(value) {
  const temp = document.createElement('span');
  temp.textContent = value || '';
  return temp.innerHTML;
}

// Previene attacchi XSS e supporta sia link assoluti che percorsi relativi
function sanitizeUrl(value) {
  const temp = document.createElement('span');
  temp.textContent = value || '';
  let cleanUrl = temp.innerHTML.replace(/"/g, '&quot;').trim();

  const isValidScheme = cleanUrl.startsWith('http://') ||
                        cleanUrl.startsWith('https://') ||
                        cleanUrl.startsWith('/');

  if (cleanUrl !== '#' && !isValidScheme) {
    return '#';
  }
  return cleanUrl;
}

function formatRssDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 'Data n.d.';

  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();

  return `${day}/${month}/${year}`;
}

function getItemTimestamp(item) {
  const raw = item?.pubDate || item?.date || item?.published || item?.published_at;
  const timestamp = raw ? new Date(raw).getTime() : 0;
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function dedupeRssItems(items) {
  const seen = new Set();
  const unique = [];

  items.forEach(item => {
    const key = (item?.link || item?.guid || item?.title || '').trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    unique.push(item);
  });

  return unique;
}

function formatUpdatedAt(isoString) {
  const date = isoString ? new Date(isoString) : null;
  if (!date || Number.isNaN(date.getTime())) return '';

  return date.toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function renderRssItems(items, options = {}) {
  if (!rssNewsTrack) return false;

  const visibleItems = dedupeRssItems(items || [])
    .sort((a, b) => getItemTimestamp(b) - getItemTimestamp(a))
    .slice(0, RSS_MAX_ITEMS);

  if (!visibleItems.length) {
    rssNewsTrack.innerHTML =
      '<span class="rss-placeholder">Nessuna notizia disponibile per questo argomento.</span>';
    rssNewsTrack.classList.remove('is-ready');
    if (rssMonitoringStatus) rssMonitoringStatus.textContent = '0 notizie coerenti';
    return false;
  }

  const links = visibleItems
    .map(item => {
      const date = sanitizeRssText(
        formatRssDate(item.pubDate || item.date || item.published || item.published_at)
      );
      const cleanTitle = sanitizeRssText(item.title || 'Notizia senza titolo');
      const cleanSource = sanitizeRssText(item.source || 'Fonte n.d.');
      const link = sanitizeUrl(item.link || '#');

      return `<a href="${link}" target="_blank" rel="noopener noreferrer">${date} - ${cleanTitle} - ${cleanSource}</a>`;
    })
    .join('');

  // Scorrimento VERTICALE: se le notizie superano le righe visibili,
  // duplichiamo la lista una volta (loop senza scatti con translateY -50%)
  // e calcoliamo la durata in base al numero di notizie.
  if (visibleItems.length > RSS_VISIBLE_ROWS && !RSS_REDUCED_MOTION) {
    rssNewsTrack.innerHTML = links + links;
    rssNewsTrack.style.setProperty(
      '--rss-scroll-duration',
      `${visibleItems.length * RSS_SECONDS_PER_ITEM}s`
    );
    rssNewsTrack.classList.add('is-ready');
  } else {
    // 5 o meno notizie (o utente con riduzione animazioni): lista statica
    rssNewsTrack.innerHTML = links;
    rssNewsTrack.classList.remove('is-ready');
  }

  if (rssMonitoringStatus) {
    const feedsSucceeded = Number(options.feedsChecked) || 0;
    const feedsAttempted = Number(options.feedsAttempted) || 0;
    const updatedAt = formatUpdatedAt(options.generatedAt);

    let feedText = '';
    if (feedsAttempted > 0 && feedsSucceeded > 0) {
      feedText = ` da ${feedsSucceeded}/${feedsAttempted} feed`;
    }

    const updatedText = updatedAt ? ` · agg. ${updatedAt}` : '';
    rssMonitoringStatus.textContent =
      `${visibleItems.length} notizie${feedText}${updatedText}`;
  }

  return true;
}

async function fetchRssData() {
  if (rssDataCache) return rssDataCache;

  // Una sola richiesta condivisa anche con click multipli ravvicinati
  if (!rssDataPromise) {
    rssDataPromise = fetch(`${RSS_DATA_URL}?t=${Date.now()}`, {
      headers: { Accept: 'application/json' }
    })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(data => {
        rssDataCache = data;
        return data;
      })
      .catch(error => {
        rssDataPromise = null; // consenti un nuovo tentativo al prossimo click
        throw error;
      });
  }

  return rssDataPromise;
}

async function loadMonitoringFeed(button) {
  const topic = getTopicFromButton(button);
  const title = getTopicTitle(topic, button);

  activeTopic = topic;

  monitoringFeedButtons.forEach(btn => {
    const isActive = btn === button;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });

  setRssLoadingState(title);

  try {
    const data = await fetchRssData();

    // L'utente potrebbe aver cambiato tab durante il fetch iniziale
    if (activeTopic !== topic) return;

    const topicData = data?.topics?.[topic];

    if (rssMonitoringTitle) {
      rssMonitoringTitle.textContent = topicData?.title || title;
    }

    renderRssItems(topicData?.items || [], {
      feedsChecked: data?.feedsChecked,
      feedsAttempted: data?.feedsAttempted,
      generatedAt: data?.generatedAt
    });
  } catch (error) {
    if (activeTopic !== topic) return;

    console.error('Errore nel caricamento delle notizie monitorate:', error);

    if (rssNewsTrack) {
      rssNewsTrack.innerHTML =
        '<span class="rss-placeholder">Notizie temporaneamente non disponibili.</span>';
      rssNewsTrack.classList.remove('is-ready');
    }

    if (rssMonitoringStatus) rssMonitoringStatus.textContent = 'Errore feed';
  }
}

monitoringFeedButtons.forEach(button => {
  button.addEventListener('click', () => loadMonitoringFeed(button));
});

if (monitoringFeedButtons.length) {
  loadMonitoringFeed(monitoringFeedButtons[0]);
}
