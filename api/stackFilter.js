// Sortable fields for a user's mystack snapshots. Mirrors ALBUM_SORTABLE minus
// created_at: mystack items are jsonb snapshots with no per-item add timestamp
// (see knex/migrations/20241005150355_users.js).
const STACK_SORTABLE = ['albumName', 'artist', 'albumsSold', 'rollingStoneReview'];

const normalizeGenreList = (genre) =>
    [].concat(genre ?? [])
        .flatMap(g => g.split(','))
        .map(g => g.trim().toLowerCase())
        .filter(Boolean);

// item.genres is the {name, isCanonical}[] snapshot captured at add-time (see
// /albums's correlated genres subquery). It can be [] for pre-genres-migration
// albums whose genre string wasn't recognized as canonical/alias - item.genre is
// itself comma-joined in that case (see setAlbumGenres / albumData.genre), so the
// fallback must split it the same way normalizeGenreList does, not treat it as
// one opaque string.
const genreNamesOf = (item) =>
    (item.genres?.length ? item.genres.map(g => g.name) : (item.genre ? item.genre.split(',') : []))
        .map(n => n.trim()).filter(Boolean);

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
