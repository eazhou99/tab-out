/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Two collections:
     groups:   [{ id, name, createdAt, collapsed }]
     deferred: [{ id, url, title, savedAt, groupId }]   // groupId=null -> "待整理"

   Old shape (pre-groups) had `completed` / `dismissed` flags and no `groupId`.
   migrateLegacyDeferred() upgrades it on first read.
   ---------------------------------------------------------------- */

const UNSORTED_GROUP_ID = null; // "待整理" bucket has no group row

async function migrateLegacyDeferred(deferred) {
  let changed = false;
  const upgraded = [];
  for (const t of deferred) {
    if (t.dismissed) { changed = true; continue; } // drop dismissed
    if ('completed' in t || 'dismissed' in t || 'completedAt' in t || !('groupId' in t)) {
      upgraded.push({
        id:      t.id,
        url:     t.url,
        title:   t.title,
        savedAt: t.savedAt,
        groupId: t.groupId ?? UNSORTED_GROUP_ID,
      });
      changed = true;
    } else {
      upgraded.push(t);
    }
  }
  if (changed) await chrome.storage.local.set({ deferred: upgraded });
  return upgraded;
}

async function getDeferredItems() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  return migrateLegacyDeferred(deferred);
}

async function getGroups() {
  const { groups = [] } = await chrome.storage.local.get('groups');
  return groups;
}

async function createGroup(name) {
  const groups = await getGroups();
  const group = {
    id:        'g' + Date.now().toString(),
    name:      (name || '新分组').trim() || '新分组',
    createdAt: new Date().toISOString(),
    collapsed: false,
  };
  groups.push(group);
  await chrome.storage.local.set({ groups });
  return group;
}

async function renameGroup(id, name) {
  const groups = await getGroups();
  const g = groups.find(x => x.id === id);
  if (!g) return;
  g.name = (name || '').trim() || g.name;
  await chrome.storage.local.set({ groups });
}

async function deleteGroup(id) {
  const groups = await getGroups();
  const idx = groups.findIndex(x => x.id === id);
  if (idx === -1) return;
  groups.splice(idx, 1);
  // Orphaned items fall back to "待整理"
  const deferred = await getDeferredItems();
  for (const t of deferred) if (t.groupId === id) t.groupId = UNSORTED_GROUP_ID;
  await chrome.storage.local.set({ groups, deferred });
}

async function toggleGroupCollapsed(id) {
  const groups = await getGroups();
  const g = groups.find(x => x.id === id);
  if (!g) return;
  g.collapsed = !g.collapsed;
  await chrome.storage.local.set({ groups });
}

async function getUnsortedCollapsed() {
  const { unsortedCollapsed = false } = await chrome.storage.local.get('unsortedCollapsed');
  return !!unsortedCollapsed;
}

async function toggleUnsortedCollapsed() {
  const cur = await getUnsortedCollapsed();
  await chrome.storage.local.set({ unsortedCollapsed: !cur });
}

async function moveGroup(id, toIndex) {
  const groups = await getGroups();
  const fromIdx = groups.findIndex(g => g.id === id);
  if (fromIdx === -1) return;
  const [g] = groups.splice(fromIdx, 1);
  const clamped = Math.max(0, Math.min(toIndex, groups.length));
  groups.splice(clamped, 0, g);
  await chrome.storage.local.set({ groups });
}

/**
 * saveTabToGroup(tab, groupId)
 *
 * Saves a tab into the given group (or "待整理" if groupId is null).
 * Returns the created item.
 */
async function saveTabToGroup(tab, groupId = UNSORTED_GROUP_ID) {
  const deferred = await getDeferredItems();
  const item = {
    id:      Date.now().toString(),
    url:     tab.url,
    title:   tab.title,
    savedAt: new Date().toISOString(),
    groupId,
  };
  deferred.push(item);
  await chrome.storage.local.set({ deferred });
  return item;
}

async function moveItemToGroup(itemId, groupId) {
  const deferred = await getDeferredItems();
  const t = deferred.find(x => x.id === itemId);
  if (!t) return;
  t.groupId = groupId;
  await chrome.storage.local.set({ deferred });
}

