// models/Settings.js
import mongoose from "mongoose";

// Singleton settings document — always use _id: 'global'
const settingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "global" },

    // Low stock alert threshold — same for all products
    lowStockThreshold: { type: Number, default: 5, min: 0 },

    // Up to 3 phone numbers (with country code, e.g. "919876543210")
    alertPhones: {
      type: [String],
      default: [],
      validate: [(v) => v.length <= 3, "Maximum 3 alert phone numbers allowed"],
    },
  },
  { timestamps: true }
);

export default mongoose.model("Settings", settingsSchema);
