# Stacks API

## Back-End Installation

1. Clone the repository with `git clone https://github.com/Stacks-Records/stacks-be.git`
2. cd into the repository
3. Run `npm install`

## Database Setup
1. Install knex globally by running `npm install knex -g` and then run `npm install knex --save` to use `knex` CLI commands
2. Install pg module `npm install pg --save` to connect to PostgreSQL
3. In the root directory, navigate to `knexfile.js` and configure your environment connection
4. To migrate and seed data, run `knex migrate:latest && knex seed:run`

## Running Local Server

1. Navigate to `/api` folder from the root directory
2. Run `node index.js` to start the server

## Technologies Used

- Express.js, PostgreSQL, Knex.js, Auth0

## Endpoints

### 1. **Get All Albums**

- **Endpoint**: `/albums`
- **Method**: `GET`
- **Description**: Get all albums
  
### 2. **Get One Album**

- **Endpoint**: `/albums/:id`
- **Method**: `GET`
- **Description**: Get a single album using the album id

### 3. **Add Stack**

- **Endpoint**: `/add-stack`
- **Method**: `POST`
- **Description**: Add a new album to the album collection

### 4. **Get Users**

- **Endpoint**: `/api/v1/users`
- **Method**: `GET`
- **Description**: Get all users in the database

### 5. **Create User**

- **Endpoint**: `/api/v1/users`
- **Method**: `POST`
- **Description**: Adds a user to the database if the user doesn't already exist
  
### 6. **Add to User Stack**

- **Endpoint**: `/api/v1/stacks`
- **Method**: `PATCH`
- **Description**: Adds a user's favorited album to the user's table

### 7. **Delete from User Stack**

- **Endpoint**: `/api/v1/stacks/delete`
- **Method**: `PATCH`
- **Description**: Delete a user's favorited album from the user's table

### 8. **Get User Stack**

- **Endpoint**: `/api/v1/stacks`
- **Method**: `GET`
- **Description**: Get the user's favorited albums

## Contributors

- **Peter Kim**
 [LinkedIn](https://www.linkedin.com/in/pk-2403fee) | [GitHub](https://www.github.com/peterkimpk1)
- **Kyle Boomer**
 [LinkedIn](https://www.linkedin.com/in/kylemboomer) | [GitHub](https://www.github.com/kylemboomer)
- **Adam Konber**
 [LinkedIn](https://www.linkedin.com/in/adam-konber) | [GitHub](https://www.github.com/Sterling47)
