// Loads the curated source list — Rolling Stone's "500 Greatest Albums of All Time".
//
// You provide the CSV. Expected location: data/rolling-stone-top-500.csv (override
// with the ALBUM_LIST_CSV env var). Expected header columns (case-insensitive):
//
//     rank,albumName,artist,genre
//
// These three fields (albumName, artist, genre) are treated as authoritative — the
// Wikipedia/Claude enrichment step only fills in the remaining schema fields. The
// cron walks the list in rank order, so rank drives "work 1 -> 500".

const fs = require('node:fs');
const path = require('node:path');

const CSV_PATH = process.env.ALBUM_LIST_CSV ||
    path.resolve(__dirname, '../data/rolling-stone-top-500.csv');

// Minimal RFC-4180 parser: handles quoted fields, embedded commas/quotes/newlines.
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
                else inQuotes = false;
            } else field += c;
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ',') {
            row.push(field); field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++; // swallow CRLF
            row.push(field); field = '';
            if (row.some((v) => v.trim() !== '')) rows.push(row);
            row = [];
        } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); if (row.some((v) => v.trim() !== '')) rows.push(row); }
    return rows;
}

// Maps flexible header names to our canonical keys.
const HEADER_ALIASES = {
    rank: ['rank', 'position', '#', 'no'],
    albumName: ['albumname', 'album', 'title'],
    artist: ['artist', 'artists', 'band'],
    genre: ['genre', 'genres'],
};

function resolveColumns(header) {
    const norm = header.map((h) => h.replace(/^﻿/, '').trim().toLowerCase());
    const idx = {};
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
        idx[key] = norm.findIndex((h) => aliases.includes(h));
    }
    return idx;
}

function loadAlbumList() {
    if (!fs.existsSync(CSV_PATH)) {
        throw new Error(
            `Album list CSV not found at ${CSV_PATH}. Add the Rolling Stone Top 500 ` +
            `CSV there (columns: rank,albumName,artist,genre) or set ALBUM_LIST_CSV.`
        );
    }
    const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
    if (rows.length < 2) throw new Error(`Album list CSV at ${CSV_PATH} has no data rows.`);

    const idx = resolveColumns(rows[0]);
    for (const key of ['albumName', 'artist']) {
        if (idx[key] === -1) throw new Error(`Album list CSV missing required "${key}" column.`);
    }

    const list = rows.slice(1).map((r, i) => ({
        rank: idx.rank !== -1 && r[idx.rank]?.trim() ? Number(r[idx.rank].trim()) : i + 1,
        albumName: r[idx.albumName]?.trim() ?? '',
        artist: r[idx.artist]?.trim() ?? '',
        genre: idx.genre !== -1 ? (r[idx.genre]?.trim() ?? '') : '',
    })).filter((a) => a.albumName && a.artist);

    return list.sort((a, b) => a.rank - b.rank);
}

module.exports = { loadAlbumList, CSV_PATH };

// Standalone runner for local verification: `node api/albumList.js`
if (require.main === module) {
    const list = loadAlbumList();
    console.log(`Loaded ${list.length} albums. First 3:`);
    console.log(list.slice(0, 3));
}
