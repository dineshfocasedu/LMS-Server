// routes/purchase.js
import express from "express"

import { createOrder, verifyAndGrantAccess, getMyPurchases, listProducts, getCourseByLevel, getCourseById, getMyCourses, saveProgress, getProgress, checkProductAccess } from "../controllers/purchaseController.js"
import { getPublicContent, getStreamUrl, streamContent, hlsProxy, getAnswerUrl, streamAnswer } from "../controllers/contentController.js"
import { deviceAuth, auth } from "../middleware/auth.js"

const router = express.Router();

// Public
router.get('/products', listProducts);
router.get('/content',  getPublicContent);   // ?subject= or ?productId=
router.get('/course',   getCourseByLevel);
router.get('/course/:id', getCourseById);

router.post('/create-order', createOrder);
router.post('/verify',       verifyAndGrantAccess);
router.get('/my-purchases',  deviceAuth, getMyPurchases);

// Auth-gated
router.get('/check-access/:productId', deviceAuth, checkProductAccess); // check if user has valid access
router.get('/my-courses',              deviceAuth, getMyCourses);   // drives My Courses from user.access
router.get('/stream-url/:contentId',   deviceAuth, getStreamUrl);   // issues short-lived proxy URL
router.get('/stream/:contentId/:token',     streamContent);   // proxies bytes — token in path
router.get('/hls/:contentId/:filename',     hlsProxy);        // HLS playlist + segments — token in ?st=
router.get('/answer-url/:contentId',   deviceAuth, getAnswerUrl);  // issues short-lived proxy URL for answer PDF
router.get('/answer/:contentId/:token',     streamAnswer);   // proxies answer PDF bytes — token in path
router.post('/progress',               auth, saveProgress);   // save video watch position
router.get('/progress',                auth, getProgress);    // get progress map for a product

export default router;