async function removeSavedItem(id) {
  const deferred = await getDeferredItems();
  const idx = deferred.findIndex(x => x.id === id);
  if (idx === -1) return;
  deferred.splice(idx, 1);
  await chrome.storage.local.set({ deferred });
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  // Dopamine palette.
  const colors = [
    '#06b6d4', '#10b981', '#db6aa0', '#f59e0b',
    '#a855f7', '#3b82f6', '#fb7185', '#facc15',
    '#22d3ee', '#f472b6',
  ];

  // Shape-specific physics recipes. Real confetti behaves differently
  // by geometry — round bits fall fast (low drag), ribbons flutter
  // slowly (high drag + heavy tumble), squares sit between.
  const SHAPE_RECIPES = {
    circle: {
      drag:       1.2,   // horizontal velocity decay (1/s)
      vDrag:      0.4,   // vertical drag (lighter — they sink)
      gravity:    900,   // px/s^2
      flutterAmp: 0.15,  // how much it wobbles (0 = none, 1 = flips edge-on)
      spinRange:  420,   // deg/s
    },
    square: {
      drag:       1.8,
      vDrag:      0.9,
      gravity:    620,
      flutterAmp: 0.55,
      spinRange:  540,
    },
    ribbon: {
      drag:       2.4,
      vDrag:      1.6,   // heavy air resistance — falls slowly
      gravity:    420,
      flutterAmp: 1.0,   // flips fully edge-on
      spinRange:  720,
    },
  };
  const SHAPES = Object.keys(SHAPE_RECIPES);

  const particleCount = 44;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const shape   = SHAPES[Math.floor(Math.random() * SHAPES.length)];
    const recipe  = SHAPE_RECIPES[shape];
    const color   = colors[Math.floor(Math.random() * colors.length)];

    // Size per shape
    let width, height, radius;
    if (shape === 'circle') {
      const d = 5 + Math.random() * 6;
      width = height = d;
      radius = '50%';
    } else if (shape === 'ribbon') {
      width  = 4 + Math.random() * 3;       // 4–7 px
      height = 12 + Math.random() * 14;     // 12–26 px tall
      radius = '1px';
    } else {
      const d = 6 + Math.random() * 6;
      width = height = d;
      radius = '1px';
    }

    // Subtle back-face shading — a slight inset darkening so when the
    // paper flips edge-on you briefly see a plausible shadow tone.
    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${width}px;
      height: ${height}px;
      background: ${color};
      border-radius: ${radius};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
      box-shadow: inset 0 -1px 0 rgba(0,0,0,0.22), 0 1px 2px rgba(0,0,0,0.12);
      will-change: transform, opacity;
    `;
    document.body.appendChild(el);

    // --- Initial burst: cone-shaped upward-biased explosion ---
    // Picking from full 360° then biasing vy upward gives a natural
    // mortar-style spread rather than a flat disk.
    const burstAngle = Math.random() * Math.PI * 2;
    const burstSpeed = 160 + Math.random() * 260;           // 160–420 px/s
    let vx = Math.cos(burstAngle) * burstSpeed;
    let vy = Math.sin(burstAngle) * burstSpeed - (180 + Math.random() * 160); // strong upward kick

    // --- Wind drift — each particle has its own breeze. Sine wave
    //      on x over time, small amplitude, so they sway rather than
    //      travel straight. ---
    const windFreq  = 0.8 + Math.random() * 1.6;   // Hz
    const windAmp   = 18 + Math.random() * 28;     // px amplitude
    const windPhase = Math.random() * Math.PI * 2;

    // --- Tumble (3D rotation). Independent axes give realistic
    //      tumbling-paper look. Perspective is baked into transform
    //      so we don't touch body styles. ---
    const rotX0 = Math.random() * 360;
    const rotY0 = Math.random() * 360;
    const rotZ0 = Math.random() * 360;
    const rotXv = (Math.random() * 2 - 1) * recipe.spinRange * (0.6 + recipe.flutterAmp);
    const rotYv = (Math.random() * 2 - 1) * recipe.spinRange * (0.8 + recipe.flutterAmp);
    const rotZv = (Math.random() * 2 - 1) * recipe.spinRange * 0.5;

    // --- Lifetime varies by recipe — ribbons linger, circles settle. ---
    const duration = (shape === 'ribbon' ? 2800 : shape === 'square' ? 2200 : 1600)
                     + Math.random() * 700;

    const startTime = performance.now();
    let   lastT     = startTime;
    let   px        = 0;
    let   py        = 0;

    function frame(now) {
      const dt = Math.min((now - lastT) / 1000, 0.033); // clamp to avoid jumps
      lastT = now;
      const elapsed  = (now - startTime) / 1000;
      const progress = (now - startTime) / duration;

      if (progress >= 1) { el.remove(); return; }

      // Integrate with exponential drag so velocities decay naturally.
      const horizDecay = Math.exp(-recipe.drag  * dt);
      const vertDecay  = Math.exp(-recipe.vDrag * dt);
      vx *= horizDecay;
      vy  = vy * vertDecay + recipe.gravity * dt;

      px += vx * dt;
      py += vy * dt;

      // Wind: sinusoidal lateral drift, ramps in (not instant).
      const windRamp = Math.min(elapsed * 1.5, 1);
      const windDx   = Math.sin(elapsed * Math.PI * 2 * windFreq + windPhase) * windAmp * windRamp;

      // Tumble
      const rotX = rotX0 + rotXv * elapsed;
      const rotY = rotY0 + rotYv * elapsed;
      const rotZ = rotZ0 + rotZv * elapsed;

      // Fade: hold full opacity most of the life, fade softly near end.
      const opacity = progress < 0.78 ? 1 : 1 - (progress - 0.78) / 0.22;

      // Perspective baked into transform gives a real 3D flip rather
      // than a flat skew. 420 is a middle-ground focal distance.
      el.style.transform =
        `translate(calc(-50% + ${px + windDx}px), calc(-50% + ${py}px)) ` +
        `perspective(420px) ` +
        `rotateX(${rotX}deg) rotateY(${rotY}deg) rotateZ(${rotZ}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];

// Domains whose "+N more" overflow has been expanded by the user.
// Persisted in-memory across re-renders so dragging items doesn't auto-collapse.
const expandedDomains = new Set();


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" draggable="true" data-action="focus-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const isExpanded  = expandedDomains.has(stableId);
  const hasOverflow = uniqueTabs.length > 8;
  const visibleTabs = isExpanded ? uniqueTabs : uniqueTabs.slice(0, 8);
  const extraCount  = isExpanded ? 0 : (uniqueTabs.length - visibleTabs.length);

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" draggable="true" data-action="focus-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('')
    + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '')
    + (isExpanded && hasOverflow
        ? `<div class="page-chip page-chip-overflow clickable" data-action="collapse-chips" data-domain-id="${stableId}"><span class="chip-text">↑ 收起</span></div>`
        : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" draggable="true" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Renders the right-side reading column: one section per user-defined group,
 * plus a permanent "待整理" bucket at the bottom for items saved without a group.
 * Each section is a drop target; chips and saved items are draggable.
 */
async function renderDeferredColumn() {
  const column   = document.getElementById('deferredColumn');
  const wrap     = document.getElementById('groupsWrap');
  const countEl  = document.getElementById('deferredCount');
  if (!column || !wrap) return;

  try {
    const [groups, items] = await Promise.all([getGroups(), getDeferredItems()]);

    // Column is always shown so the "+ 新建分组" button stays reachable.
    column.style.display = 'block';

    const totalItems = items.length;
    countEl.textContent = totalItems > 0
      ? `${totalItems} item${totalItems !== 1 ? 's' : ''}`
      : '';

    const sections = [];
    for (const g of groups) {
      const groupItems = items.filter(t => t.groupId === g.id);
      sections.push(renderGroupSection(g, groupItems));
    }
    // Always-present "待整理" bucket
    const unsortedItems = items.filter(t => t.groupId == null);
    const unsortedCollapsed = await getUnsortedCollapsed();
    sections.push(renderUnsortedSection(unsortedItems, unsortedCollapsed));

    wrap.innerHTML = sections.join('');
  } catch (err) {
    console.warn('[tab-out] Could not render reading column:', err);
  }
}

function renderGroupSection(group, items) {
  const safeName = (group.name || '').replace(/</g, '&lt;');
  const collapsed = group.collapsed ? ' collapsed' : '';
  const itemsHtml = items.map(renderDeferredItem).join('');

  return `
    <section class="group-section${collapsed}" data-group-id="${group.id}">
      <div class="group-header">
        <span class="group-handle" draggable="true" title="拖动调整顺序">
          <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>
        </span>
        <button class="group-toggle" data-action="toggle-group" data-group-id="${group.id}" title="折叠/展开">
          <svg class="group-chevron" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
        </button>
        <span class="group-name" data-action="rename-group" data-group-id="${group.id}" title="点击重命名">${safeName}</span>
        <span class="group-count">${items.length}</span>
        <button class="group-delete" data-action="delete-group" data-group-id="${group.id}" title="删除分组">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
      <div class="group-body">${itemsHtml}</div>
    </section>`;
}

function renderUnsortedSection(items, collapsed) {
  const itemsHtml = items.map(renderDeferredItem).join('');
  const collapsedCls = collapsed ? ' collapsed' : '';
  return `
    <section class="group-section unsorted-section${collapsedCls}" data-group-id="">
      <div class="group-header">
        <button class="group-toggle" data-action="toggle-unsorted" title="折叠/展开">
          <svg class="group-chevron" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
        </button>
        <span class="group-name unsorted-label">待整理</span>
        <span class="group-count">${items.length}</span>
      </div>
      <div class="group-body">${itemsHtml}</div>
    </section>`;
}

function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);
  const safeTitle = (item.title || '').replace(/"/g, '&quot;');

  return `
    <div class="deferred-item" draggable="true" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${safeTitle}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="remove-deferred" data-deferred-id="${item.id}" title="Remove">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = getRealTabs().length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const card = actionEl.closest('.mission-card');
    const stableId = card?.dataset.domainId;
    if (stableId) expandedDomains.add(stableId);
    // Reveal hidden chips immediately + drop the "+N" button without re-render.
    // Future re-renders (drag-drop) will honor expandedDomains and stay open.
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      // Replace the "+N" button with a "↑ 收起" button in place
      actionEl.outerHTML = `<div class="page-chip page-chip-overflow clickable" data-action="collapse-chips" data-domain-id="${stableId}"><span class="chip-text">↑ 收起</span></div>`;
    }
    return;
  }

  // ---- Collapse expanded chips ----
  if (action === 'collapse-chips') {
    const stableId = actionEl.dataset.domainId;
    if (stableId) expandedDomains.delete(stableId);
    await renderStaticDashboard();
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = getRealTabs().length;

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) — goes to "待整理" ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    try {
      await saveTabToGroup({ url: tabUrl, title: tabTitle }, UNSORTED_GROUP_ID);
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved to 待整理');
    await renderDeferredColumn();
    return;
  }

  // ---- Remove a saved item (just deletes it) ----
  if (action === 'remove-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await removeSavedItem(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- New group (prompt for name) ----
  if (action === 'new-group') {
    const name = window.prompt('分组名字？');
    if (!name) return;
    await createGroup(name);
    await renderDeferredColumn();
    return;
  }

  // ---- Rename group (click name) ----
  if (action === 'rename-group') {
    const id = actionEl.dataset.groupId;
    if (!id) return;
    const current = actionEl.textContent.trim();
    const next = window.prompt('重命名分组', current);
    if (next == null) return;
    await renameGroup(id, next);
    await renderDeferredColumn();
    return;
  }

  // ---- Delete group (items fall back to 待整理) ----
  if (action === 'delete-group') {
    const id = actionEl.dataset.groupId;
    if (!id) return;
    const header = actionEl.closest('.group-header');
    const groupName = header?.querySelector('.group-name')?.textContent?.trim() || '该分组';
    const ok = await showConfirm(
      `删除分组「${groupName}」？`,
      '',
      { okText: '确认删除', destructive: true }
    );
    if (!ok) return;
    await deleteGroup(id);
    await renderDeferredColumn();
    return;
  }

  // ---- Export reading list to Obsidian ----
  if (action === 'export-obsidian') {
    await exportReadingToObsidian();
    return;
  }

  // ---- Toggle unsorted ("待整理") collapsed ----
  if (action === 'toggle-unsorted') {
    await toggleUnsortedCollapsed();
    await renderDeferredColumn();
    return;
  }

  // ---- Toggle group collapsed ----
  if (action === 'toggle-group') {
    const id = actionEl.dataset.groupId;
    if (!id) return;
    await toggleGroupCollapsed(id);
    await renderDeferredColumn();
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = getRealTabs().length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }
});



/* ----------------------------------------------------------------
   SEARCH — filter the user's currently-open tabs (left column)
   ---------------------------------------------------------------- */

function searchOpenTabs(query) {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase();

  // De-dup by URL so the same tab opened in two windows shows once
  const seen = new Map();
  for (const t of openTabs) {
    if (!t.url || t.isTabOut) continue;
    if (t.url.startsWith('chrome://') || t.url.startsWith('chrome-extension://') || t.url.startsWith('about:')) continue;
    const title = (t.title || '').toLowerCase();
    const url   = t.url.toLowerCase();
    if (!title.includes(q) && !url.includes(q)) continue;
    if (!seen.has(t.url)) seen.set(t.url, { url: t.url, title: t.title || t.url });
  }
  return Array.from(seen.values()).slice(0, 25);
}

function renderSearchResultRow(r) {
  let domain = '';
  try { domain = new URL(r.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const safeTitle = (r.title || '').replace(/"/g, '&quot;');
  const safeUrl   = (r.url || '').replace(/"/g, '&quot;');
  return `
    <div class="search-result" draggable="true" data-result-url="${safeUrl}" data-result-title="${safeTitle}" title="拖到任意分组保存">
      <img class="search-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">
      <div class="search-result-info">
        <div class="search-result-title">${r.title || r.url}</div>
        <div class="search-result-meta"><span>${domain}</span></div>
      </div>
    </div>`;
}

function runReadingSearch(query) {
  const resultsEl = document.getElementById('readingSearchResults');
  if (!resultsEl) return;
  const results = searchOpenTabs(query);
  if (results.length === 0) {
    resultsEl.innerHTML = '<div class="search-empty">没找到匹配的 open tab</div>';
  } else {
    const bulkHandle = `
      <div class="search-drag-all" draggable="true" title="把这 ${results.length} 条全部一起拖到某个分组">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.75" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 8.25V6a2.25 2.25 0 0 0-2.25-2.25H6A2.25 2.25 0 0 0 3.75 6v8.25A2.25 2.25 0 0 0 6 16.5h2.25m8.25-8.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-8.25A2.25 2.25 0 0 1 7.5 18v-1.5m8.25-8.25h-6a2.25 2.25 0 0 0-2.25 2.25v6" /></svg>
      </div>`;
    resultsEl.innerHTML = bulkHandle + results.map(renderSearchResultRow).join('');
  }
  resultsEl.style.display = 'block';
}

// Debounced input handler
let searchDebounceTimer = null;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'readingSearch') return;
  const q = e.target.value.trim();
  const clearBtn = document.getElementById('readingSearchClear');
  const resultsEl = document.getElementById('readingSearchResults');
  if (clearBtn) clearBtn.style.display = q ? 'flex' : 'none';

  clearTimeout(searchDebounceTimer);
  if (q.length < 2) {
    if (resultsEl) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; }
    return;
  }
  searchDebounceTimer = setTimeout(() => runReadingSearch(q), 180);
});

// Clear button
document.addEventListener('click', (e) => {
  if (e.target.id !== 'readingSearchClear') return;
  const input    = document.getElementById('readingSearch');
  const results  = document.getElementById('readingSearchResults');
  const clearBtn = document.getElementById('readingSearchClear');
  if (input) { input.value = ''; input.focus(); }
  if (results) { results.style.display = 'none'; results.innerHTML = ''; }
  if (clearBtn) clearBtn.style.display = 'none';
});


/* ----------------------------------------------------------------
   OBSIDIAN EXPORT — File System Access API + IndexedDB-persisted handle

   First click: user picks the target .md file (e.g. 网页清单.md).
   Subsequent clicks: handle re-used; user may see a one-click
   "allow access this session" prompt after browser restart.

   We only replace the block between two HTML-comment fences so the
   user's manually-written content in the same file stays untouched.
   ---------------------------------------------------------------- */

const OBS_FENCE_START = '<!-- tab-out:reading:start -->';
const OBS_FENCE_END   = '<!-- tab-out:reading:end -->';
const OBS_IDB_NAME    = 'tabout-obsidian';
const OBS_IDB_STORE   = 'handles';
const OBS_IDB_KEY     = 'reading-list-file';

function obsidianIdbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OBS_IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(OBS_IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function obsidianSaveHandle(handle) {
  const db = await obsidianIdbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OBS_IDB_STORE, 'readwrite');
    tx.objectStore(OBS_IDB_STORE).put(handle, OBS_IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function obsidianLoadHandle() {
  const db = await obsidianIdbOpen();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(OBS_IDB_STORE, 'readonly');
    const req = tx.objectStore(OBS_IDB_STORE).get(OBS_IDB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

async function renderReadingMarkdown() {
  const [groups, items] = await Promise.all([getGroups(), getDeferredItems()]);
  const lines = [];
  const today = new Date().toISOString().slice(0, 10);
  lines.push(`<!-- updated ${today} by tab-out -->`);
  lines.push('');

  const fmt = (t) => {
    const title = (t.title || t.url).replace(/[\[\]]/g, ' ').trim();
    return `- [ ] [${title}](${t.url})`;
  };

  for (const g of groups) {
    const groupItems = items.filter(t => t.groupId === g.id);
    if (groupItems.length === 0) continue;
    lines.push(`## ${g.name}`);
    for (const t of groupItems) lines.push(fmt(t));
    lines.push('');
  }

  const unsorted = items.filter(t => t.groupId == null);
  if (unsorted.length > 0) {
    lines.push('## 待整理');
    for (const t of unsorted) lines.push(fmt(t));
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

async function exportReadingToObsidian() {
  if (!window.showOpenFilePicker) {
    showToast('当前浏览器不支持文件系统访问');
    return;
  }

  let handle = await obsidianLoadHandle();

  if (!handle) {
    try {
      const picked = await window.showOpenFilePicker({
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
        multiple: false,
        startIn: 'documents',
      });
      handle = picked[0];
      await obsidianSaveHandle(handle);
    } catch (err) {
      return; // user cancelled
    }
  }

  // Make sure we still have permission this session
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    const next = await handle.requestPermission({ mode: 'readwrite' });
    if (next !== 'granted') {
      showToast('未授权写入');
      return;
    }
  }

  let existing = '';
  try {
    const file = await handle.getFile();
    existing = await file.text();
  } catch (err) {
    console.warn('[tab-out] could not read existing file:', err);
  }

  const block   = await renderReadingMarkdown();
  const wrapped = `${OBS_FENCE_START}\n${block}\n${OBS_FENCE_END}`;

  let updated;
  const startIdx = existing.indexOf(OBS_FENCE_START);
  const endIdx   = existing.indexOf(OBS_FENCE_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after  = existing.slice(endIdx + OBS_FENCE_END.length);
    updated = before + wrapped + after;
  } else {
    const sep = (existing && !existing.endsWith('\n')) ? '\n\n' : (existing ? '\n' : '');
    updated = existing + sep + wrapped + '\n';
  }

  try {
    const writable = await handle.createWritable();
    await writable.write(updated);
    await writable.close();
    showToast('已同步到 Obsidian');
  } catch (err) {
    console.error('[tab-out] write failed:', err);
    showToast('写入失败');
  }
}


