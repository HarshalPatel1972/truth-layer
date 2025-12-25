// Core Logic for Truth Layer

const DOM = {
  statusText: document.getElementById('status-text'),
  container: document.getElementById('results-container'),
  app: document.getElementById('app')
};

let currentSearchUrl = '';

// --- Initialization ---

async function init() {
  // Initial Search
  triggerSearch();

  // Listen for Tab Changes (Switching tabs)
  chrome.tabs.onActivated.addListener(triggerSearch);

  // Listen for URL changes (Navigating within a tab)
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.active) {
      triggerSearch();
    }
  });
}

async function triggerSearch() {
  try {
    const url = await getCurrentTabUrl();
    
    // Ignore if same URL (prevent flicker/refetch)
    // But we must allow if it's a different page on same domain
    
    if (!url || url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:')) {
      renderMessage('Open a public webpage to see discussions.', 'neutral');
      return;
    }

    const cleanUrlStr = cleanUrl(url);
    if (cleanUrlStr === currentSearchUrl) return; // Debounce
    currentSearchUrl = cleanUrlStr;

    updateStatus(`Searching: ${new URL(cleanUrlStr).hostname}...`);
    DOM.container.innerHTML = '<div class="spinner">Loading...</div>'; // Simple load state

    const results = await searchReddit(cleanUrlStr);
    renderResults(results, cleanUrlStr);

  } catch (err) {
    console.error(err);
    renderMessage('Error connecting to Reddit.', 'error');
  }
}

// --- Helpers ---

async function getCurrentTabUrl() {
  // In Side Panel, we want the active tab of the window this panel is attached to.
  // We use chrome.windows.getCurrent to ensure we get the right context.
  const window = await chrome.windows.getCurrent();
  const [tab] = await chrome.tabs.query({ active: true, windowId: window.id });
  return tab?.url;
}

function cleanUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    // Remove noise params
    const paramsToRemove = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', 'ref', 'ref_src', 'share_id', 'si', 'feature'
    ];
    paramsToRemove.forEach(p => url.searchParams.delete(p));
    
    // For YouTube, we need the 'v' param, but standard clean is mostly fine.
    // Ensure we don't end up with just 'https://youtube.com/' if it was a watch link.
    
    return url.toString();
  } catch (e) {
    return urlStr;
  }
}

function updateStatus(text) {
  DOM.statusText.textContent = text;
}

// --- Reddit API ---

async function searchReddit(url) {
  const results = new Map(); // Use Map to deduplicate by ID

  const addToResults = (items) => {
    items.forEach(item => {
      // Basic validation
      if (item.id && !results.has(item.id)) {
        results.set(item.id, item);
      }
    });
  };

  try {
    const encodedUrl = encodeURIComponent(url);
    
    // Strategy 1: The "Submit" Check (Finds posts where this URL is the main content)
    // This is the most accurate for link aggregators like r/news, r/technology
    const infoUrl = `https://www.reddit.com/api/info.json?url=${encodedUrl}`;
    
    // Strategy 2: The "Search" Check (Finds posts mentioning this URL)
    // Good for text posts or comments
    const searchUrl = `https://www.reddit.com/search.json?q=url:"${url}"&sort=top&limit=15`; // Quote the URL to handle special chars

    // Run in parallel
    const [infoRes, searchRes] = await Promise.allSettled([
        fetch(infoUrl).then(r => r.json()),
        fetch(searchUrl).then(r => r.json())
    ]);

    // Process Info Results
    if (infoRes.status === 'fulfilled' && infoRes.value.data?.children) {
      addToResults(infoRes.value.data.children.map(c => c.data));
    }

    // Process Search Results
    if (searchRes.status === 'fulfilled' && searchRes.value.data?.children) {
      addToResults(searchRes.value.data.children.map(c => c.data));
    }

    // Convert back to array and sort by score
    return Array.from(results.values()).sort((a, b) => b.score - a.score);

  } catch(e) {
    console.warn("Fetch failed", e);
    return [];
  }
}

// --- Rendering ---

function renderResults(threads, searchedUrl) {
  DOM.container.innerHTML = ''; 

  // Debug Info (Hidden by default, helpful for verifying what we checked)
  console.log(`Truth Layer checked: ${searchedUrl}`);

  if (!threads || threads.length === 0) {
    renderMessage(`
      <div style="margin-bottom:8px; font-weight:bold;">No discussions found.</div>
      <div style="font-size:11px; color:var(--text-muted); margin-bottom:12px;">
        Checked: <br>
        <code style="word-break:break-all; font-size:10px;">${searchedUrl}</code>
      </div>
      <a href="https://www.reddit.com/submit?url=${encodeURIComponent(searchedUrl)}" target="_blank" class="action-btn">Submit to Reddit</a>
    `, 'neutral');
    updateStatus('No results.');
    return;
  }

  updateStatus(`Found ${threads.length} discussions.`);

  threads.forEach(thread => {
    const card = document.createElement('div');
    card.className = 'thread-card';
    card.onclick = () => window.open(`https://www.reddit.com${thread.permalink}`, '_blank');

    const createdDate = new Date(thread.created_utc * 1000).toLocaleDateString();
    
    let thumbHtml = '';
    // Basic thumbnail check
    if(thread.thumbnail && thread.thumbnail.startsWith('http')) {
        thumbHtml = `<img src="${thread.thumbnail}" class="thread-thumb" alt="" onerror="this.style.display='none'">`;
    }

    card.innerHTML = `
      <div class="thread-header">
        <span class="subreddit">r/${thread.subreddit}</span>
        <span class="date">${createdDate}</span>
      </div>
      <div class="thread-body">
         ${thumbHtml}
         <h3 class="thread-title">${thread.title}</h3>
      </div>
      <div class="thread-footer">
        <span class="stat">⬆ ${formatNumber(thread.score)}</span>
        <span class="stat">💬 ${formatNumber(thread.num_comments)}</span>
      </div>
    `;

    DOM.container.appendChild(card);
  });
}

function renderMessage(html, type) {
  DOM.container.innerHTML = `<div class="message-card ${type}">${html}</div>`;
  updateStatus('Done.');
}

function formatNumber(num) {
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return num;
}

// Start
init();
