/**
 * Pipedrive → QuickBooks Online Invoice Automation
 * Triggered by Make.com webhook when a Pipedrive deal moves to "Won"
 *
 * Deploy this to: Render, Railway, Heroku, or any Node.js host
 * Make.com calls this endpoint with the deal payload
 */

const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ─── CONFIG (set these as environment variables) ────────────────────────────
const CONFIG = {
  // QuickBooks
  QBO_CLIENT_ID: process.env.QBO_CLIENT_ID,
  QBO_CLIENT_SECRET: process.env.QBO_CLIENT_SECRET,
  QBO_REFRESH_TOKEN: process.env.QBO_REFRESH_TOKEN, // long-lived token from OAuth
  QBO_REALM_ID: process.env.QBO_REALM_ID,           // your QBO Company ID
  QBO_SANDBOX: process.env.QBO_SANDBOX === "true",   // true while testing

  // Pipedrive
  PIPEDRIVE_API_TOKEN: process.env.PIPEDRIVE_API_TOKEN,

  // Security: Make.com will send this in the header so random people can't trigger your endpoint
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
};

const QBO_BASE = CONFIG.QBO_SANDBOX
  ? "https://sandbox-quickbooks.api.intuit.com"
  : "https://quickbooks.api.intuit.com";

// ─── STEP 1: Refresh QBO Access Token ───────────────────────────────────────
async function getQBOAccessToken() {
  const credentials = Buffer.from(
    `${CONFIG.QBO_CLIENT_ID}:${CONFIG.QBO_CLIENT_SECRET}`
  ).toString("base64");

  const response = await axios.post(
    "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: CONFIG.QBO_REFRESH_TOKEN,
    }),
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  // IMPORTANT: QBO issues a NEW refresh token each time — save it!
  // In production, persist this to your DB or env so you don't lose access
  if (response.data.refresh_token !== CONFIG.QBO_REFRESH_TOKEN) {
    console.log("⚠️  New refresh token issued — update QBO_REFRESH_TOKEN env var:");
    console.log(response.data.refresh_token);
    // TODO: auto-persist to your secrets manager / DB
  }

  return response.data.access_token;
}

// ─── STEP 2: Find or Create QBO Customer from Pipedrive contact ─────────────
async function findOrCreateCustomer(accessToken, contact) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  // Search for existing customer by email
  const searchRes = await axios.get(
    `${QBO_BASE}/v3/company/${CONFIG.QBO_REALM_ID}/query`,
    {
      params: {
        query: `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${contact.email}'`,
      },
      headers,
    }
  );

  const existing = searchRes.data?.QueryResponse?.Customer;
  if (existing && existing.length > 0) {
    console.log(`Found existing QBO customer: ${existing[0].DisplayName}`);
    return existing[0].Id;
  }

  // Create new customer
  const createRes = await axios.post(
    `${QBO_BASE}/v3/company/${CONFIG.QBO_REALM_ID}/customer`,
    {
      DisplayName: contact.name,
      PrimaryEmailAddr: { Address: contact.email },
      PrimaryPhone: { FreeFormNumber: contact.phone || "" },
      BillAddr: {
        Line1: contact.address || "",
      },
    },
    { headers: { ...headers, "Content-Type": "application/json" } }
  );

  const newCustomer = createRes.data.Customer;
  console.log(`Created new QBO customer: ${newCustomer.DisplayName} (ID: ${newCustomer.Id})`);
  return newCustomer.Id;
}

// ─── STEP 3: Fetch Pipedrive Deal Details ───────────────────────────────────
async function getPipedriveDetails(dealId) {
  // Get deal info
  const dealRes = await axios.get(
    `https://api.pipedrive.com/v1/deals/${dealId}`,
    { params: { api_token: CONFIG.PIPEDRIVE_API_TOKEN } }
  );
  const deal = dealRes.data.data;

  // Get deal products (line items)
  const productsRes = await axios.get(
    `https://api.pipedrive.com/v1/deals/${dealId}/products`,
    { params: { api_token: CONFIG.PIPEDRIVE_API_TOKEN } }
  );
  const products = productsRes.data.data || [];

  // Get contact person
  let contact = { name: deal.title, email: "", phone: "", address: "" };
  if (deal.person_id) {
    const personRes = await axios.get(
      `https://api.pipedrive.com/v1/persons/${deal.person_id.value}`,
      { params: { api_token: CONFIG.PIPEDRIVE_API_TOKEN } }
    );
    const person = personRes.data.data;
    contact = {
      name: person.name,
      email: person.email?.[0]?.value || "",
      phone: person.phone?.[0]?.value || "",
      address: person.address || "",
    };
  }

  return { deal, products, contact };
}