/* ----------------------------------------------------------------
   CONFIRM MODAL — in-page replacement for window.confirm()
   (Chrome new-tab override pages may suppress native modal dialogs.)
   ---------------------------------------------------------------- */

function showConfirm(title, body = '', { okText = '确认', cancelText = '取消', destructive = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-modal" role="dialog" aria-modal="true">
        <div class="confirm-title">${title}</div>
        ${body ? `<div class="confirm-body">${body}</div>` : ''}
        <div class="confirm-actions">
          <button class="confirm-btn confirm-cancel">${cancelText}</button>
          <button class="confirm-btn confirm-ok${destructive ? ' destructive' : ''}">${okText}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const cleanup = (result) => {
      overlay.classList.add('closing');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => overlay.remove(), 120);
      resolve(result);
    };

    overlay.querySelector('.confirm-cancel').addEventListener('click', () => cleanup(false));
    overlay.querySelector('.confirm-ok').addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      if (e.key === 'Enter')  { e.preventDefault(); cleanup(true);  }
    };
    document.addEventListener('keydown', onKey);

    // Default focus on cancel so Enter doesn't accidentally confirm a destructive op
    overlay.querySelector(destructive ? '.confirm-cancel' : '.confirm-ok').focus();
  });
}


/* ----------------------------------------------------------------
   DRAG & DROP — chips and saved items into group sections
   ---------------------------------------------------------------- */

