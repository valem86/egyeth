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
   RSS monitoring
   ========================= */

const monitoringFeedButtons = [
  ...document.querySelectorAll('.monitoring-feed-btn[data-feed-key]')
];
const rssMonitoringTitle = document.getElementById('rssMonitoringTitle');
const rssMonitoringStatus = document.getElementById('rssMonitoringStatus');
const rssNewsTrack = document.getElementById('rssNewsTrack');

const RSS_FUNCTION_ENDPOINT = '/.netlify/functions/rss-monitor';
const RSS_MAX_ITEMS = 10;

// FIX RACE CONDITION: Variabile di blocco per richieste asincrone sovrapposte
let activeFetchTopic = null;

const MONITORING_TOPICS = {
  'egypt-somalia': 'Accordi Egitto-Somalia',
  somaliland: 'Dossier Somaliland',
  'ethiopia-sea-access': 'Accesso etiope al mare',
  'egypt-economy': 'Fragilità economica egiziana',
  'gerd-opacity': 'Opacità sui rilasci GERD'
};

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

function sanitizeRssAttribute(value) {
  const temp = document.createElement('span');
  temp.textContent = value || '';
  return temp.innerHTML.replace(/"/g, '&quot;');
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

function renderRssItems(items, options = {}) {
  if (!rssNewsTrack) return false;

  const visibleItems = dedupeRssItems(items || [])
    .sort((a, b) => getItemTimestamp(b) - getItemTimestamp(a))
    .slice(0, RSS_MAX_ITEMS);

  if (!visibleItems.length) {
    rssNewsTrack.innerHTML =
      '<span class="rss-placeholder">Nessuna notizia disponibile per questo argomento.</span>';
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

  // FIX: Moltiplica i link per 4 per assicurare che il Marquee CSS (translateX) non si "spezzi"
  // neppure sugli schermi giganti se ci dovesse essere una sola notizia restituita.
  rssNewsTrack.innerHTML = Array(4).fill(links).join('');
  rssNewsTrack.classList.add('is-ready');

  if (rssMonitoringStatus) {
    const feedsSucceeded = Number(options.feedsChecked) || 0;
    const feedsAttempted = Number(options.feedsAttempted) || 0;
    let feedText = '';

    if (feedsAttempted > 0 && feedsSucceeded > 0) {
      feedText = ` da ${feedsSucceeded}/${feedsAttempted} feed`;
    } else if (feedsSucceeded > 1) {
      feedText = ` da ${feedsSucceeded} feed`;
    }

    rssMonitoringStatus.textContent = `${visibleItems.length} notizie${feedText}`;
  }

  return true;
}

async function fetchTopicItems(topic) {
  const response = await fetch(
    `${RSS_FUNCTION_ENDPOINT}?topic=${encodeURIComponent(topic)}`,
    {
      headers: { Accept: 'application/json' }
    }
  );

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json();
  if (data.error) throw new Error(data.error);

  return data;
}

async function loadMonitoringFeed(button) {
  const topic = getTopicFromButton(button);
  const title = getTopicTitle(topic, button);
  
  // Impostiamo la tematica corrente attiva per evitare conflitti (Race Condition)
  activeFetchTopic = topic;

  monitoringFeedButtons.forEach(btn => {
    const isActive = btn === button;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });

  setRssLoadingState(title);

  try {
    const data = await fetchTopicItems(topic);
    
    // Controlliamo che l'utente non abbia cambiato tab nel frattempo
    if (activeFetchTopic !== topic) return;

    if (rssMonitoringTitle) {
      rssMonitoringTitle.textContent = data.title || title;
    }

    renderRssItems(data.items || [], {
      feedsChecked: data.feedsChecked,
      feedsAttempted: data.feedsAttempted
    });
  } catch (error) {
    // Ignoriamo gli errori se appartengono a una vecchia request
    if (activeFetchTopic !== topic) return;
    
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