// services/watiService.js
import fetch from 'node-fetch';

const WATI_BASE_URL = process.env.WATI_BASE_URL; // e.g. https://live-mt-server.wati.io/1087297
const WATI_API_TOKEN = process.env.WATI_API_TOKEN;
const WATI_CHANNEL_NUMBER = process.env.WATI_CHANNEL_NUMBER || '918946089717';

/**
 * Sends a low_stock_alert WhatsApp template to each of the given phone numbers.
 * Template parameters: {{1}} = productName, {{2}} = currentStock
 *
 * @param {string} productName
 * @param {number} currentStock
 * @param {string[]} alertPhones  - array of numbers like "919876543210" (no +)
 */
export async function sendLowStockAlert(productName, currentStock, alertPhones = []) {
  if (!WATI_BASE_URL || !WATI_API_TOKEN) {
    console.warn('⚠️  WATI credentials not set — skipping low stock WhatsApp alert');
    return;
  }
  if (!alertPhones.length) return;

  for (const phone of alertPhones) {
    const whatsappNumber = phone.startsWith('+') ? phone : `+${phone}`;
    const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`;

    const body = {
      template_name: 'low_stock_alert',
      broadcast_name: 'low_stock_alert',
      parameters: [
        { name: '1', value: productName },
        { name: '2', value: String(currentStock) },
      ],
      channel_number: WATI_CHANNEL_NUMBER,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          accept: '*/*',
          Authorization: `Bearer ${WATI_API_TOKEN}`,
          'Content-Type': 'application/json-patch+json',
        },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error(`❌ WATI low_stock_alert failed [${response.status}] to ${whatsappNumber}:`, data);
      } else {
        console.log(`✅ WATI low_stock_alert sent to ${whatsappNumber} — ${productName} (${currentStock} left)`);
      }
    } catch (err) {
      console.error('❌ WATI low_stock_alert request error:', err.message);
    }
  }
}

/**
 * Sends an order welcome WhatsApp template on first payment.
 * Template name is configurable; no parameters assumed (template is fixed text).
 *
 * @param {string} phone        - customer phone, e.g. "7305504500" or "917305504500"
 * @param {string} name         - customer name (sent as {{1}} if template uses it)
 * @param {string} templateName - Wati template name, e.g. "order_welcome"
 */
export async function sendOrderWelcome(phone, name, templateName) {
  if (!WATI_BASE_URL || !WATI_API_TOKEN) {
    console.warn('⚠️  WATI credentials not set — skipping order welcome message');
    return;
  }
  if (!templateName) return;

  // Normalise: ensure country code prefix
  let normalised = phone.replace(/\D/g, '');
  if (normalised.length === 10) normalised = '91' + normalised;
  const whatsappNumber = '+' + normalised;

  const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`;

  const body = {
    template_name:   templateName,
    broadcast_name:  templateName,
    parameters:      [],  //{ name: '1', value: name || 'Student' } only avalable if template has {{1}} parameter
    channel_number:  '916383514285',
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: '*/*',
        Authorization: `Bearer ${WATI_API_TOKEN}`,
        'Content-Type': 'application/json-patch+json',
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`❌ WATI ${templateName} failed [${response.status}] to ${whatsappNumber}:`, data);
    } else {
      console.log(`✅ WATI ${templateName} sent to ${whatsappNumber}`);
    }
  } catch (err) {
    console.error(`❌ WATI ${templateName} request error:`, err.message);
  }
}

/**
 * Website purchase confirmation — template: order_confirmation_website
 * Has {{1}} = customer name parameter.
 *
 * @param {string} phone - customer phone, e.g. "7305504500" or "917305504500"
 * @param {string} name  - customer name sent as {{1}}
 */
export async function sendWebsitePurchaseConfirmation(phone, name) {
  if (!WATI_BASE_URL || !WATI_API_TOKEN) {
    console.warn('⚠️  WATI credentials not set — skipping website purchase confirmation');
    return;
  }
  if (!phone) return;

  let normalised = phone.replace(/\D/g, '');
  if (normalised.length === 10) normalised = '91' + normalised;
  const whatsappNumber = '+' + normalised;

  const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`;

  const body = {
    template_name:  'order_confirmation_website',
    broadcast_name: 'order_confirmation_website',
    parameters: [
      { name: 'name', value: name || 'Student' },
    ],
    channel_number: '916383514285',
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: '*/*',
        Authorization: `Bearer ${WATI_API_TOKEN}`,
        'Content-Type': 'application/json-patch+json',
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`❌ WATI order_confirmation_website failed [${response.status}] to ${whatsappNumber}:`, data);
    } else {
      console.log(`✅ WATI order_confirmation_website sent to ${whatsappNumber}`);
    }
  } catch (err) {
    console.error('❌ WATI order_confirmation_website request error:', err.message);
  }
}

/**
 * Combo store purchase confirmation — template: order_conformation_custom
 * Has {{name}} = customer name parameter.
 *
 * @param {string} phone - customer phone, e.g. "7305504500" or "917305504500"
 * @param {string} name  - customer name sent as {{name}}
 */
export async function sendComboPurchaseConfirmation(phone, name) {
  if (!WATI_BASE_URL || !WATI_API_TOKEN) {
    console.warn('⚠️  WATI credentials not set — skipping combo purchase confirmation');
    return;
  }
  if (!phone) return;

  let normalised = phone.replace(/\D/g, '');
  if (normalised.length === 10) normalised = '91' + normalised;
  const whatsappNumber = '+' + normalised;

  const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`;

  const body = {
    template_name:  'order_conformation_custom',
    broadcast_name: 'order_conformation_custom',
    parameters: [
      { name: 'name', value: name || 'Student' },
    ],
    channel_number: '916383514285',
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: '*/*',
        Authorization: `Bearer ${WATI_API_TOKEN}`,
        'Content-Type': 'application/json-patch+json',
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`❌ WATI order_conformation_custom failed [${response.status}] to ${whatsappNumber}:`, data);
    } else {
      console.log(`✅ WATI order_conformation_custom sent to ${whatsappNumber}`);
    }
  } catch (err) {
    console.error('❌ WATI order_conformation_custom request error:', err.message);
  }
}

/**
 * Sends the course_enroll WhatsApp template to a user.
 *
 * @param {object} params
 * @param {string} params.phoneNumber  - E.164 format, e.g. "+917305504500"
 * @param {string} params.name         - Customer's name
 * @param {string} params.courseName   - Enrolled course name
 */
export async function sendCourseEnrollMessage({ phoneNumber, name, courseName }) {
  if (!WATI_BASE_URL || !WATI_API_TOKEN) {
    console.warn('⚠️  WATI credentials not set — skipping WhatsApp notification');
    return;
  }

  // Normalise phone: WATI expects the number in the query string with leading +
  const whatsappNumber = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;

  const url = `${WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(whatsappNumber)}`;

  const body = {
    template_name: 'course_enroll',
    broadcast_name: 'ca_enrollment',
    parameters: [
      { name: 'name', value: name || 'Student' },
      { name: '2',    value: courseName },
      { name: '3',    value: courseName },
    ],
    channel_number: WATI_CHANNEL_NUMBER,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: '*/*',
        Authorization: `Bearer ${WATI_API_TOKEN}`,
        'Content-Type': 'application/json-patch+json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(`❌ WATI sendTemplateMessage failed [${response.status}]:`, data);
    } else {
      console.log(`✅ WATI course_enroll sent to ${whatsappNumber}`);
    }
  } catch (err) {
    // Non-fatal — don't let a WhatsApp failure break the purchase flow
    console.error('❌ WATI request error:', err.message);
  }
}