let dragPayload = null; // { type: 'chip', url, title } | { type: 'item', id }

document.addEventListener('dragstart', (e) => {
  // Don't drag when the user grabbed an interactive button inside a card
  if (e.target.closest('.chip-actions button, .actions button')) {
    e.preventDefault();
    return;
  }

  const chip      = e.target.closest('.page-chip[draggable="true"]');
  const item      = e.target.closest('.deferred-item[draggable="true"]');
  const card      = e.target.closest('.mission-card[draggable="true"]');
  const search    = e.target.closest('.search-result[draggable="true"]');
  const bulkAll   = e.target.closest('.search-drag-all[draggable="true"]');
  const groupHdl  = e.target.closest('.group-handle[draggable="true"]');

  if (groupHdl) {
    const section = groupHdl.closest('.group-section');
    const groupId = section?.dataset.groupId;
    if (!groupId) { e.preventDefault(); return; }
    dragPayload = { type: 'group', id: groupId };
    section.classList.add('dragging');
  } else if (bulkAll) {
    // Drag the entire current search-results set at once → card-style drop
    const container = document.getElementById('readingSearchResults');
    const rows = container ? container.querySelectorAll('.search-result[draggable="true"]') : [];
    const tabs = Array.from(rows).map(r => ({
      url:   r.dataset.resultUrl,
      title: r.dataset.resultTitle || r.dataset.resultUrl,
    }));
    if (tabs.length === 0) { e.preventDefault(); return; }
    dragPayload = { type: 'card', tabs };
    bulkAll.classList.add('dragging');
  } else if (search) {
    // Same payload as a chip — dropping closes that tab too
    dragPayload = {
      type:  'chip',
      url:   search.dataset.resultUrl,
      title: search.dataset.resultTitle || search.dataset.resultUrl,
    };
    search.classList.add('dragging');
  } else if (chip) {
    dragPayload = {
      type:  'chip',
      url:   chip.dataset.tabUrl,
      title: chip.dataset.tabTitle || chip.dataset.tabUrl,
    };
    chip.classList.add('dragging');
  } else if (item) {
    dragPayload = { type: 'item', id: item.dataset.deferredId };
    item.classList.add('dragging');
  } else if (card) {
    // Drag an entire open-tabs group → save all its tabs at once
    const chips = card.querySelectorAll('.page-chip[data-tab-url]');
    const tabs = Array.from(chips).map(c => ({
      url:   c.dataset.tabUrl,
      title: c.dataset.tabTitle || c.dataset.tabUrl,
    }));
    if (tabs.length === 0) { e.preventDefault(); return; }
    dragPayload = { type: 'card', tabs };
    card.classList.add('dragging');
  } else {
    return;
  }

  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', dragPayload.url || dragPayload.id || ''); } catch {}
  document.body.classList.add('drag-active');
});

