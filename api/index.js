const express = require('express');
const app = express();
const cors = require('cors');
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

const configuration = require('../knexfile.js')[process.env.NODE_ENV || 'development']
const database = require('knex')(configuration);
const { auth } = require('express-oauth2-jwt-bearer');
const { hasPermission, canPerformAction, PERMISSIONS, USER_ROLES, resolveRole } = require('./permissions');
const { albumSchema } = require('./validation');
const { randomUUID } = require('node:crypto');
const { loadAlbumList } = require('./albumList');
const { fetchAlbumArticle } = require('./wikipedia');
const { enrichAlbum } = require('./enrich');
const { parseGenres, canonicalizeName, genreSlug } = require('./genres');

// Sets an album's genres from a list of already-discrete genre names and (re)writes
// the album_genres links. This is the create-or-attach core: each name is normalized
// and matched by slug to an existing genre, or inserted as a NEW user-contributed
// genre (is_canonical defaults to false). Idempotent — it clears the album's existing
// links and inserts the current set, so it's safe on both create and update.
//
// Callers supply discrete names: user submissions pass their genres[] array (one
// genre per element); the cron passes parseGenres(rawString) to split the compound
// Discogs CSV string first. Never run a compound string through here directly.
const setAlbumGenres = async (albumId, names) => {
    // Normalize + dedupe by slug so "Shoegaze"/"shoegaze" collapse to one genre.
    const bySlug = new Map();
    for (const raw of names || []) {
        const slug = genreSlug(raw);
        if (slug && !bySlug.has(slug)) bySlug.set(slug, canonicalizeName(raw));
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

const port = process.env.PORT || 3001

const checkJwt = auth({
    audience: process.env.AUDIENCE,
    issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
});

// Identity comes from the verified JWT, never a client-supplied header — a header
// can be spoofed to any value, which would let any valid token claim an admin
// email. The header is only a last-resort fallback for tokens lacking the claim.
const getAuthEmail = (req) => req.auth?.payload?.email || req.auth?.email || req.headers.email;

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
        // but may not have a row here yet. Create one (role defaults to 'user');
        // ADMIN_EMAILS still elevates via resolveRole below.
        let user = await database('users').where('email', email).first();
        if (!user) {
            [user] = await database('users')
                .insert({ email, username: email.split('@')[0], mystack: [] })
                .returning('*');
        }
        res.status(200).json({ role: resolveRole(email, user.role) });
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

app.get('/albums', async (request, res) => {

    try {
        const { sortBy, order, search, genre, ...filters } = request.query;
        let query = database('albums');

        // Genre now lives in the join table, so ?genre=Rock filters via album_genres
        // against the canonical genre name. Columns are qualified because the join
        // brings ambiguous names (genres.name etc.) into scope.
        if (genre) {
            query = query
                .join('album_genres', 'albums.id', 'album_genres.album_id')
                .join('genres', 'genres.id', 'album_genres.genre_id')
                .where('genres.name', genre);
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

        // Select only album columns so the join tables don't leak into the response.
        const albums = await query.select('albums.*')
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
            await setAlbumGenres(albumId, updated[0].genre ? [updated[0].genre] : []);
        }
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
    catch (error) {
        res.status(500).json({ error: 'Could not fetch users' })
    }
})

app.post('/api/v1/users', checkJwt, async (req, res) => {
    try {
        const { name, email } = req.body;
        const users = await database('users').select('*')
        const foundUser = users.find(user => {
            return user.email === email
        })
        if (foundUser === undefined) {
            const user = { name, email }
            await database('users').insert({ email: email, username: name, mystack: [] });

            res.status(201).json('User seeded')
        }
        else {
            res.status(201).json('User already seeded')
        }
    }
    catch (error) {
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
    } catch (error) {
        res.status(500).json({ error: 'Could not update user role.' });
    }
})

//post route for users table adding an album to mystacks

app.patch('/api/v1/stacks', checkJwt, requirePermission('create_album'), async (req, res) => {
    try {
        const { email, newAlbum } = req.body;
        const user = await database('users').select('*').where('email', '=', email)
        const userID = user[0].id
        const foundRecord = user[0].mystack.find(album => album.id === newAlbum.id)
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

// app.patch('/api/v1/stacks/:userId', checkJwt, async (req, res) => {
//     try {
//         const { userId } = req.params
//         const { albumId } = req.body
//         if(!userId || !albumId) {
//             res.status(400).json('User ID or Album ID not found.') 
//         }
//         const newAlbum = await database('user_albums').where('userId', '=', userId).select('*')
//             .update({
//                 albumId: database.raw('array_append(albumId, ?::text)', [JSON.stringify(albumId)])
//             })
//           res.status(201).json({ message:'Album added to stack!', id: newAlbum })
//     }
//     catch(err) {
//         console.error('Error updating stack:', err)
//         res.status(500).json({error: 'Could not add album due to internal error.'})
//     }
// })
app.patch('/api/v1/stacks/delete', checkJwt, async (req, res) => {
    try {
        const { email, albumToDelete } = req.body;
        const user = await database('users').select('*').where('email', '=', email)
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

app.get('/api/v1/stacks', checkJwt, async (req, res) => {
    try {
        const email = getAuthEmail(req);
        const albums = await database('users').where('email', email).select('mystack')
        if (!albums.length) {
            res.status(201).json('No stack to display')
        }
        else {
            res.status(201).json(albums)
        }
    }
    catch (error) {
        res.status(500).json({ error: 'Could not get user stack' })
    }
})

module.exports = app