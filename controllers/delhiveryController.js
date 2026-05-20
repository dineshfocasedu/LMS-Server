// controllers/delhiveryController.js
import Purchase from "../models/Purchase.js"
import Product from "../models/Product.js"
import * as delhivery from "../services/delhiveryService.js"

function extractPincode(address = {}) {
  const raw = address.pincode ?? address.zip ?? address.postalCode ?? address.postal_code ?? null;
  if (!raw) return null;

  const cleaned = String(raw).replace(/\D/g, '').slice(0, 6);
  return cleaned || null;
}

// ---------------------------------------------------------------------------
// Helper: build Delhivery shipment payload from a Purchase document.
// Expects purchase populated with userId and items.productId.
// ---------------------------------------------------------------------------
function buildShipmentPayload(purchase) {
  const user    = purchase.userId;
  const address = purchase.address || {};

  const name  = purchase.customerName  || user?.name  || 'Customer';
  const phone = purchase.customerPhone || user?.phoneNumber;
  const pincode = extractPincode(address);

  if (!phone)    throw new Error(`No phone number for purchase ${purchase._id}`);
  if (!pincode)  throw new Error(`No delivery pincode for purchase ${purchase._id}`);

  const addParts    = [address.line1, address.line2].filter(Boolean);
  const fullAddress = addParts.join(', ') || address.city || '';

  // When purchase.hasPhysicalItem is true (set from the payment link's shipToHome flag),
  // the admin explicitly marked this order as physical — include all items regardless of
  // each product's own shipToHome field. Otherwise fall back to product-level filtering.
  const shippableItems = purchase.hasPhysicalItem
    ? (purchase.items || [])
    : (purchase.items || []).filter(i => i.productId?.shipToHome !== false);

  const totalWeight = shippableItems.reduce((s, i) => s + (i.productId?.weight || 0), 0);
  const productDesc = shippableItems.map(i => i.name || i.productId?.name || '').filter(Boolean).join(', ') || 'Books';
  const totalAmount = shippableItems.reduce((s, i) => s + (i.amount || 0), 0);

  if (totalWeight <= 0) {
    const missingNames = shippableItems
      .filter(i => !i.productId?.weight)
      .map(i => i.name || i.productId?.name || 'Unknown item');
    throw new Error(
      `Cannot sync: missing weight for item(s): ${missingNames.join(', ') || 'one or more items'}. Please update the product weight before syncing.`
    );
  }

  return {
    order:         purchase.orderId,
    name,
    phone,
    add:           fullAddress,
    pin:           parseInt(pincode, 10),
    city:          address.city    || '',
    state:         address.state   || '',
    country:       address.country || 'India',
    payment_mode:  'Prepaid',
    total_amount:  totalAmount,
    products_desc: productDesc,
    weight:        String(totalWeight),
    pending_awb:   1,
  };
}

