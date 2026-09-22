const { filterStackItems, STACK_SORTABLE } = require('./stackFilter');

const PAGE_OPTS = { pageSizeDefault: 40, pageSizeMax: 100 };

const wishYouWereHere = {
    id: '1', albumName: 'Wish You Were Here', artist: 'Pink Floyd',
    albumsSold: 20000000, rollingStoneReview: '*****',
    genres: [{ name: 'Rock', isCanonical: true }, { name: 'Progressive Rock', isCanonical: true }],
};
const discovery = {
    id: '2', albumName: 'Discovery', artist: 'Daft Punk',
    albumsSold: 5000000, rollingStoneReview: '***',
    genres: [{ name: 'Electronic', isCanonical: true }],
};
const legacyItem = {
    id: '3', albumName: 'Some Legacy Record', artist: 'Some Artist',
    albumsSold: 1000, rollingStoneReview: '**',
    genre: 'Electronic, Rock', genres: [],
};

describe('filterStackItems', () => {
    it('returns the input unchanged when no params are given', () => {
        const items = [wishYouWereHere, discovery];
        expect(filterStackItems(items, { ...PAGE_OPTS })).toEqual(items);
    });

    describe('search', () => {
        it('matches albumName case-insensitively', () => {
            const result = filterStackItems([wishYouWereHere, discovery], { search: 'wish you', ...PAGE_OPTS });
            expect(result).toEqual([wishYouWereHere]);
        });

        it('matches artist case-insensitively', () => {
            const result = filterStackItems([wishYouWereHere, discovery], { search: 'DAFT', ...PAGE_OPTS });
            expect(result).toEqual([discovery]);
        });
    });

    describe('genre', () => {
        it('matches a single genre against item.genres[].name', () => {
            const result = filterStackItems([wishYouWereHere, discovery], { genre: 'Electronic', ...PAGE_OPTS });
            expect(result).toEqual([discovery]);
        });

        it('ORs repeated genre params', () => {
            const result = filterStackItems([wishYouWereHere, discovery], { genre: ['Electronic', 'Progressive Rock'], ...PAGE_OPTS });
            expect(result).toEqual([wishYouWereHere, discovery]);
        });

        it('ORs a comma-joined genre param', () => {
            const result = filterStackItems([wishYouWereHere, discovery], { genre: 'Electronic,Progressive Rock', ...PAGE_OPTS });
            expect(result).toEqual([wishYouWereHere, discovery]);
        });

        it('falls back to a split item.genre string when genres is empty', () => {
            const result = filterStackItems([legacyItem, discovery], { genre: 'Rock', ...PAGE_OPTS });
            expect(result).toEqual([legacyItem]);
        });
    });

    describe('sortBy/order', () => {
        it.each(STACK_SORTABLE)('sorts ascending and descending by %s', (field) => {
            const items = [wishYouWereHere, discovery];
            const asc = filterStackItems(items, { sortBy: field, order: 'asc', ...PAGE_OPTS });
            const desc = filterStackItems(items, { sortBy: field, order: 'desc', ...PAGE_OPTS });
            expect(asc).toEqual([...desc].reverse());
        });

        it('sorts items missing the sort field last', () => {
            const noSold = { ...discovery, albumsSold: undefined };
            const result = filterStackItems([noSold, wishYouWereHere], { sortBy: 'albumsSold', order: 'asc', ...PAGE_OPTS });
            expect(result).toEqual([wishYouWereHere, noSold]);
        });

        it('ignores an unrecognized sortBy', () => {
            const items = [wishYouWereHere, discovery];
            expect(filterStackItems(items, { sortBy: 'notAField', ...PAGE_OPTS })).toEqual(items);
        });
    });

    describe('pagination', () => {
        const items = Array.from({ length: 25 }, (_, i) => ({ id: String(i), albumName: `Album ${i}`, artist: 'A' }));

        it('slices by page/limit', () => {
            const result = filterStackItems(items, { page: '2', limit: '10', ...PAGE_OPTS });
            expect(result).toEqual(items.slice(10, 20));
        });

        it('returns a short final page', () => {
            const result = filterStackItems(items, { page: '3', limit: '10', ...PAGE_OPTS });
            expect(result).toEqual(items.slice(20, 25));
        });

        it('clamps limit to pageSizeMax', () => {
            const result = filterStackItems(items, { page: '1', limit: '1000', pageSizeDefault: 40, pageSizeMax: 20 });
            expect(result).toEqual(items.slice(0, 20));
        });

        it('uses pageSizeDefault when limit is omitted', () => {
            const result = filterStackItems(items, { page: '1', pageSizeDefault: 5, pageSizeMax: 100 });
            expect(result).toEqual(items.slice(0, 5));
        });
    });
});
