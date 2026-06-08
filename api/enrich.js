// Turns a Rolling Stone list entry + its Wikipedia article into a schema-valid album.
//
// The CSV already gives us albumName, artist, and genre (authoritative). The Claude
// API reads the Wikipedia wikitext and fills only the remaining factual fields. The
// cover image comes from Wikipedia; the YouTube link is a constructed search URL.

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

// claude-haiku-4-5 is plenty for structured extraction from article text and is the
// cheapest model that supports structured outputs (per the approved plan).
const MODEL = 'claude-haiku-4-5';

// The fields Claude must derive from the article. albumName / artist / genre are NOT
// here — they come from the CSV and must not be overwritten.
const ENRICH_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        releaseDate: { type: 'string' },
        label: { type: 'string' },
        bandMembers: { type: 'array', items: { type: 'string' } },
        isBandTogether: { type: 'boolean' },
        // Rolling Stone uses a 5-star system. Constrain output to exactly that.
        rollingStoneReview: { type: 'string', enum: ['*', '**', '***', '****', '*****'] },
        albumsSold: { type: 'integer' },
    },
    required: ['releaseDate', 'label', 'bandMembers', 'isBandTogether', 'rollingStoneReview', 'albumsSold'],
};

// Stable instructions — kept first and marked for prompt caching so repeated runs
// (and multiple candidate attempts within one run) reuse the prefix.
const SYSTEM_PROMPT = `You extract structured album metadata from a Wikipedia article's raw wikitext.

Return ONLY these fields, read from the article (especially the {{Infobox album}} and {{Album ratings}} templates):
- releaseDate: the album's release date as written (e.g. "September 12th, 1975" or "1977").
- label: the record label that released it.
- bandMembers: the performing artist's members/personnel. For a solo artist, use a one-element array with the artist's name.
- isBandTogether: true if the artist/band is still active today, false if disbanded, on indefinite hiatus, or the primary artist is deceased.
- rollingStoneReview: the album's Rolling Stone rating expressed as that many asterisks, one of "*", "**", "***", "****", "*****". Look in the "Professional ratings" / {{Album ratings}} box for the Rolling Stone entry (e.g. "4/5 stars" -> "****"). If the article has NO Rolling Stone rating, return "*".
- albumsSold: total copies sold worldwide as an integer if the article states a sales figure or certification-derived number; otherwise 0.

Do not include albumName, artist, or genre — those are provided separately and are authoritative.`;

function buildYouTubeSearchURL(albumName, artist) {
    const q = encodeURIComponent(`${artist} ${albumName} full album`);
    return `https://www.youtube.com/results?search_query=${q}`;
}

// candidate: { albumName, artist, genre } from the CSV
// article:   { wikitext, imgURL, sourceUrl } from wikipedia.js
async function enrichAlbum(candidate, article) {
    const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: [
            { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ],
        output_config: { format: { type: 'json_schema', schema: ENRICH_SCHEMA } },
        messages: [
            {
                role: 'user',
                content: `Album: ${candidate.albumName}\nArtist: ${candidate.artist}\n\nWikipedia wikitext:\n${article.wikitext}`,
            },
        ],
    });

    const text = response.content.find((b) => b.type === 'text')?.text ?? '{}';
    const derived = JSON.parse(text);

    // Enforce the star format defensively (default to "*" if the model strays).
    if (!/^\*{1,5}$/.test(derived.rollingStoneReview)) derived.rollingStoneReview = '*';

    return {
        // Authoritative fields from the CSV
        albumName: candidate.albumName,
        artist: candidate.artist,
        genre: candidate.genre,
        // Derived from Wikipedia via Claude
        releaseDate: derived.releaseDate,
        label: derived.label,
        bandMembers: derived.bandMembers,
        isBandTogether: derived.isBandTogether,
        rollingStoneReview: derived.rollingStoneReview,
        albumsSold: Math.max(0, Math.trunc(derived.albumsSold ?? 0)),
        // Constructed / sourced
        imgURL: article.imgURL,
        youTubeAlbumURL: buildYouTubeSearchURL(candidate.albumName, candidate.artist),
    };
}

module.exports = { enrichAlbum };