// ---------------------------------------------------------------------------
// GET /api/delivery/shipments
// Admin dashboard — all purchases with shipment info.
// Query params:
//   status   : filter by trackingStatus (e.g. "Delivered", "Manifested", "In Transit")
//   page     : page number (default 1)
//   limit    : per page (default 20)
// ---------------------------------------------------------------------------
export async function getShipments(req, res) {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    // Find all product IDs that require physical delivery so we can catch orders
    // where hasPhysicalItem wasn't set (e.g. created before the flag existed).
    const shipToHomeProductIds = await Product.find({ shipToHome: true }).distinct('_id');

    const query = {
      $or: [
        { hasPhysicalItem: true },
        { 'items.productId': { $in: shipToHomeProductIds } },
      ],
    };
    if (req.query.status)   query['shipment.trackingStatus'] = req.query.status;
    if (req.query.orderId)  query.orderId = { $regex: req.query.orderId, $options: 'i' };
    if (req.query.phone)    query.customerPhone = { $regex: req.query.phone };
    if (req.query.dateFrom || req.query.dateTo) {
      query.createdAt = {};
      if (req.query.dateFrom) query.createdAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const end = new Date(req.query.dateTo);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    const [orders, total] = await Promise.all([
      Purchase.find(query)
        .populate('userId', 'name phoneNumber email')
        .populate('items.productId', 'name weight shipToHome stock')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Purchase.countDocuments(query),
    ]);

    res.json({
      orders,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/delivery/track/:awb
// Track a shipment by AWB — syncs latest status into Purchase.
// ---------------------------------------------------------------------------
export async function trackShipment(req, res) {
  try {
    const { awb } = req.params;
    if (!awb) return res.status(400).json({ error: 'awb is required' });

    const result = await delhivery.trackShipment(awb);

    if (!result.length) {
      return res.status(404).json({ error: 'No tracking data found for this AWB' });
    }

    const shipmentData = result[0]?.Shipment;

    // Sync latest status into our Purchase record
    const purchase = await Purchase.findOne({ 'shipment.awb': awb });
    if (purchase && shipmentData?.Status?.Status) {
      purchase.shipment.trackingStatus   = shipmentData.Status.Status;
      purchase.shipment.trackingLocation = shipmentData.Status.StatusLocation;
      purchase.shipment.lastStatusAt     = new Date(shipmentData.Status.StatusDateTime);
      await purchase.save();
    }

    res.json({ shipment: shipmentData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/delivery/label/:awb
// Download shipping label PDF. Supports comma-separated AWBs.
// ---------------------------------------------------------------------------
export async function getLabel(req, res) {
  try {
    const { awb } = req.params;
    if (!awb) return res.status(400).json({ error: 'awb is required' });

    // Get the presigned S3 URL from Delhivery
    const pdfUrl = await delhivery.getLabel(awb);

    // Fetch the PDF from S3 on the server side (avoids browser CORS issues)
    const s3Res = await fetch(pdfUrl);
    if (!s3Res.ok) {
      return res.status(502).json({ error: `S3 fetch failed: ${s3Res.status}` });
    }

    const buffer = Buffer.from(await s3Res.arrayBuffer());

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="label-${awb}.pdf"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/delivery/rate/:purchaseId
// Fetch Delhivery shipping charge for a specific purchase.
// Uses purchase address pincode + DELHIVERY_ORIGIN_PIN env var.
// ---------------------------------------------------------------------------
export async function getRate(req, res) {
  try {
    const purchase = await Purchase.findById(req.params.purchaseId)
      .populate('userId', 'name phoneNumber')
      .populate('items.productId', 'name weight shipToHome stock')
      .lean();

    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });

    const d_pin = extractPincode(purchase.address);
    const o_pin = process.env.DELHIVERY_ORIGIN_PIN;

    if (!d_pin) return res.status(400).json({ error: 'Purchase has no delivery pincode' });
    if (!o_pin) return res.status(500).json({ error: 'DELHIVERY_ORIGIN_PIN env not set' });

    const totalWeight = (purchase.items || []).reduce((s, i) => s + (i.productId?.weight || 0), 0);
    if (totalWeight <= 0) return res.status(400).json({ error: 'Cannot get rate: no weight data on order items. Please update product weights first.' });
    const cgm = totalWeight;

    const rates = await delhivery.getRates({
      md:    'E',
      cgm,
      o_pin,
      d_pin,
      ss:    'Delivered',
      pt:    'Pre-paid',
    });

    res.json({ purchaseId: purchase._id, orderId: purchase.orderId, cgm, rates, address: purchase.address });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/delivery/sync/:purchaseId
// Manually sync a single order to Delhivery (create shipment).
// ---------------------------------------------------------------------------
export async function syncShipment(req, res) {
  try {
    const purchase = await Purchase.findById(req.params.purchaseId)
      .populate('userId', 'name phoneNumber')
      .populate('items.productId', 'name weight shipToHome stock');

    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });

    if (purchase.shipment?.awb) {
      return res.status(409).json({ error: 'Already synced', awb: purchase.shipment.awb });
    }

    // Block sync when any tracked product has zero or negative stock
    const outOfStockItems = (purchase.items || []).filter(
      (i) => i.productId && i.productId.stock !== null && i.productId.stock !== undefined && i.productId.stock < 0
    );
    if (outOfStockItems.length > 0) {
      const names = outOfStockItems.map((i) => i.productId?.name || i.name || 'Unknown').join(', ');
      return res.status(400).json({
        error: `Product not available — stock is zero or negative for: ${names}. Please restock before syncing to delivery.`,
      });
    }

    // If legacy records contain zip/postalCode but not pincode, persist normalized pincode.
    const normalizedPin = extractPincode(purchase.address);
    if (normalizedPin && !purchase.address?.pincode) {
      purchase.address = { ...(purchase.address?.toObject?.() || purchase.address || {}), pincode: normalizedPin };
    }

    const pickupLocation = process.env.DELHIVERY_PICKUP_LOCATION;
    if (!pickupLocation) return res.status(500).json({ error: 'DELHIVERY_PICKUP_LOCATION env not set' });

    const payload = buildShipmentPayload(purchase);
    const result  = await delhivery.createShipment(payload, { name: pickupLocation });
    const pkg     = result?.packages?.[0];

    if (pkg?.status !== 'Success') {
      return res.status(502).json({ error: 'Delhivery rejected shipment', detail: result });
    }

    purchase.shipment = {
      awb:            pkg.waybill,
      sortCode:       pkg.sort_code || '',
      trackingStatus: 'Manifested',
      createdAt:      new Date(),
    };
    await purchase.save();

    res.json({ success: true, awb: pkg.waybill, purchaseId: purchase._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/delivery/bulk-sync
// Sync multiple orders to Delhivery in one request.
// Body: { purchaseIds: ["id1", "id2", ...] }
// ---------------------------------------------------------------------------
export async function bulkSync(req, res) {
  const { purchaseIds } = req.body;

  if (!Array.isArray(purchaseIds) || purchaseIds.length === 0) {
    return res.status(400).json({ error: 'purchaseIds array is required' });
  }

  const pickupLocation = process.env.DELHIVERY_PICKUP_LOCATION;
  if (!pickupLocation) return res.status(500).json({ error: 'DELHIVERY_PICKUP_LOCATION env not set' });

  const results = [];

  for (const id of purchaseIds) {
    try {
      const purchase = await Purchase.findById(id)
        .populate('userId', 'name phoneNumber')
        .populate('items.productId', 'name weight shipToHome');

      if (!purchase) {
        results.push({ purchaseId: id, success: false, error: 'Not found' });
        continue;
      }

      if (purchase.shipment?.awb) {
        results.push({ purchaseId: id, success: false, error: 'Already synced', awb: purchase.shipment.awb });
        continue;
      }

      const normalizedPin = extractPincode(purchase.address);
      if (normalizedPin && !purchase.address?.pincode) {
        purchase.address = { ...(purchase.address?.toObject?.() || purchase.address || {}), pincode: normalizedPin };
      }

      const payload = buildShipmentPayload(purchase);
      const result  = await delhivery.createShipment(payload, { name: pickupLocation });
      const pkg     = result?.packages?.[0];

      if (pkg?.status !== 'Success') {
        results.push({ purchaseId: id, success: false, error: 'Delhivery rejected', detail: result });
        continue;
      }

      purchase.shipment = {
        awb:            pkg.waybill,
        sortCode:       pkg.sort_code || '',
        trackingStatus: 'Manifested',
        createdAt:      new Date(),
      };
      await purchase.save();

      results.push({ purchaseId: id, success: true, awb: pkg.waybill, orderId: purchase.orderId });
    } catch (err) {
      results.push({ purchaseId: id, success: false, error: err.message });
    }
  }

  const succeeded = results.filter(r => r.success).length;
  res.json({ synced: succeeded, total: purchaseIds.length, results });
}

// ---------------------------------------------------------------------------
// POST /api/delivery/webhook
// Delhivery pushes real-time status updates here.
// Configure this URL in Delhivery One → Settings → Webhooks
// ---------------------------------------------------------------------------
export async function delhiveryWebhook(req, res) {
  // Always respond 200 immediately so Delhivery doesn't retry
  res.sendStatus(200);

  try {
    const { Shipment } = req.body;
    if (!Shipment) return;

    const awb    = Shipment.AWB;
    const status = Shipment.Status?.Status;

    if (!awb || !status) return;

    const purchase = await Purchase.findOne({ 'shipment.awb': awb });
    if (!purchase) {
      console.warn(`[Delhivery Webhook] No purchase found for AWB: ${awb}`);
      return;
    }

    const location  = Shipment.Status?.StatusLocation || '';
    const statusAt  = new Date(Shipment.Status?.StatusDateTime || Date.now());

    // Update latest status
    purchase.shipment.trackingStatus   = status;
    purchase.shipment.trackingLocation = location;
    purchase.shipment.lastStatusAt     = statusAt;

    // Push to history (avoid duplicates)
    const alreadyLogged = purchase.shipment.statusHistory?.some(
      h => h.status === status && h.timestamp?.getTime() === statusAt.getTime()
    );
    if (!alreadyLogged) {
      purchase.shipment.statusHistory.push({ status, location, timestamp: statusAt });
    }

    // Map Delhivery status → fulfillmentStatus
    if (status === 'Delivered') {
      purchase.fulfillmentStatus = 'fulfilled';
    } else if (['RTO', 'RTO Delivered', 'Returned', 'Cancelled'].includes(status)) {
      purchase.fulfillmentStatus = 'unfulfilled';
    }

    await purchase.save();
    console.log(`[Delhivery Webhook] AWB ${awb} → ${status} @ ${location}`);
  } catch (err) {
    console.error('[Delhivery Webhook] Error:', err.message);
  }
}
