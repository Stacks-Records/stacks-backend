const express = require('express');
const app = express();
const cors = require('cors');
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

const configuration = require('../knexfile.js')[process.env.NODE_ENV || 'development']
const database = require('knex')(configuration);
const { auth } = require('express-oauth2-jwt-bearer');
const { hasPermission, canPerformAction, PERMISSIONS, USER_ROLES, resolveRole } = require('./permissions');
const { albumSchema, preferencesSchema, reorderSchema } = require('./validation');
const { randomUUID } = require('node:crypto');
const { loadAlbumList } = require('./albumList');
const { fetchAlbumArticle } = require('./wikipedia');
const { enrichAlbum } = require('./enrich');
const { parseGenres, canonicalizeName, genreSlug } = require('./genres');
const { filterStackItems } = require('./stackFilter');
const { applyStackOrder } = require('./stackOrder');
const rateLimit = require('express-rate-limit');

// Sets an album's genres from a list of genre names and (re)writes the album_genres
// links. This is the create-or-attach core: each name is normalized and matched by
// slug to an existing genre, or inserted as a NEW user-contributed genre (is_canonical
// defaults to false). Idempotent — it clears the album's existing links and inserts
// the current set, so it's safe on both create and update.
//
// Each entry is run through parseGenres first in case a caller handed us a compound
// string (e.g. a genres[] element of "Blues, Rock" from a UI that didn't split it, or
// a raw CSV genre string) — parseGenres pulls out the recognized canonical/alias names
// it contains. If none match (a free-form custom genre like "Shoegaze"), we fall back
// to the trimmed raw string as a single discrete name.
const setAlbumGenres = async (albumId, names) => {
    // Normalize + dedupe by slug so "Shoegaze"/"shoegaze" collapse to one genre.
    const bySlug = new Map();
    for (const raw of names || []) {
        const candidates = parseGenres(raw);
        for (const candidate of candidates.length ? candidates : [raw]) {
            const slug = genreSlug(candidate);
            if (slug && !bySlug.has(slug)) bySlug.set(slug, canonicalizeName(candidate));
        }
    }

    await database('album_genres').where('album_id', albumId).del();
    if (bySlug.size === 0) return;

    const slugs = [...bySlug.keys()];
    // Insert any genres we don't have yet (existing canonical rows are untouched, so
    // they keep is_canonical = true), then read back ids for every slug we need.
    await database('genres')
        .insert(slugs.map(slug => ({ name: bySlug.get(slug), slug })))
        .onConflict('slug').ignore();
    const rows = await database('genres').whereIn('slug', slugs).select('id');
    await database('album_genres')
        .insert(rows.map(r => ({ album_id: albumId, genre_id: r.id })))
        .onConflict(['album_id', 'genre_id']).ignore();
};

// Reads an album's current genres straight from the join table, in the same
// { name, isCanonical } shape used by /api/v1/genres and /api/v1/albums/by-genre.
// Callers use this after setAlbumGenres so a create/update response reflects what's
// actually linked (including any slug-based dedup against an existing genre), not
// just an echo of the raw input.
const getAlbumGenres = async (albumId) => {
    const rows = await database('genres')
        .join('album_genres', 'genres.id', 'album_genres.genre_id')
        .where('album_genres.album_id', albumId)
        .select('genres.name', 'genres.is_canonical')
        .orderBy('genres.name');
    return rows.map(r => ({ name: r.name, isCanonical: r.is_canonical }));
};

database.on('query', queryData => {
    console.log('SQL:', queryData.sql);
    console.log('Bindings:', queryData.bindings); // Optional: logs bindings too
});
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Email'],
    credential: true
}))

// Every route below hits the database, so an unrestricted client can hammer it into
// unresponsiveness (CodeQL js/missing-rate-limiting). Caps requests per IP; on Vercel
// each warm serverless instance tracks its own count (no shared store across
// instances/regions), so this is a per-instance backstop, not a hard global ceiling.
app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
}));

const port = process.env.PORT || 3001

