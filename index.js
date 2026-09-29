import express from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { createClient } from 'redis';

const app = express();
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/urlshortener';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '86400', 10);

mongoose
  .connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.error('MongoDB connection error:', err));

const redis = createClient({
  url: REDIS_URL,
  disableOfflineQueue: true,
});

redis.on('error', (err) => console.error('Redis error:', err.message));

redis
  .connect()
  .then(() => console.log('Connected to Redis'))
  .catch((err) => console.error('Redis connection error:', err.message));

const urlSchema = new mongoose.Schema({
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

function isValidHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;

  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const codeKey = (shortCode) => `code:${shortCode}`;

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
  } catch (err) {}
}

const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

app.get('/', (req, res) => {
  res.json({ message: 'URL Shortener API is running' });
});

app.post('/api/shorten', createLimiter, async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!isValidHttpUrl(url)) {
    return res.status(400).json({ error: 'URL must be a valid http or https URL' });
  }

  try {
    const cachedCode = await cacheGet(urlKey(url));
    if (cachedCode) {
      return res.status(200).json({
        shortCode: cachedCode,
        shortUrl: `http://localhost:3000/${cachedCode}`,
        originalUrl: url,
        deduplicated: true,
      });
    }

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

    const newUrl = await Url.create({
      originalUrl: url,
      shortCode,
    });

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

app.get('/:shortCode', async (req, res) => {
  const { shortCode } = req.params;

  try {
    const cachedUrl = await cacheGet(codeKey(shortCode));
    if (cachedUrl) {
      return res.redirect(302, cachedUrl);
    }

    const urlDoc = await Url.findOne({ shortCode });

    if (!urlDoc) {
      return res.status(404).json({ error: 'Short URL not found' });
    }

    await cacheSet(codeKey(shortCode), urlDoc.originalUrl);
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