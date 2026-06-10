// Canonical genre taxonomy + a parser that turns the raw `genre` string into the
// set of canonical genres an album belongs to.
//
// Why this exists: the Rolling Stone CSV (the cron's source) stores genre as a
// Discogs-style list joined with ", " — e.g. "Electronic, Rock" or
// "Rock, Funk / Soul". The trap is that several *canonical* genres contain commas
// themselves ("Folk, World, & Country", "Funk / Soul", "Stage & Screen"), so a
// naive split(',') shreds them. Instead we match known canonical names out of the
// raw string, longest-first, so the multi-word names win before their fragments.
//
// This is the single source of truth for what genres exist. To add/rename a genre,
// edit CANONICAL_GENRES (and GENRE_ALIASES for legacy spellings) — nothing else.

// Order matters only for readability; matching sorts by length internally.
const CANONICAL_GENRES = [
    'Rock',
    'Pop',
    'Hip Hop',
    'Electronic',
    'Funk / Soul',
    'Jazz',
    'Blues',
    'Reggae',
    'Latin',
    'Classical',
    'Folk, World, & Country',
    'Stage & Screen',
];

// Legacy / variant spellings → canonical name. Seed data used single-genre strings
// like "Hip-Hop", "Folk", "Country"; these fold them into the canonical buckets so
// old and new rows land in the same genre. Keys are matched case-insensitively.
const GENRE_ALIASES = {
    'hip-hop': 'Hip Hop',
    'hiphop': 'Hip Hop',
    'rap': 'Hip Hop',
    'r&b': 'Funk / Soul',
    'funk': 'Funk / Soul',
    'soul': 'Funk / Soul',
    'folk': 'Folk, World, & Country',
    'country': 'Folk, World, & Country',
    'world': 'Folk, World, & Country',
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// One alternation of every canonical name and alias, sorted longest-first so
// "Folk, World, & Country" is consumed before the bare "Folk" alias or a stray
// "Country", and "Funk / Soul" before "Funk"/"Soul". Each match maps back to its
// canonical name. Global + case-insensitive; a matched span is not re-scanned, so
// fragments inside a longer match can't double-count.
const MATCHERS = [
    ...CANONICAL_GENRES.map((name) => ({ pattern: name, canonical: name })),
    ...Object.entries(GENRE_ALIASES).map(([alias, canonical]) => ({ pattern: alias, canonical })),
].sort((a, b) => b.pattern.length - a.pattern.length);

const lookup = new Map(MATCHERS.map((m) => [m.pattern.toLowerCase(), m.canonical]));
const GENRE_REGEX = new RegExp(MATCHERS.map((m) => escapeRegExp(m.pattern)).join('|'), 'gi');

// Case-insensitive index of every canonical/alias spelling -> canonical display name,
// used by canonicalizeName to fold known variants ("hip-hop" -> "Hip Hop").
const CANONICAL_BY_LOWER = new Map([
    ...CANONICAL_GENRES.map((name) => [name.toLowerCase(), name]),
    ...Object.entries(GENRE_ALIASES).map(([alias, canonical]) => [alias.toLowerCase(), canonical]),
]);

// Normalizes a SINGLE, already-discrete genre name (one a user picked/typed — NOT a
// compound CSV string; use parseGenres for those). Collapses whitespace incl. U+00A0,
// trims, and folds known canonical/alias spellings to their canonical display form.
// An unrecognized name is returned cleaned-but-verbatim so user genres are preserved.
function canonicalizeName(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    return CANONICAL_BY_LOWER.get(cleaned.toLowerCase()) || cleaned;
}

// Stable, case-insensitive dedupe key for a genre. Two spellings that canonicalize to
// the same name (e.g. "Shoegaze"/" shoegaze ", "Hip-Hop"/"Hip Hop") share one slug.
function genreSlug(raw) {
    return canonicalizeName(raw).toLowerCase();
}

// raw: the album's `genre` column value, possibly null/empty.
// Returns an ordered, de-duplicated array of canonical genre names. Unknown text
// yields []; callers decide how to handle an album with no recognized genre.
function parseGenres(raw) {
    if (!raw || typeof raw !== 'string') return [];
    // Collapse all whitespace runs to single spaces. JS \s includes the U+00A0
    // non-breaking spaces the CSV is littered with, so this normalizes them too.
    const normalized = raw.replace(/\s+/g, ' ').trim();

    const seen = new Set();
    const out = [];
    for (const match of normalized.matchAll(GENRE_REGEX)) {
        const canonical = lookup.get(match[0].toLowerCase());
        if (canonical && !seen.has(canonical)) {
            seen.add(canonical);
            out.push(canonical);
        }
    }
    return out;
}

module.exports = { CANONICAL_GENRES, GENRE_ALIASES, parseGenres, canonicalizeName, genreSlug };
