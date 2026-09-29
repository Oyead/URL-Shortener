import express from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { createClient } from 'redis';

const app = express();
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/urlshortener';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '86400', 10); // 24h

mongoose
  .connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.error('MongoDB connection error:', err));

// Redis is a cache, not a hard dependency: if it never connects the app still
// serves requests straight from MongoDB. The 'error' listener is mandatory --
// node-redis rethrows unhandled error events and kills the process without it.
const redis = createClient({
  url: REDIS_URL,
  // Fail fast instead of queueing: without this, commands issued while Redis
  // is unreachable return a promise that never settles and requests hang.
  disableOfflineQueue: true,
});

redis.on('error', (err) => console.error('Redis error:', err.message));

redis
  .connect()
  .then(() => console.log('Connected to Redis'))
  .catch((err) => console.error('Redis connection error:', err.message));

const urlSchema = new mongoose.Schema({
  // Indexed so the dedupe lookup in POST /api/shorten is not a full scan.
  originalUrl: { type: String, required: true, index: true },
  shortCode: { type: String, required: true, unique: true, index: true },
  createdAt: { type: Date, default: Date.now },
});

const Url = mongoose.model('Url', urlSchema);

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function generateBase62Code(length = 7) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += BASE62[bytes[i] % 62];
  }
  return code;
}

// Cache helpers
// Every helper swallows Redis failures so a cache outage degrades to MongoDB
// instead of returning 500. Reads fall back to a miss, writes become no-ops.
const codeKey = (shortCode) => `code:${shortCode}`;

// Hash the URL so long query strings don't bloat the keyspace.
const urlKey = (originalUrl) =>
  `url:${crypto.createHash('sha256').update(originalUrl).digest('hex')}`;

async function cacheGet(key) {
  if (!redis.isReady) return null;
  try {
    return await redis.get(key);
  } catch (err) {
    return null;
  }
}

async function cacheSet(key, value) {
  if (!redis.isReady) return;
  try {
    await redis.set(key, value, { EX: CACHE_TTL_SECONDS });
  } catch (err) {
    // Caching is best-effort.
  }
}

// 4. Rate Limiter
const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Root Route
app.get('/', (req, res) => {
  res.json({ message: 'URL Shortener API is running' });
});

// POST Endpoint -> Dedupe via Redis, fall back to MongoDB
app.post('/api/shorten', createLimiter, async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    // Dedupe: a cached mapping short-circuits before touching MongoDB.
    const cachedCode = await cacheGet(urlKey(url));
    if (cachedCode) {
      return res.status(200).json({
        shortCode: cachedCode,
        shortUrl: `http://localhost:3000/${cachedCode}`,
        originalUrl: url,
        deduplicated: true,
      });
    }

    // Cache miss -- MongoDB is the source of truth, so check for an existing
    // mapping before creating a duplicate.
    const existing = await Url.findOne({ originalUrl: url });
    if (existing) {
      await cacheSet(urlKey(url), existing.shortCode);
      await cacheSet(codeKey(existing.shortCode), existing.originalUrl);

      return res.status(200).json({
        shortCode: existing.shortCode,
        shortUrl: `http://localhost:3000/${existing.shortCode}`,
        originalUrl: existing.originalUrl,
        deduplicated: true,
      });
    }

    const shortCode = generateBase62Code(7);

    // Save document to MongoDB
    const newUrl = await Url.create({
      originalUrl: url,
      shortCode,
    });

    // Write-through: warm both directions so the first redirect is a cache hit.
    await cacheSet(urlKey(url), newUrl.shortCode);
    await cacheSet(codeKey(newUrl.shortCode), newUrl.originalUrl);

    return res.status(201).json({
      shortCode: newUrl.shortCode,
      shortUrl: `http://localhost:3000/${newUrl.shortCode}`,
      originalUrl: newUrl.originalUrl,
      deduplicated: false,
    });
  } catch (error) {
    console.error('Save error:', error);
    res.status(500).json({ error: 'Failed to create short URL' });
  }
});

// GET Endpoint -> Read-through Redis cache, fall back to MongoDB
app.get('/:shortCode', async (req, res) => {
  const { shortCode } = req.params;

  try {
    // Read-through cache: hot redirects never reach MongoDB.
    const cachedUrl = await cacheGet(codeKey(shortCode));
    if (cachedUrl) {
      return res.redirect(302, cachedUrl);
    }

    const urlDoc = await Url.findOne({ shortCode });

    if (!urlDoc) {
      return res.status(404).json({ error: 'Short URL not found' });
    }

    await cacheSet(codeKey(shortCode), urlDoc.originalUrl);
    // Repair the reverse mapping too, so a later POST can dedupe against it.
    await cacheSet(urlKey(urlDoc.originalUrl), urlDoc.shortCode);

    return res.redirect(302, urlDoc.originalUrl);
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ error: 'Server error looking up URL' });
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});