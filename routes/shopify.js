// routes/shopify.js
import express from "express"
import { orderPaidWebhook } from "../controllers/shopifyController.js"

const router = express.Router();

// Shopify webhooks need the raw body for HMAC verification.
// We capture rawBody here before express.json() parses it.
router.post(
  '/webhook/order-paid',
  express.raw({ type: 'application/json' }),
  (req, res, next) => {
    req.rawBody = req.body;
    req.body = JSON.parse(req.body.toString());
    next();
  },
  orderPaidWebhook
);

export default router;