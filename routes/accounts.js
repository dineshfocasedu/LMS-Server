// routes/accounts.js
import express from "express";
import { adminAuth } from "../middleware/auth.js";
import {
  getAccountsSummary,
  listAccountsEntries,
  listReceivables,
} from "../controllers/accountsController.js";

const router = express.Router();

router.get("/summary",     adminAuth, getAccountsSummary);
router.get("/entries",     adminAuth, listAccountsEntries);
router.get("/receivables", adminAuth, listReceivables);

export default router;
