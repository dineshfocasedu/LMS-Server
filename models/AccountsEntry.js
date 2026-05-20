// models/AccountsEntry.js
import mongoose from "mongoose";

// Records every financial event.
//
// Entry types:
//   'sale'                – Full sale amount booked when the first EMI (or full payment) arrives.
//   'receivable_created'  – Outstanding balance created when first EMI is paid (full_amount - emi_1_amount).
//   'receivable_payment'  – Each subsequent EMI reduces the outstanding receivable.
//   'refund'              – Admin-initiated refund; reduces cash collected in summary.
const accountsEntrySchema = new mongoose.Schema(
  {
    paymentId:  { type: mongoose.Schema.Types.ObjectId, ref: "Payment",  default: null },
    purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: "Purchase", default: null },
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: "User",     default: null },

    // 'sale'               → amount = full_amount of the payment
    // 'receivable_created' → amount = full_amount - first_emi_amount  (positive, what's still owed)
    // 'receivable_payment' → amount = emi amount paid (positive; reduces receivable balance)
    // 'refund'             → amount = refunded rupees (positive; subtracted from cash collected)
    type: {
      type:     String,
      enum:     ["sale", "receivable_created", "receivable_payment", "refund"],
      required: true,
    },

    amount:    { type: Number, required: true }, // always positive, in rupees
    emi_index: { type: Number, default: null },  // which EMI triggered this entry (1-based)

    description: { type: String, default: null },
  },
  { timestamps: true }
);

accountsEntrySchema.index({ paymentId: 1 });
accountsEntrySchema.index({ type: 1, createdAt: -1 });
accountsEntrySchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model("AccountsEntry", accountsEntrySchema);