// ─── STEP 4: Build QBO Invoice Line Items from Pipedrive Products ────────────
function buildLineItems(pipedriveProducts, dealTitle) {
  if (!pipedriveProducts || pipedriveProducts.length === 0) {
    // Fallback: single line item for the deal value
    return [
      {
        Amount: 0,
        DetailType: "SalesItemLineDetail",
        Description: dealTitle,
        SalesItemLineDetail: {
          Qty: 1,
          UnitPrice: 0,
        },
      },
    ];
  }

  return pipedriveProducts.map((product) => ({
    Amount: product.sum,
    DetailType: "SalesItemLineDetail",
    Description: product.name,
    SalesItemLineDetail: {
      Qty: product.quantity,
      UnitPrice: product.item_price,
      // Optional: map to a QBO Item by name if you have a matching catalog
      // ItemRef: { name: product.name }
    },
  }));
}

// ─── STEP 5: Create the QBO Invoice ─────────────────────────────────────────
async function createQBOInvoice(accessToken, customerId, deal, lineItems) {
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const dueDate = new Date(Date.now() + 30 * 86400000)
    .toISOString()
    .split("T")[0]; // Net 30

  const invoicePayload = {
    CustomerRef: { value: customerId },
    DocNumber: `PD-${deal.id}`, // ties back to Pipedrive deal ID
    TxnDate: today,
    DueDate: dueDate,
    PrivateNote: `Auto-created from Pipedrive Deal #${deal.id}: ${deal.title}`,
    Line: lineItems,
  };

  const response = await axios.post(
    `${QBO_BASE}/v3/company/${CONFIG.QBO_REALM_ID}/invoice`,
    invoicePayload,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }
  );

  return response.data.Invoice;
}

// ─── MAIN WEBHOOK ENDPOINT ───────────────────────────────────────────────────
// Make.com will POST to: https://your-server.com/webhook/deal-won
app.post("/webhook/deal-won", async (req, res) => {
  // Verify webhook secret
  if (req.headers["x-webhook-secret"] !== CONFIG.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { deal_id, status } = req.body;

  // Only process "won" deals (Make.com filter should handle this, but double-check)
  if (status && status !== "won") {
    return res.json({ message: "Not a won deal, skipping." });
  }

  if (!deal_id) {
    return res.status(400).json({ error: "Missing deal_id in payload" });
  }

  try {
    console.log(`\n🔄 Processing Pipedrive deal #${deal_id}...`);

    // 1. Get fresh QBO token
    const accessToken = await getQBOAccessToken();

    // 2. Pull deal data from Pipedrive
    const { deal, products, contact } = await getPipedriveDetails(deal_id);
    console.log(`   Deal: "${deal.title}" | Contact: ${contact.name} (${contact.email})`);
    console.log(`   Products: ${products.length} line item(s)`);

    // 3. Find or create QBO customer
    const customerId = await findOrCreateCustomer(accessToken, contact);

    // 4. Build line items
    const lineItems = buildLineItems(products, deal.title);

    // 5. Create invoice
    const invoice = await createQBOInvoice(accessToken, customerId, deal, lineItems);

    console.log(`✅ QBO Invoice created: #${invoice.DocNumber} (ID: ${invoice.Id})`);
    console.log(`   Total: $${invoice.TotalAmt}`);

    return res.json({
      success: true,
      invoice_id: invoice.Id,
      invoice_number: invoice.DocNumber,
      total: invoice.TotalAmt,
      customer: contact.name,
    });
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    return res.status(500).json({
      error: err.message,
      details: err.response?.data || null,
    });
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "Sunhouse QB Webhook running ✅" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));
