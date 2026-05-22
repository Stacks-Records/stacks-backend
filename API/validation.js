const { z } = require('zod');

const isHttpURL = (value) => {
    try {
        const u = new URL(value);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
};

const isYouTubeURL = (value) => {
    try {
        const { hostname, protocol } = new URL(value);
        if (protocol !== 'http:' && protocol !== 'https:') return false;
        return /(^|\.)(youtube\.com|youtu\.be)$/.test(hostname);
    } catch {
        return false;
    }
};

const albumSchema = z.object({
    albumName: z.string().min(1, 'albumName is required'),
    artist: z.string().min(1, 'artist is required'),
    releaseDate: z.string().min(1, 'releaseDate is required'),
    genre: z.string().min(1, 'genre is required'),
    label: z.string().min(1, 'label is required'),
    bandMembers: z.array(z.string().min(1)).min(1, 'bandMembers is required'),
    isBandTogether: z.boolean(),
    rollingStoneReview: z.string().min(1, 'rollingStoneReview is required'),
    albumsSold: z.number().int().nonnegative(),
    youTubeAlbumURL: z.string()
        .refine(isHttpURL, 'youTubeAlbumURL must be a valid URL')
        .refine(isYouTubeURL, 'youTubeAlbumURL must be a YouTube link'),
    imgURL: z.string().refine(isHttpURL, 'imgURL must be a valid http(s) URL'),
});

module.exports = { albumSchema };
