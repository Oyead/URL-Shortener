import express from 'express'
import rateLimit from 'express-rate-limit'

const app = express()
app.use(express.json())