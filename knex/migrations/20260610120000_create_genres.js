// Normalizes genre from a free-text column on `albums` into a first-class entity
// with a many-to-many link, so the landing page can drive carousels off a finite,
// canonical genre set instead of the ever-growing tangle of raw genre strings the
// daily cron produces (e.g. "Electronic, Rock", "Folk, World, & Country").
//
// Three steps, in order:
//   1. Ensure albums.id is uniquely constrained (it was created as a bare string),
//      so album_genres.album_id can reference it.
//   2. Create `genres` and the `album_genres` join table.
//   3. Seed the canonical genres and backfill links by parsing each album's existing
//      genre string. The legacy albums.genre column is left in place as the source
//      of truth for re-runs and as a fallback; it is no longer read by the app.

const { CANONICAL_GENRES, parseGenres, genreSlug } = require('../../api/genres');

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
    // 1. albums.id needs a unique constraint to be referenceable by a FK. It was
    //    created as a plain string column with no key. Use a unique index (named so
    //    the down migration can drop it) rather than a PK to avoid clashing with any
    //    implicit key Postgres/knex may have added.
    const hasUnique = await knex.raw(
        `SELECT 1 FROM pg_constraint WHERE conname = 'albums_id_unique'`
    );
    if (hasUnique.rows.length === 0) {
        await knex.schema.alterTable('albums', (table) => {
            table.unique(['id'], { indexName: 'albums_id_unique' });
        });
    }

    // 2. Canonical genres, and the album↔genre join.
    await knex.schema.createTable('genres', (table) => {
        table.increments('id').primary();
        table.string('name').notNullable().unique();
        // Case-insensitive dedupe key (lowercased, alias-resolved). User-submitted
        // spellings fold onto an existing genre when their slug already exists.
        table.string('slug').notNullable().unique();
        // Distinguishes the curated Top-500 taxonomy from genres users contribute.
        // Only canonical genres drive landing-page carousels; user genres stay
        // filterable/searchable. Defaults to false so user inserts are user genres.
        table.boolean('is_canonical').notNullable().defaultTo(false);
        table.timestamp('created_at').defaultTo(knex.fn.now());
    });

    await knex.schema.createTable('album_genres', (table) => {
        table.string('album_id').notNullable()
            .references('id').inTable('albums').onDelete('CASCADE');
        table.integer('genre_id').notNullable()
            .references('id').inTable('genres').onDelete('CASCADE');
        table.primary(['album_id', 'genre_id']);
        // The landing page queries "albums in genre X", so index the genre side.
        table.index('genre_id', 'album_genres_genre_id_index');
    });

    // 3a. Seed the canonical genre rows (flagged canonical, with their slug) and
    //     build a name -> id map for the backfill.
    const inserted = await knex('genres')
        .insert(CANONICAL_GENRES.map((name) => ({ name, slug: genreSlug(name), is_canonical: true })))
        .returning(['id', 'name']);
    const idByName = new Map(inserted.map((g) => [g.name, g.id]));

    // 3b. Backfill links from each album's existing genre string.
    const albums = await knex('albums').select('id', 'genre');
    const links = [];
    for (const album of albums) {
        for (const canonical of parseGenres(album.genre)) {
            const genreId = idByName.get(canonical);
            if (genreId) links.push({ album_id: album.id, genre_id: genreId });
        }
    }
    if (links.length) {
        await knex('album_genres').insert(links).onConflict(['album_id', 'genre_id']).ignore();
    }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
    await knex.schema.dropTableIfExists('album_genres');
    await knex.schema.dropTableIfExists('genres');
    await knex.schema.alterTable('albums', (table) => {
        table.dropUnique(['id'], 'albums_id_unique');
    });
};