/* ----------------------------------------------------------------
   Edge auto-scroll while dragging — lets the user reach groups that
   are scrolled out of view inside .deferred-column
   ---------------------------------------------------------------- */

let dragScrollRAF = null;
let dragScrollEl  = null;
let dragScrollSpeed = 0;

function maybeStartDragScroll(target, clientY) {
  if (!target) { stopDragScroll(); return; }
  const r = target.getBoundingClientRect();
  const EDGE = 100;
  let speed = 0;

  if (clientY < r.top + EDGE) {
    const dist = (r.top + EDGE) - clientY;
    speed = -Math.min(14, 2 + dist / 4);
  } else if (clientY > r.bottom - EDGE) {
    const dist = clientY - (r.bottom - EDGE);
    speed = Math.min(14, 2 + dist / 4);
  }

  dragScrollSpeed = speed;
  dragScrollEl    = target;

  if (speed === 0) return; // outside edge zone — nothing to do

  if (!dragScrollRAF) {
    const step = () => {
      if (!dragScrollEl || dragScrollSpeed === 0) { dragScrollRAF = null; return; }
      dragScrollEl.scrollTop += dragScrollSpeed;
      dragScrollRAF = requestAnimationFrame(step);
    };
    dragScrollRAF = requestAnimationFrame(step);
  }
}

