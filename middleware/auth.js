// middleware/auth.js
import jwt from "jsonwebtoken"
import User from "../models/User.js"

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');

// 30-second in-memory cache: userId (string) → { user (lean), expiresAt }
// Avoids a DB lookup on every authenticated request.
const _userCache = new Map();
const USER_TTL   = 30_000;

function _getCached(userId) {
  const entry = _userCache.get(userId);
  if (entry && entry.expiresAt > Date.now()) return entry.user;
  _userCache.delete(userId);
  return null;
}

function _setCached(userId, user) {
  _userCache.set(userId, { user, expiresAt: Date.now() + USER_TTL });
}

// Call this after updating a user so the next request gets fresh data.
export function clearUserCache(userId) {
  _userCache.delete(userId.toString());
}

async function _resolveUser(userId) {
  const cached = _getCached(userId);
  if (cached) return cached;
  const user = await User.findById(userId).lean();
  if (user) _setCached(userId, user);
  return user;
}

// Verify JWT token
const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });

    const { userId } = jwt.verify(token, JWT_SECRET);
    const user = await _resolveUser(userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
};

// Verify JWT + require isAdmin
const adminAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });

    const { userId } = jwt.verify(token, JWT_SECRET);
    const user = await _resolveUser(userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.isAdmin) return res.status(403).json({ error: 'Admin access required' });

    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

export { auth, adminAuth, generateToken }