const checkJwt = auth({
    audience: process.env.AUDIENCE,
    issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
});

// Identity comes only from a JWT claim proven to belong to the caller. Users are
// keyed by email (see the dedupe migration), so trusting an unverified email would
// let a second identity (e.g. a "Sign Up" account) silently inherit an existing
// account just by claiming someone else's address — email_verified is Auth0's
// confirmation that the identity provider actually checked that. A client-supplied
// `Email` header can never carry that proof, so it is never trusted as an identity
// source here, verified or not.
const getAuthEmail = (req) => {
    const email = req.auth?.payload?.email || req.auth?.email;
    const emailVerified = req.auth?.payload?.email_verified ?? req.auth?.email_verified;
    return email && emailVerified === true ? email : undefined;
};

const requirePermission = (permission) => {
    return async (req, res, next) => {
        try {
            const email = getAuthEmail(req);
            if (!email) {
                return res.status(401).json({ error: 'User not found.' });
            }
            const user = await database('users')
                .where('email', email)
                .first();

            if (!user) {
                return res.status(404).json({ error: 'User not found.' });
            }

            const role = resolveRole(email, user.role);
            if (!hasPermission(role, permission)) {
                return res.status(403).json({ error: 'Insufficient permissions.' });
            }

            req.user = { ...user, role };
            next();
        } catch (error) {
            console.error('Error checking permissions:', error);
            res.status(500).json({ error: 'Authorization check failed.' });
        }
    };
};


app.use(express.json())
// app.use(checkJwt);

app.locals.title = 'Stacks'

app.get("/", (req, res) => res.send("Express on Vercel"));
app.set('port', process.env.PORT);
if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
        console.log(`Listening on port: ${port}`)
        console.log(`Current environment: ${process.env.NODE_ENV}`)
    })
}