function stopDragScroll() {
  dragScrollSpeed = 0;
  dragScrollEl    = null;
  if (dragScrollRAF) { cancelAnimationFrame(dragScrollRAF); dragScrollRAF = null; }
}

// Flash recently-added items so the user sees where they landed
async function flashDroppedItems(ids) {
  await new Promise(r => requestAnimationFrame(r));
  for (const id of ids) {
    const el = document.querySelector(`.deferred-item[data-deferred-id="${id}"]`);
    if (el) {
      el.classList.add('just-dropped');
      setTimeout(() => el.classList.remove('just-dropped'), 750);
    }
  }
}

async function flashGroup(groupId) {
  await new Promise(r => requestAnimationFrame(r));
  const sel = groupId == null
    ? '.group-section.unsorted-section'
    : `.group-section[data-group-id="${groupId}"]`;
  const el = document.querySelector(sel);
  if (el) {
    el.classList.add('just-dropped');
    setTimeout(() => el.classList.remove('just-dropped'), 750);
  }
}

// If dropping into a collapsed group, expand it so the dropped item is visible
async function ensureGroupExpanded(groupId) {
  if (groupId == null) {
    if (await getUnsortedCollapsed()) await toggleUnsortedCollapsed();
  } else {
    const groups = await getGroups();
    const g = groups.find(x => x.id === groupId);
    if (g && g.collapsed) await toggleGroupCollapsed(groupId);
  }
}

