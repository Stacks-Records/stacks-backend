// Fetches a specific album's Wikipedia article for the daily import cron.
//
// The source list (Rolling Stone Top 500, see albumList.js) already supplies
// albumName, artist, and genre. This module looks up the matching Wikipedia page
// and returns its raw *wikitext* plus the cover image URL, so the enrichment step
// can read the remaining schema fields.
//
// We use wikitext (not the plain-text extract) on purpose: the article infobox
// ({{Infobox album ...}}) and the {{Album ratings}} template hold the structured
// data we need — release date, label, and the Rolling Stone star rating — and those
// templates are stripped out of the plain-text extract.

const WIKI_API = 'https://en.wikipedia.org/w/api.php';

// A descriptive User-Agent is required by Wikimedia's API policy; anonymous or
// generic agents can be rate-limited or blocked.
const USER_AGENT = 'StacksRecordsBot/1.0 (https://github.com/Stacks-Records; album library enrichment)';

// Wikitext can be long; the infobox, lead, and ratings table all sit near the top,
// so a generous slice keeps the Claude call cheap without losing the fields we need.
const MAX_WIKITEXT_CHARS = 15000;

async function wikiGet(params) {
    const url = `${WIKI_API}?${new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params })}`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Wikipedia API ${res.status} ${res.statusText}`);
    return res.json();
}

// Pulls the infobox cover filename out of the wikitext, e.g.
// "| cover = FMacRumours.PNG" -> "FMacRumours.PNG". Album covers are non-free, so
// PageImages omits them — the infobox is the reliable source.
function extractCoverFilename(wikitext) {
    const m = wikitext.match(/\|\s*[Cc]over\s*=\s*([^\n|]+)/);
    if (!m) return null;
    let v = m[1].trim()
        .replace(/^\[\[\s*(?:File|Image):/i, '')
        .replace(/\]\]\s*$/, '')
        .split('|')[0]
        .replace(/^(?:File|Image):/i, '')
        .trim();
    return v || null;
}

// Resolves a Wikipedia file name to its actual upload URL via imageinfo.
async function resolveImageURL(filename) {
    const data = await wikiGet({
        action: 'query',
        titles: `File:${filename}`,
        prop: 'imageinfo',
        iiprop: 'url',
    });
    return data?.query?.pages?.[0]?.imageinfo?.[0]?.url ?? null;
}

// Finds the best-matching Wikipedia page title for an album. We bias the query
// toward album articles by appending "album" and the artist name.
async function searchPageTitle(albumName, artist) {
    const data = await wikiGet({
        action: 'query',
        list: 'search',
        srsearch: `${albumName} ${artist} album`,
        srlimit: '1',
        srnamespace: '0',
    });
    return data?.query?.search?.[0]?.title ?? null;
}

// Fetches an album's article. Returns wikitext + cover image, or null if no page
// is found so the caller can move on to the next album in the list.
async function fetchAlbumArticle({ albumName, artist }) {
    const title = await searchPageTitle(albumName, artist);
    if (!title) return null;

    const pageData = await wikiGet({
        action: 'query',
        titles: title,
        prop: 'revisions|pageimages',
        rvprop: 'content',
        rvslots: 'main',
        piprop: 'original',
    });
    const page = pageData?.query?.pages?.[0];
    if (!page || page.missing) return null;

    const fullWikitext = page.revisions?.[0]?.slots?.main?.content ?? '';
    if (!fullWikitext) return null;

    // Prefer the infobox cover (album covers are non-free, so PageImages omits them);
    // fall back to the PageImages lead image if the article has no infobox cover.
    const coverFilename = extractCoverFilename(fullWikitext);
    const imgURL = (coverFilename && await resolveImageURL(coverFilename)) || page.original?.source || null;

    return {
        matchedTitle: title,
        wikitext: fullWikitext.slice(0, MAX_WIKITEXT_CHARS),
        imgURL,
        sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
    };
}

module.exports = { fetchAlbumArticle };

// Standalone runner for local verification: `node api/wikipedia.js "Album" "Artist"`
if (require.main === module) {
    const [albumName = 'Rumours', artist = 'Fleetwood Mac'] = process.argv.slice(2);
    fetchAlbumArticle({ albumName, artist })
        .then((a) => {
            if (!a) return console.error('No article found.');
            console.log('matchedTitle:', a.matchedTitle);
            console.log('imgURL:      ', a.imgURL);
            console.log('sourceUrl:   ', a.sourceUrl);
            console.log('wikitext (first 800 chars):\n', a.wikitext.slice(0, 800));
        })
        .catch((err) => { console.error('fetchAlbumArticle failed:', err.message); process.exit(1); });
}
