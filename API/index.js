const express = require('express');
const app = express();
const cors = require('cors');
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

const configuration = require('../knexfile.js')[process.env.NODE_ENV|| 'development']
const database = require('knex')(configuration);
const { auth } = require('express-oauth2-jwt-bearer');

database.on('query', queryData => {
    console.log('SQL:', queryData.sql);
    console.log('Bindings:', queryData.bindings); // Optional: logs bindings too
});
app.use(cors({
    origin:'*',
    methods:['GET', 'POST', 'DELETE', 'PUT', 'PATCH'],
    allowedHeaders: ['Content-Type','Authorization','Email'],
    credential: true
}))

const port = process.env.PORT || 3001

const checkJwt = auth({
    audience: process.env.AUDIENCE,
    issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
  });
  
app.use(express.json())
// app.use(checkJwt);

app.locals.title = 'Stacks'

app.get("/", (req, res) => res.send("Express on Vercel"));
app.set('port', process.env.PORT);
app.listen(port, () => {
    console.log(`Listening on port: ${port}`)
    console.log(`Current environment: ${process.env.NODE_ENV}`)
})

app.get('/albums', async (request, res) => {

    try {
        const albums = await database('albums').select()
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

app.post('/add-stack', async (req, res) => {
    const newAlbum = req.body
    if (!newAlbum || !Object.keys(newAlbum).length) {
        return res.status(400).send({message: 'Invalid album data.'})
    }
    try {
        const postedAlbum = await database('albums').insert(newAlbum).returning('*')
        res.status(201).json(postedAlbum[0])
    } catch(error) {
        console.error('Error posting your record :(', error)
        res.status(500).json({error: error.message})
    }
});

app.delete('/albums/:id', async (req, res) => {
    const albumId = req.params.id;
    try {
        const deletedRows = await database('albums').where('id', '=', albumId).del()
        if (deletedRows) {
            res.status(204).send()
        } else {
            res.status(404).json({ error: `Album with id ${albumId} not found.` })
        }
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})
app.get('/api/v1/users', async (req, res)=> {
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
        res.status(500).json({error:'Could not fetch users'})
    }
})

app.post('/api/v1/users', checkJwt, async (req,res) => {
    try {
        const { name, email} = req.body;
        const users = await database('users').select('*')
        const foundUser = users.find(user => {
            return user.email === email
        })
        if (foundUser === undefined) {
            const user = {name, email}
            await database('users').insert({email: email, username: name, mystack: []});

            res.status(201).json('User seeded')
        }
        else {
            res.status(201).json('User already seeded')
        }
    }
    catch (error) {
        res.status(500).json({error: 'Could not add new user'})
    }
})

//post route for users table adding an album to mystacks

app.patch('/api/v1/stacks', checkJwt, async (req,res) => {
    try {
        const {email, newAlbum} = req.body;
        const user = await database('users').select('*').where('email','=',email)
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
        res.status(500).json({error: 'Could not add album to stack'})
    }
})
app.patch('/api/v1/stacks/delete', async (req,res) => {
    try {
        const {email, albumToDelete} = req.body;
        const user = await database('users').select('*').where('email','=',email)
        const userID = user[0].id
        const foundRecord = user[0].mystack.find(album => album.id === albumToDelete.id)
        if (foundRecord) {
            const updatedUser = await database('users')
            .where('id', userID)
            .update({
                mystack: database.raw('array_remove(mystack, ?::jsonb)', [JSON.stringify(albumToDelete)])
            })
            .returning('*');
            res.status(201).json({message: 'Album removed from stack', user: updatedUser[0]})
        }
        else {
            res.status(404).json({message: 'Album not found in stack'})
        }
    }
    catch (error) {
        console.error('Error updating stack:', error);
        res.status(500).json({error: 'Could not remove album to stack'})
    }
})

app.get('/api/v1/stacks', async (req,res) => {
    try {
        const email = req.headers.email;
        const albums = await database('users').where('email',email).select('mystack')
        if (!albums.length) {
            res.status(201).json('No stack to display')
        }
        else {
            res.status(201).json(albums)
        }
    }
    catch (error) {
        res.status(500).json({error: 'Could not get user stack'})
    }
})

module.exports = app