function clearPreviewExpand() {
  document.querySelectorAll('.group-section.preview-expand').forEach(el => el.classList.remove('preview-expand'));
}

function clearGroupDropIndicators() {
  document.querySelectorAll('.group-section.drop-above, .group-section.drop-below')
    .forEach(el => el.classList.remove('drop-above', 'drop-below'));
}

// For a group-reorder drag, pick the target gap based on cursor Y.
// Returns { section, position: 'above' | 'below' } or null.
function computeGroupDropTarget(clientY) {
  const sections = Array.from(document.querySelectorAll(
    '.groups-wrap .group-section:not(.unsorted-section)'
  ));
  if (sections.length === 0) return null;
  for (const sec of sections) {
    const r = sec.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return { section: sec, position: 'above' };
  }
  return { section: sections[sections.length - 1], position: 'below' };
}

document.addEventListener('dragend', () => {
  document.body.classList.remove('drag-active');
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.group-section.drag-over').forEach(el => el.classList.remove('drag-over'));
  clearGroupDropIndicators();
  clearPreviewExpand();
  stopDragScroll();
  dragPayload = null;
});

document.addEventListener('dragover', (e) => {
  if (!dragPayload) return;

  // Edge auto-scroll: if cursor is near top/bottom of the Reading column,
  // scroll it so the user can reach groups outside the viewport
  const deferredCol = document.getElementById('deferredColumn');
  if (deferredCol && deferredCol.contains(e.target)) {
    maybeStartDragScroll(deferredCol, e.clientY);
  } else {
    stopDragScroll();
  }

  // Reordering a group: show insertion indicator between sections
  if (dragPayload.type === 'group') {
    const wrap = e.target.closest('.groups-wrap');
    if (!wrap) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = computeGroupDropTarget(e.clientY);
    clearGroupDropIndicators();
    if (target && target.section.dataset.groupId !== dragPayload.id) {
      target.section.classList.add(target.position === 'above' ? 'drop-above' : 'drop-below');
    }
    return;
  }

  // All other drag types: highlight the hovered group section as a save target
  const section = e.target.closest('.group-section');
  if (!section) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.group-section.drag-over').forEach(el => {
    if (el !== section) el.classList.remove('drag-over');
  });
  section.classList.add('drag-over');

  // If hovering a collapsed group, preview-expand it so the user can see
  // what's inside before committing the drop
  document.querySelectorAll('.group-section.preview-expand').forEach(el => {
    if (el !== section) el.classList.remove('preview-expand');
  });
  if (section.classList.contains('collapsed')) section.classList.add('preview-expand');
});

