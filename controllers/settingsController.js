// controllers/settingsController.js
import Settings from "../models/Settings.js";

// GET /api/admin/settings
export async function getSettings(req, res) {
  try {
    const settings = await Settings.findById("global").lean();
    res.json(
      settings || { lowStockThreshold: 5, alertPhones: [] }
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// PUT /api/admin/settings
// Body: { lowStockThreshold?: number, alertPhones?: string[] }
export async function updateSettings(req, res) {
  try {
    const { lowStockThreshold, alertPhones } = req.body;

    const update = {};
    if (lowStockThreshold != null) {
      const val = Number(lowStockThreshold);
      if (!Number.isFinite(val) || val < 0)
        return res.status(400).json({ error: "lowStockThreshold must be a non-negative number" });
      update.lowStockThreshold = val;
    }
    if (alertPhones != null) {
      if (!Array.isArray(alertPhones) || alertPhones.length > 3)
        return res.status(400).json({ error: "alertPhones must be an array of up to 3 numbers" });
      update.alertPhones = alertPhones.map((p) => String(p).trim()).filter(Boolean);
    }

    const settings = await Settings.findByIdAndUpdate(
      "global",
      { $set: update },
      { new: true, upsert: true, runValidators: true }
    ).lean();

    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
