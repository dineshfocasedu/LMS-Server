import 'dotenv/config'
import express from "express"
import mongoose from "mongoose"
import cors from "cors"
import { resumeProcessingPolls } from "./controllers/contentController.js"
import authRoutes from "./routes/auth.js"
import shopifyRoutes from "./routes/shopify.js"
import purchaseRoutes from "./routes/purchase.js"
import adminRoutes from "./routes/admin.js"
import deliveryRoutes from "./routes/delivery.js"
import paymentRoutes from "./routes/payment.js"
import accountsRoutes from "./routes/accounts.js"

const app = express();

// Trust reverse proxies (ngrok, nginx, Heroku, etc.)
app.set('trust proxy', 1);

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Define ONE shared config object — used by both app.use() and app.options()
// so preflight (OPTIONS) and actual requests get identical headers.
const corsOptions = {
  origin: [
    "http://localhost:8080",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    // Vercel
    "https://lms-student-focas.vercel.app",
    "https://lms-admin-focastech.vercel.app",
    "https://lms-accounts-admin.vercel.app",
    "https://lms-accounts-admin-git-main-focas.vercel.app",
    "https://lms-accounts-admin-n6599kmnq-focas.vercel.app",
    "https://focas.vercel.app",
    "https://focas-student-lms-app.vercel.app",
    "https://focas-admin-app.vercel.app",
    "https://focas-admin-lms-app.vercel.app",
    "https://focas-custom-product-app.vercel.app",
    // Netlify
    "https://admin-focas.netlify.app",
    "https://combo-focas.netlify.app",
    "https://sage-douhua-668f0c.netlify.app",
    "https://extraordinary-mousse-64157e.netlify.app",
    "https://focaslms.netlify.app",
    "https://focasadmin.netlify.app",
    // Production
    "https://focasedu.com",
    "https://app.focasedu.com",
    "https://admin.focasedu.com",
    "https://lms.focasedu.com",
    "https://shop.focasedu.com",
    "https://store.focasedu.com",
    // ngrok
    "https://estimate-pampers-collector.ngrok-free.dev",
    "https://september-subsphenoid-celia.ngrok-free.dev",
    "https://carole-accommodative-rogelio.ngrok-free.dev",
    "https://compile-wrongly-deceiver.ngrok-free.dev",
  ],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning"],
  exposedHeaders: ["Content-Range", "Accept-Ranges", "Content-Length"],
  credentials: true,
};

// Preflight must be registered FIRST and use the same corsOptions
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

// ─── Routes that need raw body (before express.json) ─────────────────────────
app.use('/api/shopify', shopifyRoutes);
app.use('/api/payment', paymentRoutes);

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Malformed JSON handler
app.use((err, _req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  next(err);
});

// ─── Database ─────────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGO_URI || 'mongodb://localhost:27017/focas')
  .then(() => {
    console.log('✅ MongoDB Connected');
    resumeProcessingPolls();
  })
  .catch(err => console.error('❌ MongoDB Error:', err));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/purchase', purchaseRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/delivery', deliveryRoutes);
app.use('/api/accounts', accountsRoutes);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));