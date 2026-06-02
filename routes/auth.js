// routes/auth.js
import express from "express"
const router = express.Router();
import { auth } from "../middleware/auth.js"
import { sendOTPController, verifyOTPController, logoutOtherDeviceController, getMe, updateProfile } from "../controllers/authController.js"

// POST /api/auth/send-otp - Send OTP to phone/email
router.post('/send-otp', sendOTPController);

// POST /api/auth/verify-otp - Verify OTP and login
router.post('/verify-otp', verifyOTPController);

// POST /api/auth/logout-other-device - Logout from other device
router.post('/logout-other-device', logoutOtherDeviceController);

// GET /api/auth/me - Get current user (protected)
router.get('/me', auth, getMe);

// PUT /api/auth/profile - Update profile (protected)
router.put('/profile', auth, updateProfile);

export default router