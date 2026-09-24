// Per-user UI state (sort/filter choices, grid vs carousel view) that should
// follow the user across devices, backed by the same Auth0-authenticated
// `users` row used everywhere else. Kept in its own table rather than a
// column on `users` (cf. the `mystack` jsonb[] column) so auth/role concerns
// stay separate from user-generated settings, and stored as a single jsonb
// blob rather than discrete columns since the set of preference keys is
// owned by the frontend and will keep changing; the API only enforces
// size/shape, not specific keys (see preferencesSchema in lib/validation.js).

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
    return knex.schema.createTable('user_preferences', (table) => {
        table.increments('id').primary();
        table.integer('user_id').notNullable().unique()
            .references('id').inTable('users').onDelete('CASCADE');
        table.jsonb('preferences').notNullable().defaultTo('{}');
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.timestamp('updated_at').defaultTo(knex.fn.now());
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
    return knex.schema.dropTableIfExists('user_preferences');
};
