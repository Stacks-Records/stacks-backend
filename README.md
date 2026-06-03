# Stacks API

The back-end REST API for Stacks — an album collection app. Built with Express
and PostgreSQL (via Knex), secured with Auth0 JWTs and role-based permissions,
and deployed as a Vercel serverless function.

## Back-End Installation

1. Clone the repository with `git clone https://github.com/Stacks-Records/stacks-be.git`
2. cd into the repository
3. Run `npm install`

## Database Setup

1. Install knex globally by running `npm install knex -g` and then run `npm install knex --save` to use `knex` CLI commands
2. Install pg module `npm install pg --save` to connect to PostgreSQL
3. In the root directory, open `knexfile.js` and configure your environment connection.
   The `development` config currently points at `localhost:5433` with a hard-coded
   password — update these to match your local Postgres (and consider moving the
   credentials into environment variables).
4. To migrate and seed data, run `knex migrate:latest && knex seed:run`, or simply
   `npm run dev` which runs both for you.

## Environment Variables

Create a `.env` file in the **project root** (the server loads it via `../.env`
relative to `api/`). The app reads the following:

| Variable | Used by | Description |
| --- | --- | --- |
| `AUDIENCE` | Auth0 JWT | API identifier configured in Auth0 |
| `AUTH0_ISSUER_BASE_URL` | Auth0 JWT | Your Auth0 tenant issuer URL |
| `POSTGRES_URL` | `production` knex config | Postgres connection string |
| `DATABASE_URL` | `staging` knex config | Postgres connection string |
| `PORT` | local server | Port to listen on (defaults to `3001`) |
| `NODE_ENV` | knex / server | `development`, `staging`, or `production` |

> Note: in `production` the server does **not** call `app.listen` — it runs as a
> Vercel serverless function (see [Deployment](#deployment)).

## Running Local Server

1. Make sure `NODE_ENV` is set to `development` (or unset) so the server starts a listener.
2. Run `npm start` from the project root to start the server (`api/index.js`).
3. The server listens on `PORT` (default `3001`).

## Technologies Used

- **Express.js** — web framework
- **PostgreSQL** + **Knex.js** — database and query builder / migrations
- **Auth0** (`express-oauth2-jwt-bearer`) — JWT authentication
- **Zod** — request body validation
- **cors** — cross-origin requests
- **Vercel** — serverless deployment / hosting

## Authentication & Permissions

Most write endpoints require an Auth0 **Bearer token** (`Authorization` header)
and an `Email` header identifying the user. Access is governed by a role-based
permission model (`api/permissions.js`):

| Role | view | create | edit | delete | manage users |
| --- | :---: | :---: | :---: | :---: | :---: |
| `admin` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `moderator` | ✅ | ✅ | ✅ | ✅ | |
| `user` | ✅ | ✅ | ✅* | | |

\* A `user` may only edit/delete albums they created (ownership is enforced);
`admin` and `moderator` may edit/delete any album.

## Endpoints

### Albums

#### Get All Albums
- **Endpoint**: `/albums`
- **Method**: `GET`
- **Description**: Get all albums.

#### Get One Album
- **Endpoint**: `/albums/:id`
- **Method**: `GET`
- **Description**: Get a single album by id.

#### Get Genres
- **Endpoint**: `/api/v1/genres`
- **Method**: `GET`
- **Description**: Get the distinct list of album genres.

#### Add Album
- **Endpoint**: `/add-stack`
- **Method**: `POST`
- **Auth**: Bearer token, requires `create_album` permission.
- **Description**: Add a new album to the collection. The request body is validated
  with Zod and must include: `albumName`, `artist`, `releaseDate`, `genre`, `label`,
  `bandMembers` (array of strings), `isBandTogether` (boolean), `rollingStoneReview`,
  `albumsSold` (non-negative integer), `youTubeAlbumURL` (valid YouTube URL), and
  `imgURL` (valid http(s) URL).

#### Update Album
- **Endpoint**: `/albums/:id`
- **Method**: `PATCH`
- **Auth**: Bearer token; `admin`/`moderator` may edit any album, a `user` only their own.
- **Description**: Update an existing album.

#### Delete Album
- **Endpoint**: `/albums/:id`
- **Method**: `DELETE`
- **Auth**: Bearer token; `admin`/`moderator` may delete any album, a `user` only their own.
- **Description**: Delete an album. Returns `204 No Content` on success.

### Users

#### Get Current User Role
- **Endpoint**: `/api/v1/users/me`
- **Method**: `GET`
- **Auth**: Bearer token + `Email` header.
- **Description**: Get the role of the currently authenticated user.

#### Get Users
- **Endpoint**: `/api/v1/users`
- **Method**: `GET`
- **Auth**: Bearer token, requires `manage_users` permission.
- **Description**: Get all users in the database.

#### Create User
- **Endpoint**: `/api/v1/users`
- **Method**: `POST`
- **Auth**: Bearer token.
- **Description**: Adds a user to the database if the user doesn't already exist.

#### Update User Role
- **Endpoint**: `/api/v1/users/:id/role`
- **Method**: `PATCH`
- **Auth**: Bearer token, requires `manage_users` permission.
- **Description**: Update a user's role. Body: `{ "role": "admin" | "moderator" | "user" }`.

### User Stacks

#### Add to User Stack
- **Endpoint**: `/api/v1/stacks`
- **Method**: `PATCH`
- **Auth**: Bearer token, requires `create_album` permission.
- **Description**: Adds a favorited album to the user's stack. Body: `{ email, newAlbum }`.

#### Delete from User Stack
- **Endpoint**: `/api/v1/stacks/delete`
- **Method**: `PATCH`
- **Auth**: Bearer token.
- **Description**: Remove a favorited album from the user's stack. Body: `{ email, albumToDelete }`.

#### Get User Stack
- **Endpoint**: `/api/v1/stacks`
- **Method**: `GET`
- **Auth**: Bearer token + `Email` header.
- **Description**: Get the user's favorited albums.

### Health Check

#### Root
- **Endpoint**: `/`
- **Method**: `GET`
- **Description**: Returns `Express on Vercel` — a simple health check.

## Deployment

The API is deployed to **Vercel** as a serverless function. `vercel.json` rewrites
all incoming routes to `/api`, which resolves to `api/index.js`. In production the
app exports the Express instance instead of calling `app.listen`.

## Contributors

- **Peter Kim**
 [LinkedIn](https://www.linkedin.com/in/pk-2403fee) | [GitHub](https://www.github.com/peterkimpk1)
- **Kyle Boomer**
 [LinkedIn](https://www.linkedin.com/in/kylemboomer) | [GitHub](https://www.github.com/kylemboomer)
- **Adam Konber**
 [LinkedIn](https://www.linkedin.com/in/adam-konber) | [GitHub](https://www.github.com/Sterling47)
