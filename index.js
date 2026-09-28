import express from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

const app = express();
app.use(express.json());

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
function generateBase62Code(length = 7) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += BASE62[bytes[i] % 62];
  }
  return code;
}

// In-memory URL store
const urls = {};

// Rate Limiter for URL creation (10 requests per 15 mins)
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


// POST Endpoint -> Create Short URL 
app.post('/api/shorten', createLimiter, (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const shortCode = generateBase62Code(7);
  urls[shortCode] = url;

  res.status(201).json({
    shortCode,
    shortUrl: `http://localhost:3000/${shortCode}`,
    originalUrl: url,
  });
});


// GET Endpoint -> Redirect
app.get('/:shortCode', (req, res) => {
  const { shortCode } = req.params;
  const originalUrl = urls[shortCode];

  if (!originalUrl) {
    return res.status(404).json({ error: 'Short URL not found' });
  }

  return res.redirect(302, originalUrl);
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});