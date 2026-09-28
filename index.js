import express from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import mongoose from 'mongoose';

const app = express();
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/urlshortener';

mongoose
  .connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.error('MongoDB connection error:', err));

const urlSchema = new mongoose.Schema({
  originalUrl: { type: String, required: true },
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

// POST Endpoint -> Save to MongoDB
app.post('/api/shorten', createLimiter, async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const shortCode = generateBase62Code(7);

    // Save document to MongoDB
    const newUrl = await Url.create({
      originalUrl: url,
      shortCode,
    });

    res.status(201).json({
      shortCode: newUrl.shortCode,
      shortUrl: `http://localhost:3000/${newUrl.shortCode}`,
      originalUrl: newUrl.originalUrl,
    });
  } catch (error) {
    console.error('Save error:', error);
    res.status(500).json({ error: 'Failed to create short URL' });
  }
});

// GET Endpoint -> Fetch from MongoDB
app.get('/:shortCode', async (req, res) => {
  const { shortCode } = req.params;

  try {
    const urlDoc = await Url.findOne({ shortCode });

    if (!urlDoc) {
      return res.status(404).json({ error: 'Short URL not found' });
    }

    return res.redirect(302, urlDoc.originalUrl);
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ error: 'Server error looking up URL' });
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});