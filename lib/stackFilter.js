const { parseGenres } = require('./genres');

// Sortable fields for a user's mystack snapshots. Mirrors ALBUM_SORTABLE minus
// created_at: mystack items are jsonb snapshots with no per-item add timestamp
// (see knex/migrations/20241005150355_users.js).
const STACK_SORTABLE = ['albumName', 'artist', 'albumsSold', 'rollingStoneReview'];

// Deliberately NOT comma-split: several canonical genre names contain a literal
// comma ("Folk, World, & Country" - see genres.js), so splitting a selected genre
// on ',' shreds it into fragments that match nothing. The frontend always sends
// one `genre` query param per selection (repeated params, never comma-joined), and
// Express/qs already arrays those for us.
const normalizeGenreList = (genre) =>
    [].concat(genre ?? [])
        .map(g => g.trim().toLowerCase())
        .filter(Boolean);

// item.genres is the {name, isCanonical}[] snapshot captured at add-time (see
// /albums's correlated genres subquery). It can be [] for pre-genres-migration
// albums whose genre string wasn't recognized as canonical/alias. item.genre in
// that case IS a genuinely compound CSV string (e.g. "Electronic, Rock"), so unlike
// the query-param genre above, this needs comma-aware parsing - parseGenres already
// solves exactly this ("Folk, World, & Country" vs. a naive split), so reuse it
// instead of re-implementing the same trap it exists to avoid.
const genreNamesOf = (item) =>
    item.genres?.length ? item.genres.map(g => g.name) : parseGenres(item.genre);

function filterStackItems(items, { search, genre, sortBy, order, page, limit, pageSizeDefault, pageSizeMax }) {
    let result = items;

    const genreList = normalizeGenreList(genre);
    if (genreList.length) {
        result = result.filter(item =>
            genreNamesOf(item).some(n => genreList.includes(n.toLowerCase()))
        );
    }

    if (search) {
        const q = search.toLowerCase();
        result = result.filter(item =>
            item.albumName?.toLowerCase().includes(q) || item.artist?.toLowerCase().includes(q)
        );
    }

    if (sortBy && STACK_SORTABLE.includes(sortBy)) {
        const dir = order === 'desc' ? -1 : 1;
        result = [...result].sort((a, b) => {
            const av = a[sortBy], bv = b[sortBy];
            if (av == null) return 1;
            if (bv == null) return -1;
            return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
        });
    }

    const rawPage = parseInt(page, 10);
    if (Number.isInteger(rawPage) && rawPage >= 1) {
        const rawLimit = parseInt(limit, 10);
        const lim = Math.min(Math.max(Number.isInteger(rawLimit) ? rawLimit : pageSizeDefault, 1), pageSizeMax);
        result = result.slice((rawPage - 1) * lim, (rawPage - 1) * lim + lim);
    }

    return result;
}

module.exports = { STACK_SORTABLE, filterStackItems };
