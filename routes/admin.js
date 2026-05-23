// routes/admin.js
import express from "express"
import multer from "multer"
import os from "os"
import { adminAuth } from "../middleware/auth.js"
import {
  createProduct,
  updateProduct,
  deleteProduct,
  listProducts,
  updateProductContentAccess,
  listUsers,
  getUser,
  grantUserAccess,
  getStudentProgress,
  listPurchases,
  getPurchase,
  updatePurchaseNotes,
  initiateRefund,
} from "../controllers/adminController.js"
import {
  getInventoryLogs,
  getStockOverview,
  adjustStock,
  getSalesSummary,
  getSalesTimeline,
  getSalesByDate,
  getTopProducts,
} from "../controllers/inventoryController.js"
import { getSettings, updateSettings } from "../controllers/settingsController.js"
import {
  uploadContent,
  prepareUpload,
  markUploadComplete,
  listContent,
  listSubjects,
  updateContent,
  deleteContent,
  previewContent,
} from "../controllers/contentController.js"
import {
  listSubjects as listSubjectsCRUD,
  createSubject,
  updateSubject,
  deleteSubject,
} from "../controllers/subjectController.js"

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10 GB max
  fileFilter: (_req, file, cb) => {
    const allowed = /^(video\/|application\/pdf)/.test(file.mimetype)
    cb(allowed ? null : new Error('Only video and PDF files allowed'), allowed)
  },
})

const router = express.Router();

// All routes require admin token
router.use(adminAuth);

// Products
router.get('/products', listProducts);
router.post('/products', createProduct);
router.put('/products/:id', updateProduct);
router.delete('/products/:id', deleteProduct);
router.put('/products/:id/content-access', updateProductContentAccess);

// Users & Purchases
router.get('/users',                        listUsers);
router.get('/users/:id',                    getUser);
router.post('/users/:id/grant-access',      grantUserAccess);
router.get('/users/:id/progress',           getStudentProgress);
router.get('/purchases', listPurchases);
router.get('/purchases/:id', getPurchase);
router.patch('/purchases/:id/notes',  updatePurchaseNotes);
router.post('/purchases/:id/refund',  initiateRefund);

// Inventory
router.get('/inventory/logs',    getInventoryLogs);   // ?productId=&type=&dateFrom=&dateTo=&page=&limit=
router.get('/inventory/stock',   getStockOverview);   // current stock per product
router.post('/inventory/adjust', adjustStock);        // manual stock adjustment

// Sales Analytics
router.get('/sales/summary',      getSalesSummary);   // ?dateFrom=&dateTo=&source=
router.get('/sales/timeline',     getSalesTimeline);  // ?groupBy=day|month|year&dateFrom=&dateTo=
router.get('/sales/by-date',      getSalesByDate);    // ?date=YYYY-MM-DD
router.get('/sales/top-products', getTopProducts);    // ?dateFrom=&dateTo=&limit=&source=

// Settings
router.get('/settings',  getSettings);
router.put('/settings',  updateSettings);

// Subjects (structured level-wise subject management)
router.get('/subjects',     listSubjectsCRUD);
router.post('/subjects',    createSubject);
router.put('/subjects/:id', updateSubject);
router.delete('/subjects/:id', deleteSubject);

// Content (videos & PDFs stored in Bunny.net)
router.post('/content/prepare-upload',       prepareUpload);
router.post('/content/:id/upload-complete',  markUploadComplete);
router.post('/content/upload',   upload.single('file'), uploadContent);
router.get('/content',           listContent);
router.get('/content/subjects',  listSubjects);
router.get('/content/:id/preview', previewContent);
router.put('/content/:id',       updateContent);
router.delete('/content/:id',    deleteContent);

export default router;
