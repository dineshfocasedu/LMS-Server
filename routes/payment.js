// routes/payment.js
// NOTE: This router must be mounted BEFORE app.use(express.json()) in server.js
// so that the webhook route can capture the raw body for HMAC verification.
import express from "express";
import { adminAuth } from "../middleware/auth.js";
import {
  listPayments,
  getPayment,
  createPaymentLink,
  razorpayWebhook,
} from "../controllers/paymentController.js";

const router = express.Router();

// ── Webhook (raw body — must come before express.json()) ──────────────────────
router.post(
  "/webhook/razorpay",
  express.raw({ type: "application/json" }),
  (req, _res, next) => {
    req.rawBody = req.body; // Buffer — used by the controller for HMAC
    req.body    = JSON.parse(req.body.toString());
    next();
  },
  razorpayWebhook
);

// ── All remaining routes need parsed JSON body ────────────────────────────────
router.use(express.json());

// Admin: create a new payment link
router.post("/create", adminAuth, createPaymentLink);

// Admin: list all payment records
router.get("/", adminAuth, listPayments);

// Admin: single payment record
router.get("/:id", adminAuth, getPayment);

export default router;