app.get('/api/v1/users/me', checkJwt, async (req, res) => {
    try {
        const email = getAuthEmail(req);
        if (!email) return res.status(400).json({ error: 'Authenticated email required.' });
        // Auto-provision on first authenticated request: the user exists in Auth0
        // but may not have a row here yet. Upsert on the unique email column so
        // concurrent first-login requests can't race into two rows for one email
        // (role defaults to 'user'; ADMIN_EMAILS still elevates via resolveRole below).
        await database('users')
            .insert({ email, username: email.split('@')[0], mystack: [] })
            .onConflict('email').ignore();
        const user = await database('users').where('email', email).first();
        res.status(200).json({ role: resolveRole(email, user.role) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Sort/filter choices and carousel-vs-grid view state, scoped to the
// authenticated user so they follow the user across devices/browsers.
// No row yet just means no preferences have been saved - default to {}
// rather than auto-provisioning on read.
app.get('/api/v1/users/me/preferences', checkJwt, async (req, res) => {
    try {
        const email = getAuthEmail(req);
        if (!email) return res.status(400).json({ error: 'Authenticated email required.' });
        const user = await database('users').where('email', email).first();
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const row = await database('user_preferences').where('user_id', user.id).first();
        res.status(200).json({ preferences: row?.preferences || {} });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Full replace of the preferences blob (not a merge) - the frontend sends its
// complete current state, so this stays a straightforward upsert.
app.put('/api/v1/users/me/preferences', checkJwt, async (req, res) => {
    try {
        const email = getAuthEmail(req);
        if (!email) return res.status(400).json({ error: 'Authenticated email required.' });
        const user = await database('users').where('email', email).first();
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const parsed = preferencesSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join(', ') });
        }

        const [row] = await database('user_preferences')
            .insert({ user_id: user.id, preferences: parsed.data })
            .onConflict('user_id')
            .merge({ preferences: parsed.data, updated_at: database.fn.now() })
            .returning('*');

        res.status(200).json({ preferences: row.preferences });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Columns clients are allowed to sort/filter by. Whitelisting prevents
// arbitrary req.query values from reaching .orderBy()/.where() as identifiers.
// releaseDate is intentionally omitted from SORTABLE: it's stored as a string
// (e.g. "September 12th, 1975"), so it would sort alphabetically, not by date.
// rollingStoneReview IS sortable: it's stored as asterisks ("*".."*****"), and
// because each rating is a prefix of the next, lexicographic order matches star
// count (asc = 1 star first, desc = 5 stars first).
const ALBUM_SORTABLE = ['albumName', 'artist', 'albumsSold', 'created_at', 'rollingStoneReview'];
// `genre` is handled separately via the album_genres join, not as a column filter.
const ALBUM_FILTERABLE = ['artist', 'label', 'isBandTogether'];
// Pagination is opt-in: only applied when `page` is a valid positive integer,
// so every existing caller that omits it keeps getting the full array.
const ALBUM_PAGE_SIZE_DEFAULT = 40;
const ALBUM_PAGE_SIZE_MAX = 100;

app.get('/albums', async (request, res) => {

    try {
        const { sortBy, order, search, genre, ...filters } = request.query;
        let query = database('albums');

        // Genre now lives in the join table. ?genre=Rock (single) and repeated
        // ?genre=Rock&genre=Pop (Express/qs already arrays repeated keys) are OR'd
        // together — an album matching any selected genre is included. Deliberately
        // NOT comma-split: several canonical genre names contain a literal comma
        // ("Folk, World, & Country"), so splitting on ',' shreds a single selected
        // genre into fragments that match nothing. The frontend always sends one
        // `genre` param per selection, never a comma-joined value. A subquery (not a
        // join on the outer query) so an album matching more than one selected genre
        // still comes back as a single row, with no DISTINCT needed.
        const genreList = [].concat(genre ?? [])
            .map(g => g.trim())
            .filter(Boolean);
        if (genreList.length) {
            query = query.whereIn('albums.id', function () {
                this.select('album_genres.album_id')
                    .from('album_genres')
                    .join('genres', 'genres.id', 'album_genres.genre_id')
                    .whereIn('genres.name', genreList);
            });
        }

        // Exact-match filters, e.g. ?artist=Pink Floyd
        for (const [key, value] of Object.entries(filters)) {
            if (ALBUM_FILTERABLE.includes(key)) {
                query = query.where(`albums.${key}`, value);
            }
        }

        // Case-insensitive free-text search across name + artist, e.g. ?search=floyd
        if (search) {
            query = query.where(builder =>
                builder.whereILike('albums.albumName', `%${search}%`)
                    .orWhereILike('albums.artist', `%${search}%`)
            );
        }

        // Sorting, e.g. ?sortBy=albumsSold&order=desc
        if (sortBy && ALBUM_SORTABLE.includes(sortBy)) {
            const dir = order === 'desc' ? 'desc' : 'asc';
            query = query.orderBy(`albums.${sortBy}`, dir);
        }

        // Pagination, e.g. ?page=2&limit=24. An absent/non-numeric/non-positive
        // page is treated as "no pagination requested", not an error, so the
        // response stays a full array for every caller that doesn't opt in.
        const rawPage = parseInt(request.query.page, 10);
        if (Number.isInteger(rawPage) && rawPage >= 1) {
            const rawLimit = parseInt(request.query.limit, 10);
            const limit = Math.min(Math.max(Number.isInteger(rawLimit) ? rawLimit : ALBUM_PAGE_SIZE_DEFAULT, 1), ALBUM_PAGE_SIZE_MAX);
            query = query.limit(limit).offset((rawPage - 1) * limit);
        }

        // Select album columns plus a per-row genres array from a correlated subquery
        // (its own `ag`/`g` aliases, scoped to the subquery) so every album carries its
        // full genre list in one round trip — independent of the `?genre=` filter above,
        // which only constrains *which* albums match, not what this returns.
        const albums = await query.select(
            'albums.*',
            database.raw(`(
                SELECT COALESCE(json_agg(json_build_object('name', g.name, 'isCanonical', g.is_canonical) ORDER BY g.name), '[]'::json)
                FROM album_genres ag
                JOIN genres g ON g.id = ag.genre_id
                WHERE ag.album_id = albums.id
            ) AS genres`)
        )
        res.status(200).json(albums)
    } catch (error) {
        console.error('Database error:', error)
        res.status(500).json({ error: error.message })
    }
});

app.get('/albums/:id', async (req, res) => {
    try {
        const albums = await database('albums').where('id', '=',
            req.params.id).select()
        if (albums.length) {
            albums[0].genres = await getAlbumGenres(req.params.id);
            res.status(200).json(albums)
        } else {
            res.status(400).json({
                error: `Could not find album with id ${req.params.id}`
            })
        }
    } catch (error) {
        console.error(`Error fetching album with id ${req.params.id}`, error)
        res.status(500).json({ error: error.message })
    }
});

// Genres that have at least one album, for filter/search UIs. Returns objects
// { name, isCanonical } so the client can segment the curated taxonomy from
// user-contributed genres. ?canonical=true narrows to the canonical set only.
app.get('/api/v1/genres', async (req, res) => {
    try {
        let query = database('genres')
            .join('album_genres', 'genres.id', 'album_genres.genre_id')
            .distinct('genres.name', 'genres.is_canonical')
            .orderBy('genres.name', 'asc');
        if (req.query.canonical === 'true') {
            query = query.where('genres.is_canonical', true);
        }
        const rows = await query.select();
        res.status(200).json(rows.map(r => ({ name: r.name, isCanonical: r.is_canonical })));
    } catch (error) {
        console.error('Error fetching genres:', error);
        res.status(500).json({ error: error.message });
    }
});

// Albums grouped by genre, capped to N per genre via a window function so the
// whole table is never loaded. Powers the per-genre carousels on the landing page.
// Distinct from /albums?genre=X (one genre per call): this returns every genre's
// top-N in a single request, with the cap enforced in SQL.
app.get('/api/v1/albums/by-genre', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    try {
        // Top-N albums per canonical genre, capped in SQL via a window over the
        // album_genres join. Restricted to is_canonical genres so user-contributed
        // genres never auto-promote into homepage carousels (they stay filterable via
        // /albums?genre=X). An album with multiple genres appears in each of its
        // canonical genre groups. `genre_name` is the canonical name; the row also
        // still carries the album's legacy `genre` string from albums.*.
        const ranked = await database
            .with('ranked', database.raw(
                `SELECT a.*, g.name AS genre_name,
                        ROW_NUMBER() OVER (PARTITION BY g.id ORDER BY a."albumName" ASC) AS rn
                 FROM albums a
                 JOIN album_genres ag ON ag.album_id = a.id
                 JOIN genres g ON g.id = ag.genre_id
                 WHERE g.is_canonical = true`))
            .select('*').from('ranked').where('rn', '<=', limit)
            .orderBy(['genre_name', 'albumName']);

        const byGenre = new Map();
        const grouped = [];
        for (const row of ranked) {
            const genreName = row.genre_name;
            if (!byGenre.has(genreName)) {
                const entry = { genre: genreName, albums: [] };
                byGenre.set(genreName, entry);
                grouped.push(entry);
            }
            delete row.rn;
            delete row.genre_name;
            byGenre.get(genreName).albums.push(row);
        }
        res.status(200).json(grouped);
    } catch (error) {
        console.error('Error fetching albums by genre:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/add-stack', checkJwt, requirePermission('create_album'), async (req, res) => {
    const result = albumSchema.safeParse(req.body)
    if (!result.success) {
        const message = result.error.issues
            .map(i => `${i.path.join('.')}: ${i.message}`)
            .join('; ')
        return res.status(400).json({ error: message })
    }
    try {
        // `genres` is a virtual field (no such column) — pull it out before insert.
        // A user submission carries genres[]; fall back to the single `genre` string.
        const { genres, ...albumData } = result.data;
        const genreNames = genres?.length ? genres : (albumData.genre ? [albumData.genre] : []);
        // Keep the legacy `genre` column populated for back-compat / human reference.
        if (!albumData.genre) albumData.genre = genreNames.map(canonicalizeName).join(', ');

        const postedAlbum = await database('albums')
            .insert({ ...albumData, id: randomUUID(), created_by: req.auth.sub })
            .returning('*')
        await setAlbumGenres(postedAlbum[0].id, genreNames)
        postedAlbum[0].genres = await getAlbumGenres(postedAlbum[0].id)
        res.status(201).json(postedAlbum[0])
    } catch (error) {
        console.error('Error posting your record :(', error)
        res.status(500).json({ error: error.message })
    }
});

// Daily Vercel cron target. Walks the Rolling Stone Top 500 in rank order, adds the
// lowest-ranked album not yet in the library — sourcing the editorial fields from
// Wikipedia via Claude. Credited to the kylemboomer@gmail.com user (CRON_AUTHOR_SUB).
// Up to MAX_ATTEMPTS candidates are tried per run so one bad article can't stall progress.
const CRON_IMPORT_MAX_ATTEMPTS = 3;

app.get('/api/cron/import-albums', async (req, res) => {
    // Vercel sends `Authorization: Bearer ${CRON_SECRET}` when CRON_SECRET is set.
    // This endpoint is publicly reachable (catch-all rewrite), so the check is required.
    const expected = `Bearer ${process.env.CRON_SECRET}`;
    if (!process.env.CRON_SECRET || req.headers.authorization !== expected) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!process.env.CRON_AUTHOR_SUB) {
        return res.status(500).json({ error: 'CRON_AUTHOR_SUB is not configured.' });
    }

    try {
        const list = loadAlbumList();

        // Build a set of existing album names (lowercased) to skip in one query.
        const existingRows = await database('albums').select('albumName');
        const existing = new Set(existingRows.map(r => r.albumName.toLowerCase()));

        const remaining = list.filter(a => !existing.has(a.albumName.toLowerCase()));
        if (remaining.length === 0) {
            return res.status(200).json({ done: true, message: 'All albums in the list are already imported.' });
        }

        const skipped = [];
        for (const candidate of remaining.slice(0, CRON_IMPORT_MAX_ATTEMPTS)) {
            const article = await fetchAlbumArticle(candidate);
            if (!article) {
                skipped.push({ rank: candidate.rank, albumName: candidate.albumName, reason: 'no Wikipedia article found' });
                continue;
            }

            const enriched = await enrichAlbum(candidate, article);
            const result = albumSchema.safeParse(enriched);
            if (!result.success) {
                const reason = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
                skipped.push({ rank: candidate.rank, albumName: candidate.albumName, reason });
                continue;
            }

            const [inserted] = await database('albums')
                .insert({ ...result.data, id: randomUUID(), created_by: process.env.CRON_AUTHOR_SUB })
                .returning('*');
            // Cron genre is one compound Discogs string — split it before linking.
            await setAlbumGenres(inserted.id, parseGenres(inserted.genre));
            return res.status(201).json({ added: inserted.albumName, rank: candidate.rank, skipped });
        }

        // Every attempted candidate failed — surface why so it can be investigated.
        console.error('cron import: no candidate succeeded this run', skipped);
        return res.status(200).json({ added: null, skipped });
    } catch (error) {
        console.error('cron import failed:', error);
        return res.status(500).json({ error: error.message });
    }
});

app.patch('/albums/:id', checkJwt, async (req, res) => {
    const albumId = req.params.id;
    const updates = req.body;
    try {
        const album = await database('albums').where('id', albumId).first();
        if (!album) {
            return res.status(404).json({ error: `Album with id ${albumId} not found.` });
        }

        const email = getAuthEmail(req);
        const user = await database('users')
            .where('email', email)
            .first();
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        // Resolve the effective role so ADMIN_EMAILS elevation applies here too (the
        // raw DB role is just the auto-created 'user' default). Identity for the
        // ownership check is the JWT sub, which lives under req.auth.payload.sub.
        const role = resolveRole(email, user.role);
        const allowed = canPerformAction(role, PERMISSIONS.EDIT_ALBUM, album.created_by, req.auth?.payload?.sub);
        if (!allowed) {
            return res.status(403).json({ error: 'Insufficient permissions.' });
        }

        // `genres` is virtual (no column) — keep it out of the column update and use
        // it to re-link instead. `genre` (single string) edits also re-sync the links.
        const { genres, ...columnUpdates } = updates;
        const updated = await database('albums')
            .where('id', albumId)
            .update({ ...columnUpdates, updated_at: new Date() })
            .returning('*');
        if (genres?.length) {
            await setAlbumGenres(albumId, genres);
        } else if (Object.prototype.hasOwnProperty.call(updates, 'genre')) {
            await setAlbumGenres(albumId, parseGenres(updated[0].genre));
        }
        updated[0].genres = await getAlbumGenres(albumId);
        res.status(200).json(updated[0]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/albums/:id', checkJwt, async (req, res) => {
    const albumId = req.params.id;
    try {
        const album = await database('albums').where('id', albumId).first();
        if (!album) {
            return res.status(404).json({ error: `Album with id ${albumId} not found.` });
        }

        const email = getAuthEmail(req);
        const user = await database('users')
            .where('email', email)
            .first();
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        // Resolve the effective role so ADMIN_EMAILS elevation applies here too (the
        // raw DB role is just the auto-created 'user' default). Identity for the
        // ownership check is the JWT sub, which lives under req.auth.payload.sub.
        const role = resolveRole(email, user.role);
        const allowed = canPerformAction(role, PERMISSIONS.DELETE_ALBUM, album.created_by, req.auth?.payload?.sub);
        if (!allowed) {
            return res.status(403).json({ error: 'Insufficient permissions.' });
        }

        const deletedRows = await database('albums').where('id', albumId).del();
        if (deletedRows) {
            res.status(204).send();
        } else {
            res.status(404).json({ error: `Album with id ${albumId} not found.` });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
})
app.get('/api/v1/users', checkJwt, requirePermission('manage_users'), async (req, res) => {
    try {
        const users = await database('users').select('*')
        if (!users.length) {
            res.status(200).json('No users found')
        }
        else {
            res.status(200).json(users)
        }

    }
    catch {
        res.status(500).json({ error: 'Could not fetch users' })
    }
})

app.post('/api/v1/users', checkJwt, async (req, res) => {
    try {
        const { name, email } = req.body;
        const inserted = await database('users')
            .insert({ email, username: name, mystack: [] })
            .onConflict('email').ignore()
            .returning('id');

        res.status(201).json(inserted.length ? 'User seeded' : 'User already seeded')
    }
    catch {
        res.status(500).json({ error: 'Could not add new user' })
    }
})

app.patch('/api/v1/users/:id/role', checkJwt, requirePermission('manage_users'), async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    const validRoles = Object.values(USER_ROLES);
    if (!role || !validRoles.includes(role)) {
        return res.status(400).json({ error: `Role must be one of: ${validRoles.join(', ')}` });
    }
    try {
        const updated = await database('users')
            .where('id', id)
            .update({ role })
            .returning('*');
        if (!updated.length) {
            return res.status(404).json({ error: `User with id ${id} not found.` });
        }
        res.status(200).json(updated[0]);
    } catch {
        res.status(500).json({ error: 'Could not update user role.' });
    }
})

//post route for users table adding an album to mystacks
// The user is always the JWT's verified identity (resolved into req.user by
// requirePermission). Any `email` the client still sends in the body is ignored —
// trusting it would let a caller edit someone else's stack.
app.patch('/api/v1/stacks', checkJwt, requirePermission('create_album'), async (req, res) => {
    try {
        const { newAlbum } = req.body;
        const userID = req.user.id
        const foundRecord = (req.user.mystack ?? []).find(album => album.id === newAlbum.id)
        if (!foundRecord) {
            await database('users')
                .where('id', userID)
                .update({
                    mystack: database.raw('array_append(mystack, ?::jsonb)', [JSON.stringify(newAlbum)])
                })
                .returning('*');
            res.status(201).json('Album added to stack')
        }
        else {
            res.status(200).json('Album already in stack')
        }
    }
    catch (error) {
        console.error('Error updating stack:', error);
        res.status(500).json({ error: 'Could not add album to stack' })
    }
})

// Identity comes from the JWT, never the body (see the add route above).
app.patch('/api/v1/stacks/delete', checkJwt, async (req, res) => {
    try {
        const email = getAuthEmail(req);
        if (!email) return res.status(401).json({ error: 'Authenticated email required.' });
        const { albumToDelete } = req.body;
        const user = await database('users').select('*').where('email', '=', email)
        if (!user.length) return res.status(404).json({ error: 'User not found.' });
        const userID = user[0].id
        const foundRecord = user[0].mystack.find(album => album.id === albumToDelete.id)
        if (foundRecord) {
            const updatedUser = await database('users')
                .where('id', userID)
                .update({
                    mystack: database.raw('array_remove(mystack, ?::jsonb)', [JSON.stringify(albumToDelete)])
                })
                .returning('*');
            res.status(201).json({ message: 'Album removed from stack', user: updatedUser[0] })
        }
        else {
            res.status(404).json({ message: 'Album not found in stack' })
        }
    }
    catch (error) {
        console.error('Error updating stack:', error);
        res.status(500).json({ error: 'Could not remove album to stack' })
    }
})

// Persists a manual (drag-and-drop) reorder. `order` may be only the ids the
// client has loaded; see api/stackOrder.js for the subset semantics.
app.patch('/api/v1/stacks/reorder', checkJwt, async (req, res) => {
    try {
        const email = getAuthEmail(req);
        if (!email) return res.status(401).json({ error: 'Authenticated email required.' });

        const parsed = reorderSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join(', ') });
        }

        // Read-modify-write under a row lock so concurrent reorders/adds/deletes
        // can't overwrite each other.
        const result = await database.transaction(async (trx) => {
            const user = await trx('users').where('email', email).forUpdate().first();
            if (!user) return { status: 404, body: { error: 'User not found.' } };

            const { stack, missing } = applyStackOrder(user.mystack ?? [], parsed.data.order);
            if (missing) {
                return { status: 409, body: { error: 'Some albums are no longer in your stack.', missing } };
            }

            const [updated] = await trx('users')
                .where('id', user.id)
                .update({ mystack: stack })
                .returning('mystack');
            return { status: 200, body: { user: { mystack: updated.mystack } } };
        });
        res.status(result.status).json(result.body);
    }
    catch (error) {
        console.error('Error reordering stack:', error);
        res.status(500).json({ error: 'Could not reorder stack' })
    }
})

app.get('/api/v1/stacks', checkJwt, async (req, res) => {
    try {
        const email = getAuthEmail(req);
        const { search, genre, sortBy, order, page, limit } = req.query;
        const hasFilterParams = search || genre || sortBy || order || page || limit;

        const rows = await database('users').where('email', email).select('mystack');

        if (!hasFilterParams) {
            // Unchanged legacy behavior/shape/status - App.js's initial preload and
            // mystack_spec.cy.js / recordpage_spec.cy.js fixtures (frontend repo)
            // depend on this exact [{ mystack: [...] }] / 201 contract.
            if (!rows.length) return res.status(201).json('No stack to display');
            return res.status(201).json(rows);
        }

        const items = filterStackItems(rows[0]?.mystack ?? [], {
            search, genre, sortBy, order, page, limit,
            pageSizeDefault: ALBUM_PAGE_SIZE_DEFAULT,
            pageSizeMax: ALBUM_PAGE_SIZE_MAX,
        });
        res.status(200).json(items);
    }
    catch (error) {
        console.error('Error fetching stack:', error);
        res.status(500).json({ error: 'Could not get user stack' })
    }
})

module.exports = app