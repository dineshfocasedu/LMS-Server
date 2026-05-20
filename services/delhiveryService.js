// services/delhiveryService.js
import axios from "axios"

const BASE_URL = process.env.DELHIVERY_ENV === 'production'
  ? 'https://track.delhivery.com'
  : 'https://staging-express.delhivery.com';

const client = axios.create({ baseURL: BASE_URL });

// Read token at request time so dotenv is always loaded first
client.interceptors.request.use(config => {
  const token = process.env.DELHIVERY_TOKEN;
  config.headers['Authorization'] = `Token ${token}`;
  config.headers['Content-Type'] = config.headers['Content-Type'] || 'application/json';
  config.headers['Accept'] = 'application/json';
  return config;
});

/**
 * Check if a pincode is serviceable.
 * Returns the postal_code object if serviceable, null otherwise.
 */
export async function checkServiceability(pincode) {
  const { data } = await client.get('/c/api/pin-codes/json/', {
    params: { token: process.env.DELHIVERY_TOKEN, filter_codes: pincode },
  });
  const codes = data?.delivery_codes || [];
  if (codes.length === 0) return null;
  return codes[0].postal_code;
}

/**
 * Fetch waybill numbers in bulk.
 * @param {number} count - Number of waybills to fetch (max 10000)
 */
export async function fetchWaybills(count = 1) {
  const { data } = await client.get('/waybill/api/bulk/json/', {
    params: { token: process.env.DELHIVERY_TOKEN, count },
    responseType: 'text',
  });
  // Response may be plain text or JSON-encoded strings — strip surrounding quotes
  return String(data).trim().split('\n').filter(Boolean).map(w => w.replace(/^"|"$/g, '').trim());
}

/**
 * Create a shipment (manifest order).
 *
 * @param {Object} shipment - The shipment fields
 * @param {Object} pickupLocation - { name, city, pin, country, phone, add }
 * @returns Delhivery response with waybill + status per package
 *
 * Required shipment fields:
 *   order, name, phone, add, pin, city, state, payment_mode, total_amount
 *
 * Optional: waybill, cod_amount, weight, products_desc, order_date,
 *           shipment_length, shipment_width, shipment_height, quantity,
 *           seller_name, seller_add, fragile_shipment, address_type,
 *           return_name, return_phone, return_add, return_city, return_state, return_pin
 */
export async function createShipment(shipment, pickupLocation) {
  const payload = {
    shipments: [shipment],
    pickup_location: pickupLocation,
  };

  // Delhivery expects URL-encoded format=json&data=<JSON>
  const body = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`;

  const { data } = await client.post('/api/cmu/create.json', body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return data;
}

/**
 * Track one or more shipments by waybill numbers.
 * @param {string|string[]} waybills
 */
export async function trackShipment(waybills) {
  const wbn = Array.isArray(waybills) ? waybills.join(',') : waybills;
  const { data } = await client.get('/api/v1/packages/json/', {
    params: { waybill: wbn },
  });
  return data?.ShipmentData || [];
}

/**
 * Cancel a shipment.
 * @param {string} waybill
 */
export async function cancelShipment(waybill) {
  const { data } = await client.post('/api/p/edit', {
    waybill,
    cancellation: 'true',
  });
  return data;
}

/**
 * Edit an existing shipment (before terminal status).
 * @param {Object} updates - { waybill, name, add, phone, cod, gm, product_details, ... }
 */
export async function editShipment(updates) {
  const { data } = await client.post('/api/p/edit', updates);
  return data;
}

/**
 * Get estimated shipping rates.
 * @param {Object} params - { md, cgm, o_pin, d_pin, ss }
 *   md: 'E' (Express) or 'S' (Surface)
 *   cgm: chargeable weight in grams
 *   o_pin: origin pincode
 *   d_pin: destination pincode
 *   ss: 'Delivered' | 'RTO' | 'DTO'
 */
export async function getRates({ md, cgm, o_pin, d_pin, ss = 'Delivered', pt = 'Pre-paid' }) {
  const { data } = await client.get('/api/kinko/v1/invoice/charges/.json', {
    params: { md, cgm, o_pin, d_pin, ss, pt },
  });
  return data;
}

/**
 * Schedule a pickup from a registered warehouse.
 * @param {Object} params - { pickup_time, pickup_date, pickup_location, expected_package_count }
 */
export async function createPickup({ pickup_time, pickup_date, pickup_location, expected_package_count }) {
  const { data } = await client.post('/fm/request/new/', {
    pickup_time,
    pickup_date,
    pickup_location,
    expected_package_count,
  });
  return data;
}

/**
 * Create a new warehouse/pickup location.
 * @param {Object} warehouse - { name, registered_name, phone, address, pin, city, country, email,
 *                               return_address, return_pin, return_city, return_state, return_country }
 */
export async function createWarehouse(warehouse) {
  const { data } = await client.post('/api/backend/clientwarehouse/create/', warehouse);
  return data;
}

/**
 * Submit NDR (Non-Delivery) action for pending packages.
 * @param {Array} actions - [{ waybill, act, action_data? }]
 *   act: 'DEFER_DLV' | 'EDIT_DETAILS' | 'RE-ATTEMPT'
 */
export async function ndrAction(actions) {
  const { data } = await client.post('/api/p/update', {
    data: Array.isArray(actions) ? actions : [actions],
  });
  return data;
}

/**
 * Get shipping label PDF download link for one or more waybills.
 * Delhivery returns JSON: { packages: [{ pdf_download_link, ... }] }
 * @param {string|string[]} waybills
 * @returns string — presigned S3 PDF URL
 */
export async function getLabel(waybills) {
  const wbns = Array.isArray(waybills) ? waybills.join(',') : waybills;
  const { data } = await client.get('/api/p/packing_slip', {
    params: { wbns, pdf: true, pdf_size: '' },
  });
  const link = data?.packages?.[0]?.pdf_download_link;
  if (!link) throw new Error('No PDF download link returned by Delhivery');
  return link;
}

/**
 * Check the result of an async NDR action.
 * @param {string} uplId - UPL ID returned by ndrAction
 */
export async function getNdrStatus(uplId) {
  const { data } = await client.get(`/api/cmu/get_bulk_upl/${uplId}`, {
    params: { verbose: 'true' },
  });
  return data;
}
