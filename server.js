import express from "express";
import cors from "cors";
import Stripe from "stripe";
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const app = express();

// ---------- CORS ----------
app.use(
  cors({
    origin: true, // si quieres fijo: ["http://localhost:5173","https://construye-tu-futuro.netlify.app"]
    credentials: true,
  })
);

// ---------- STRIPE ----------
if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY in .env");
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-02-24.acacia",
});

// ---------- DB ----------
if (!process.env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL in .env");
}
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id SERIAL PRIMARY KEY,
      event_id TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function normalizePlan(p) {
  const plan = String(p || "").toLowerCase();
  if (plan === "starter" || plan === "premium") return plan;
  return "free";
}

function priceIdFor(plan, currency) {
  const cur = String(currency || "eur").toLowerCase() === "dkk" ? "DKK" : "EUR";
  const p = normalizePlan(plan);

  if (p === "starter") {
    return cur === "DKK" ? process.env.PRICE_STARTER_DKK : process.env.PRICE_STARTER_EUR;
  }
  if (p === "premium") {
    return cur === "DKK" ? process.env.PRICE_PREMIUM_DKK : process.env.PRICE_PREMIUM_EUR;
  }
  return null;
}

function frontendBase() {
  return process.env.FRONTEND_URL || "https://construye-tu-futuro.netlify.app";
}

// ======================================================
// WEBHOOK (RAW BODY)  ✅ IMPORTANTE: antes del json()
// ======================================================
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const whSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!whSecret) {
      console.error("Missing STRIPE_WEBHOOK_SECRET");
      return res.status(500).send("Missing webhook secret");
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // idempotencia simple
    try {
      await db.query(
        "INSERT INTO webhook_events(event_id, type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING",
        [event.id, event.type]
      );
    } catch (e) {
      console.error("DB insert webhook event failed:", e);
      // seguimos igualmente
    }

    try {
      // ---- Helpers ----
      const upsertUser = async ({ email, plan, customerId, subscriptionId }) => {
        if (!email) return;
        const p = normalizePlan(plan);

        await db.query(
          `
          INSERT INTO users(email, plan, stripe_customer_id, stripe_subscription_id, updated_at)
          VALUES ($1, $2, $3, $4, now())
          ON CONFLICT (email) DO UPDATE SET
            plan = EXCLUDED.plan,
            stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, users.stripe_customer_id),
            stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, users.stripe_subscription_id),
            updated_at = now()
        `,
          [email.toLowerCase(), p, customerId || null, subscriptionId || null]
        );
      };

      // ---- Events ----
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        // Email (checkout permite editarlo porque NO lo prellenamos con customer_email)
        const email =
          session?.customer_details?.email ||
          session?.customer_email ||
          null;

        // Plan viene de metadata que ponemos al crear sesión
        const plan = session?.metadata?.plan || "free";

        await upsertUser({
          email,
          plan,
          customerId: session.customer || null,
          subscriptionId: session.subscription || null,
        });
      }

      if (
        event.type === "customer.subscription.created" ||
        event.type === "customer.subscription.updated"
      ) {
        const sub = event.data.object;

        // Recuperar email desde customer
        let email = null;
        if (sub.customer) {
          const cust = await stripe.customers.retrieve(sub.customer);
          email = cust?.email || null;
        }

        // decidir plan por metadata del subscription (si existe) o por price
        let plan = sub?.metadata?.plan || null;
        if (!plan && sub?.items?.data?.[0]?.price?.id) {
          const priceId = sub.items.data[0].price.id;
          const starterIds = [process.env.PRICE_STARTER_EUR, process.env.PRICE_STARTER_DKK].filter(Boolean);
          const premiumIds = [process.env.PRICE_PREMIUM_EUR, process.env.PRICE_PREMIUM_DKK].filter(Boolean);
          if (starterIds.includes(priceId)) plan = "starter";
          if (premiumIds.includes(priceId)) plan = "premium";
        }
        plan = normalizePlan(plan);

        await upsertUser({
          email,
          plan,
          customerId: sub.customer || null,
          subscriptionId: sub.id || null,
        });
      }

      if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;

        let email = null;
        if (sub.customer) {
          const cust = await stripe.customers.retrieve(sub.customer);
          email = cust?.email || null;
        }

        await upsertUser({
          email,
          plan: "free",
          customerId: sub.customer || null,
          subscriptionId: null,
        });
      }

      // Siempre responde 200 si todo ok
      return res.json({ received: true });
    } catch (err) {
      console.error("WEBHOOK HANDLER FAILED:", err);
      return res.status(500).send("Webhook handler failed");
    }
  }
);

// ======================================================
// JSON para el resto de rutas
// ======================================================
app.use(express.json());

// ======================================================
// HEALTH
// ======================================================
app.get("/health", (_req, res) => res.json({ ok: true }));

// ======================================================
// CREATE CHECKOUT SESSION (SUBSCRIPTION) ✅
// - NO customer_creation
// - NO customer_email  => email editable en Checkout
// ======================================================
app.post("/create-checkout-session", async (req, res) => {
  try {
    const plan = normalizePlan(req.body?.plan);
    const currency = String(req.body?.currency || "eur").toLowerCase() === "dkk" ? "dkk" : "eur";

    if (plan === "free") {
      return res.status(400).json({ error: "Plan inválido" });
    }

    const price = priceIdFor(plan, currency);
    if (!price) {
      return res.status(500).json({
        error:
          "Faltan PRICE_* en .env. Revisa PRICE_STARTER_EUR/DKK y PRICE_PREMIUM_EUR/DKK",
      });
    }

    const base = frontendBase();

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      // ✅ Esto hace que luego en checkout.session.completed sepamos el plan
      metadata: { plan },

      // ✅ Email editable: no pasamos customer_email ni customer
      // Stripe pedirá email dentro del checkout.

      success_url: `${base}/?success=1&plan=${plan}#precios`,
      cancel_url: `${base}/?canceled=1#precios`,
      allow_promotion_codes: true,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("STRIPE ERROR:", err);
    return res.status(500).json({
      error: err?.raw?.message || err?.message || "Stripe error",
    });
  }
});

// ======================================================
// GET PLAN (para dashboard o front) - por email
// ======================================================
app.get("/get-plan", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Missing email" });

    const r = await db.query("SELECT plan FROM users WHERE email=$1", [email]);
    const plan = r.rows?.[0]?.plan || "free";
    return res.json({ plan });
  } catch (e) {
    console.error("GET PLAN ERROR:", e);
    return res.status(500).json({ error: "server error" });
  }
});

// ======================================================
// START
// ======================================================
const PORT = process.env.PORT || 4242;

ensureTables()
  .then(() => {
    app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
  })
  .catch((e) => {
    console.error("Failed to init DB:", e);
    process.exit(1);
  });