document.addEventListener('dragleave', (e) => {
  const section = e.target.closest('.group-section');
  if (!section) return;
  if (!section.contains(e.relatedTarget)) section.classList.remove('drag-over');
});

document.addEventListener('drop', async (e) => {
  if (!dragPayload) return;

  // Group reorder
  if (dragPayload.type === 'group') {
    e.preventDefault();
    const wrap = e.target.closest('.groups-wrap');
    if (!wrap) { clearGroupDropIndicators(); dragPayload = null; return; }
    const target = computeGroupDropTarget(e.clientY);
    clearGroupDropIndicators();
    const id = dragPayload.id;
    dragPayload = null;
    if (!target || target.section.dataset.groupId === id) return;

    const groups = await getGroups();
    const fromIdx = groups.findIndex(g => g.id === id);
    const targetIdx = groups.findIndex(g => g.id === target.section.dataset.groupId);
    if (fromIdx === -1 || targetIdx === -1) return;
    let toIdx = target.position === 'above' ? targetIdx : targetIdx + 1;
    if (fromIdx < toIdx) toIdx--; // splice-then-insert adjustment
    if (toIdx === fromIdx) return;
    await moveGroup(id, toIdx);
    await renderDeferredColumn();
    flashGroup(id);
    return;
  }

  const section = e.target.closest('.group-section');
  if (!section) return;
  e.preventDefault();
  section.classList.remove('drag-over');

  const groupIdAttr = section.dataset.groupId;
  const groupId = groupIdAttr === '' ? UNSORTED_GROUP_ID : groupIdAttr;
  const payload = dragPayload;
  dragPayload = null;

  if (payload.type === 'chip') {
    try {
      await ensureGroupExpanded(groupId);
      const item = await saveTabToGroup({ url: payload.url, title: payload.title }, groupId);
      const allTabs = await chrome.tabs.query({});
      const match   = allTabs.find(t => t.url === payload.url);
      if (match) await chrome.tabs.remove(match.id);
      await fetchOpenTabs();
      await renderStaticDashboard(); // refresh left column too
      const searchInput = document.getElementById('readingSearch');
      if (searchInput && searchInput.value.trim().length >= 2) runReadingSearch(searchInput.value.trim());
      flashDroppedItems([item.id]);
      showToast(groupId ? 'Saved to group' : 'Saved to 待整理');
    } catch (err) {
      console.error('[tab-out] drop save failed:', err);
      showToast('Failed to save');
    }
  } else if (payload.type === 'item') {
    try {
      await ensureGroupExpanded(groupId);
      await moveItemToGroup(payload.id, groupId);
      await renderDeferredColumn();
      flashDroppedItems([payload.id]);
      showToast('Moved');
    } catch (err) {
      console.error('[tab-out] drop move failed:', err);
    }
  } else if (payload.type === 'card') {
    try {
      await ensureGroupExpanded(groupId);
      const newIds = [];
      for (const t of payload.tabs) {
        const item = await saveTabToGroup({ url: t.url, title: t.title }, groupId);
        newIds.push(item.id);
      }
      const urls = new Set(payload.tabs.map(t => t.url));
      const allTabs = await chrome.tabs.query({});
      const tabIds = allTabs.filter(t => urls.has(t.url)).map(t => t.id);
      if (tabIds.length) await chrome.tabs.remove(tabIds);
      await fetchOpenTabs();
      await renderStaticDashboard();
      const searchInput = document.getElementById('readingSearch');
      if (searchInput && searchInput.value.trim().length >= 2) runReadingSearch(searchInput.value.trim());
      flashDroppedItems(newIds);
      showToast(`Saved ${payload.tabs.length} tab${payload.tabs.length !== 1 ? 's' : ''} to group`);
    } catch (err) {
      console.error('[tab-out] drop card failed:', err);
      showToast('Failed to save group');
    }
  }
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard().finally(() => {
  // After the intro animations finish, drop the body class so future
  // re-renders (post drop / drag) don't replay fadeUp on every card.
  setTimeout(() => document.body.classList.remove('first-render'), 1200);
});
