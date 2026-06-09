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

// Finds candidate Wikipedia page titles for an album. We bias the query toward
// album articles by appending "album" and the artist name, but return several
// candidates so fetchAlbumArticle can skip non-album hits (e.g. a same-named song).
async function searchPageTitles(albumName, artist) {
    const data = await wikiGet({
        action: 'query',
        list: 'search',
        srsearch: `${albumName} ${artist} album`,
        srlimit: '8',
        srnamespace: '0',
    });
    return (data?.query?.search ?? []).map((r) => r.title);
}

// Wikipedia's canonical disambiguation patterns for an album. Search relevance often
// buries the original album under same-named songs/films/reissues (e.g. the plain
// "Sgt. Pepper's Lonely Hearts Club Band" page is not even in the top search hits),
// so we probe these exact titles directly and let scoring pick the best.
function directTitleGuesses(albumName, artist) {
    return [
        albumName,
        `${albumName} (album)`,
        `${albumName} (${artist} album)`,
    ];
}

// Titles that are clearly not the album article — a same-named song/single/film/EP
// would otherwise yield the wrong cover and ratings (e.g. the "Sgt. Pepper's ...
// (song)" page, whose cover is the single sleeve, not the album art).
const NON_ALBUM_TITLE = /\((song|single|film|EP)\)$/i;

// True when the wikitext is an album article (has an {{Infobox album}} template).
const isAlbumArticle = (wikitext) => /\{\{\s*Infobox album/i.test(wikitext);

// Loose name normalization for comparing artist names across infobox/CSV: drop
// wikilinks/punctuation and a leading "The" so "[[The Beatles]]" == "Beatles".
function normalizeName(s) {
    return (s || '')
        .toLowerCase()
        .replace(/\[\[|\]\]/g, '')
        .replace(/^the\s+/, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

// Pulls the {{Infobox album}} artist so we can pick the page by the right artist —
// e.g. distinguish the Beatles' "Sgt. Pepper's..." from the 1978 film soundtrack of
// the same name (an album article too, but by various artists).
function extractInfoboxArtist(wikitext) {
    const m = wikitext.match(/\|\s*[Aa]rtist\s*=\s*([^\n|]+)/);
    return m ? normalizeName(m[1].split('|').pop()) : '';
}

// True when the article's infobox artist matches the CSV artist (either contains
// the other, after normalization), tolerating "feat."/extra words on either side.
function artistMatches(wikitext, artist) {
    const want = normalizeName(artist);
    const have = extractInfoboxArtist(wikitext);
    if (!want || !have) return false;
    return have.includes(want) || want.includes(have);
}

// Reissue/edition markers — used to deprioritize "...: 50th Anniversary Edition",
// deluxe/remaster pages in favor of the original album of the same name.
const REISSUE_TITLE = /anniversary|deluxe|edition|remaster|reissue|expanded|super/i;

// Scores how well a candidate page matches the album we're importing. Higher is
// better. Artist match dominates; an exact title match beats a prefix match; and
// reissue/edition pages are penalized so the original album wins ties.
function scoreCandidate(title, wikitext, albumName, artist) {
    let score = 0;
    if (artistMatches(wikitext, artist)) score += 100;
    const t = normalizeName(title.replace(/\s*\([^)]*\)\s*$/, '')); // drop trailing "(album)" etc.
    const a = normalizeName(albumName);
    if (t === a) score += 30;
    else if (t.startsWith(a)) score += 10;
    else if (t.includes(a)) score += 5;
    if (REISSUE_TITLE.test(title)) score -= 15;
    return score;
}

// Fetches one page's wikitext + lead image. Returns null if missing/empty.
async function fetchPageData(title) {
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
    const wikitext = page.revisions?.[0]?.slots?.main?.content ?? '';
    if (!wikitext) return null;
    return { wikitext, leadImage: page.original?.source ?? null };
}

// Builds the article result (resolves the cover image) for a chosen page.
async function buildArticle(title, page) {
    // Prefer the infobox cover (album covers are non-free, so PageImages omits them);
    // fall back to the PageImages lead image if the article has no infobox cover.
    const coverFilename = extractCoverFilename(page.wikitext);
    const imgURL = (coverFilename && await resolveImageURL(coverFilename)) || page.leadImage || null;
    return {
        matchedTitle: title,
        wikitext: page.wikitext.slice(0, MAX_WIKITEXT_CHARS),
        imgURL,
        sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
    };
}

// Fetches an album's article. Of the search candidates that are album articles
// ({{Infobox album}}), picks the best-scoring one (see scoreCandidate): same artist,
// exact title, original over reissue. This skips same-named songs/singles, same-named
// albums by other artists (e.g. the 1978 "Sgt. Pepper's..." film soundtrack), and
// anniversary/deluxe editions. Returns null if no album page is found.
async function fetchAlbumArticle({ albumName, artist }) {
    const searched = await searchPageTitles(albumName, artist);
    // Probe canonical exact titles first, then search hits; dedupe and drop obvious
    // song/single pages. The exact-title probes rescue albums the search buries.
    const candidates = [...new Set([...directTitleGuesses(albumName, artist), ...searched])]
        .filter((t) => !NON_ALBUM_TITLE.test(t));

    let best = null; // { title, page, score }
    for (const title of candidates) {
        const page = await fetchPageData(title);
        if (!page || !isAlbumArticle(page.wikitext)) continue;
        const score = scoreCandidate(title, page.wikitext, albumName, artist);
        if (!best || score > best.score) best = { title, page, score };
    }
    return best ? buildArticle(best.title, best.page) : null;
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
