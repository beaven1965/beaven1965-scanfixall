// This runs on Netlify's servers, not in the visitor's browser.
// It holds the real PayMongo secret key (set as an Environment Variable
// in Netlify) so it's never visible to anyone using the app.
//
// What it does: creates a PayMongo "Checkout Session" — a payment page
// hosted by PayMongo itself — and hands back the URL to send the visitor to.
// We never touch card numbers ourselves; PayMongo's page handles that.

// Prices in pesos — change these numbers any time to adjust them.
// verify-payment.js and verify-payment-by-id.js tell the plans apart by amount,
// so if you change CLASS here, change CLASS_MIN_CENTAVOS there too.
const PLANS = {
  family: { pesos: 250,  name: 'ScanFixAll Family Premium (30 days)', description: 'ScanFixAll Family Premium — you + up to 5 family members, 30 days, one-time payment (no auto-renew)' },
  class:  { pesos: 1500, name: 'ScanFixAll Class Plan (30 days)',     description: 'ScanFixAll Class Plan — teacher + up to 50 students, 30 days, one-time payment (no auto-renew)' }
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const secretKey = process.env.PAYMONGO_SECRET_KEY;
    if (!secretKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is not configured with a PayMongo key yet.' }) };
    }

    // Figure out this site's own web address, so PayMongo knows where to
    // send the visitor back to after they pay (works on the live site).
    const origin = event.headers.origin || ('https://' + event.headers.host);

    let chosen = 'family';
    try { if (JSON.parse(event.body || '{}').plan === 'class') chosen = 'class'; } catch (e) {}
    const plan = PLANS[chosen];

    const res = await fetch('https://api.paymongo.com/v2/checkout_sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(secretKey + ':').toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: {
          attributes: {
            line_items: [
              {
                name: plan.name,
                amount: plan.pesos * 100, // PayMongo expects centavos
                currency: 'PHP',
                quantity: 1
              }
            ],
            payment_method_types: ['card', 'gcash', 'qrph'],
            success_url: origin + '/?paid=success',
            cancel_url: origin + '/?paid=cancelled',
            description: plan.description,
            send_email_receipt: true
          }
        }
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Could not start checkout (' + res.status + ').', detail: errText })
      };
    }

    const data = await res.json();
    const checkoutUrl = data && data.data && data.data.attributes && data.data.attributes.checkout_url;
    if (!checkoutUrl) {
      return { statusCode: 502, body: JSON.stringify({ error: 'PayMongo did not return a checkout link.' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkout_url: checkoutUrl })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
