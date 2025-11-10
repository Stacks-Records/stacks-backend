exports.up = function (knex) {
    return Promise.all([
        //Add role to users table
        knex.schema.table('users', function (table) {
            table.string('role').defaultTo('user');
            table.timestamp('created_at').defaultTo(knex.fn.now());
            table.timestamp('updated_at').defaultTo()
        }),

        knex.schema.table('albums', function (table) {
            table.string('created_by'); // Will store Auth0 userId 
            table.timestamp('created_at').defaultTo(knex.fn.now());
            table.timestamp('updated_at').defaultTo(knex.fn.now());
        })
    ])
};

exports.down = function (knex) {
    return Promise.all([
        knex.schema.table('users', function (table) {
            table.dropColumn('role');
            table.dropColumn('created_at');
            table.dropColumn('updated_at');
        }),

        knex.schema.table('albums', function (table) {
            table.dropColumn('created_by');
            table.dropColumn('created_at');
            table.dropColumn('updated_at');
        })
    ]);
};