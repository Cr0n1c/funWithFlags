import express from 'express';
import type { Request, Response } from 'express';
import { Database } from 'sqlite';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Configure rate limiting
const defaultLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limits for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit each IP to 5 requests per hour
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limits for user management
const userLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per 15 minutes
  message: 'Too many user management requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply default rate limiting to all routes
app.use(defaultLimiter);

app.use(express.json());
app.use(cors());

let db: Database;

// Utility to wrap async route handlers
function asyncHandler(
  fn: (req: Request, res: Response, next?: (err?: Error) => void) => Promise<unknown>,
) {
  return function (req: Request, res: Response, next: (err?: Error) => void) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Initialize SQLite connection
async function initDb() {
  const dbPath = path.resolve(__dirname, '../../db/database.sqlite');
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });
}

// Health check endpoint - more lenient limit
app.get('/api/health', rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30, // 30 requests per 5 minutes
  message: 'Too many health check requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
}), (req: Request, res: Response) => {
  // eslint-disable-next-line no-console
  console.log('GET /api/health called');
  res.json({ status: 'ok' });
});

// User management endpoints - stricter limits
app.post('/api/users', userLimiter, asyncHandler(async (req: Request, res: Response) => {
  // eslint-disable-next-line no-console
  console.log('POST /api/users called with:', req.body);
  const { email, username } = req.body;
  if (!email || !username) {
    return res.status(400).json({ error: 'Missing email or username' });
  }
  try {
    // Check if user exists
    const existingUser = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (existingUser) {
      await db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP, username = ? WHERE email = ?', [username, email]);
      const updatedUser = await db.get('SELECT * FROM users WHERE email = ?', [email]);
      return res.json(updatedUser);
    }
    await db.run('INSERT INTO users (email, username, password_hash, role) VALUES (?, ?, ?, ?)', [email, username, 'okta_auth', 'user']);
    const newUser = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    return res.json(newUser);
  } catch (err) {
    const errorResponse = { error: 'Database error' };
    if (process.env.NODE_ENV !== 'production') {
      errorResponse.details = err;
    }
    return res.status(500).json(errorResponse);
  }
}));

// Audit logging - moderate limits
app.post('/api/audit', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 requests per 15 minutes
  message: 'Too many audit log requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
}), asyncHandler(async (req: Request, res: Response) => {
  const { userId, eventType } = req.body;
  if (!userId || !eventType) {
    return res.status(400).json({ error: 'Missing userId or eventType' });
  }
  try {
    await db.run('INSERT INTO audit_log (user_id, event_type) VALUES (?, ?)', [userId, eventType]);
    return res.json({ status: 'logged' });
  } catch (err) {
    return res.status(500).json({ error: 'Database error', details: err });
  }
}));

// Log 404 requests - moved to end of route definitions
app.use((req: Request, res: Response, next: (err?: Error) => void) => {
  // eslint-disable-next-line no-console
  console.log(`404 Not Found: ${req.method} ${req.url}`);
  next();
});

// Start server after DB is ready
initDb().then(() => {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Express server running on http://localhost:${PORT}`);
  });
}); 