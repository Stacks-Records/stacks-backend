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
    // Genre may arrive two ways: a single string (cron's compound Discogs value) or
    // a genres[] array (user multi-select). Both optional here; the refine below
    // requires at least one. Array entries are capped to curb sprawl/abuse.
    genre: z.string().min(1).optional(),
    genres: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
    label: z.string().min(1, 'label is required'),
    bandMembers: z.array(z.string().min(1)).min(1, 'bandMembers is required'),
    isBandTogether: z.boolean(),
    rollingStoneReview: z.string().min(1, 'rollingStoneReview is required'),
    albumsSold: z.number().int().nonnegative(),
    youTubeAlbumURL: z.string()
        .refine(isHttpURL, 'youTubeAlbumURL must be a valid URL')
        .refine(isYouTubeURL, 'youTubeAlbumURL must be a YouTube link'),
    imgURL: z.string().refine(isHttpURL, 'imgURL must be a valid http(s) URL'),
}).refine(
    (data) => Boolean(data.genre) || (data.genres?.length ?? 0) > 0,
    { message: 'at least one genre is required (genre or genres[])', path: ['genre'] }
);

module.exports = { albumSchema };
