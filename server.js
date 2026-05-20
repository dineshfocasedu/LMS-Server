// server.js
import 'dotenv/config'
import express from "express"
import mongoose from "mongoose"
import cors from "cors"
import authRoutes from "./routes/auth.js"
import shopifyRoutes from "./routes/shopify.js"
import purchaseRoutes from "./routes/purchase.js"
import adminRoutes from "./routes/admin.js"
import deliveryRoutes from "./routes/delivery.js"
import paymentRoutes from "./routes/payment.js"
import accountsRoutes from "./routes/accounts.js"

const app = express();

// Trust reverse proxies (ngrok, nginx, Heroku, etc.) so req.protocol is https when it should be
app.set('trust proxy', 1);

// Middleware
app.use(cors({
  origin: [
    "http://localhost:8080",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5174",
    "https://admin-focas.netlify.app",
    "https://combo-focas.netlify.app",
    "https://focas.vercel.app",
    "https://sage-douhua-668f0c.netlify.app",
    "https://extraordinary-mousse-64157e.netlify.app",
    "https://estimate-pampers-collector.ngrok-free.dev",
    "https://september-subsphenoid-celia.ngrok-free.dev",
    "https://focaslms.netlify.app",
    "https://carole-accommodative-rogelio.ngrok-free.dev",
    "https://focasadmin.netlify.app",
    "https://lms.focasedu.com",
    "https://focas-student-lms-app.vercel.app",
    "https://focas-admin-app.vercel.app",
    "https://focas-admin-lms-app.vercel.app",
    "https://focas-custom-product-app.vercel.app",
    "https://compile-wrongly-deceiver.ngrok-free.dev",
    "https://focasedu.com"
  ],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "ngrok-skip-browser-warning"],
  exposedHeaders: ["Content-Range", "Accept-Ranges", "Content-Length"],
  credentials: true
}));

// ✅ Handle preflight requests for ALL routes
app.options('*', cors());


app.use('/api/shopify', shopifyRoutes);
// Payment routes must be mounted before express.json() so the Razorpay
// webhook route can capture the raw body for HMAC signature verification.
app.use('/api/payment', paymentRoutes);


app.use(express.json());

// Handle malformed JSON bodies (e.g. bad webhook payloads)
app.use((err, _req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  next(err);
});

// Database
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/focas')
  .then(() => {
    console.log('✅ MongoDB Connected');
  })
  .catch(err => console.error('❌ MongoDB Error:', err));

// Routes
app.use('/api/auth', authRoutes);

app.use('/api/purchase', purchaseRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/delivery', deliveryRoutes);
app.use('/api/accounts', accountsRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok Health Success done' }));

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));