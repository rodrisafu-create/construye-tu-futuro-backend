import express from "express";
import cors from "cors";
import Stripe from "stripe";
import pg from "pg";
import { Resend } from "resend";

const { Pool } = pg;

const app = express();

/** =========================
 *  CONFIG / ENV
 *  ========================= */

const STRIPE_MODE = (process.env.STRIPE_MODE || "test").toLowerCase(); // "test" | "live"

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in env`);
  return v;
}

function getStripeSecretKey() {
  // En Render tú tienes STRIPE_SECRET_KEY y STRIPE_SECRET_KEY_TEST
  if (STRIPE_MODE === "live") return requireEnv("STRIPE_SECRET_KEY");
  return requireEnv("STRIPE_SECRET_KEY_TEST");
}

function getStripeWebhookSecret() {
  // En Render tú tienes STRIPE_WEBHOOK_SECRET y STRIPE_WEBHOOK_SECRET_TEST
  if (STRIPE_MODE === "live") return requireEnv("STRIPE_WEBHOOK_SECRET");
  return requireEnv("STRIPE_WEBHOOK_SECRET_TEST");
}

function getPriceId(plan, currency) {
  const cur = String(currency || "eur").toLowerCase() === "dkk" ? "DKK" : "EUR";
  const p = normalizePlan(plan);

  const suffix = STRIPE_MODE === "live" ? "LIVE" : "TEST";

  if (p === "starter") return process.env[`PRICE_STARTER_${cur}_${suffix}`] || null;
  if (p === "premium") return process.env[`PRICE_PREMIUM_${cur}_${suffix}`] || null;
  return null;
}

function frontendBase() {
  // Usa FRONTEND_ORIGIN si lo tienes, si no el netlify
  return process.env.FRONTEND_ORIGIN || "https://construye-tu-futuro.netlify.app";
}

/** =========================
 *  CORS
 *  ========================= */
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

/** =========================
 *  STRIPE
 *  ========================= */
const stripe = new Stripe(getStripeSecretKey(), {
  apiVersion: "2025-02-24.acacia",
});

/** =========================
 *  RESEND (email)
 *  ========================= */
const resendApiKey = process.env.RESEND_API_KEY || "";
const resendFrom = process.env.RESEND_FROM || ""; // ej: "Construye tu futuro <hola@tudominio.com>"
const resend = resendApiKey ? new Resend(resendApiKey) : null;

/** =========================
 *  DB
 *  ========================= */
const db = new Pool({
  connectionString: requireEnv("DATABASE_URL"),
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

async function upsertUser({ email, plan, customerId, subscriptionId }) {
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
}

/** =========================
 *  WEBHOOK (RAW)  🔥
 *  ¡ANTES de express.json()!
 *  ========================= */
app.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const whSecret = getStripeWebhookSecret();

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotencia
  try {
    await db.query(
      "INSERT INTO webhook_events(event_id, type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING",
      [event.id, event.type]
    );
  } catch (e) {
    console.error("DB insert webhook event failed:", e);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const email =
        session?.customer_details?.email ||
        session?.customer_email ||
        null;

      const plan = session?.metadata?.plan || "free";

      await upsertUser({
        email,
        plan,
        customerId: session.customer || null,
        subscriptionId: session.subscription || null,
      });

      // ✅ Email gracias por suscribirte (no bloquea el webhook si falta config)
      if (resend && resendFrom && email) {
        try {
          await resend.emails.send({
            from: resendFrom,
            to: email,
            subject: "Bienvenido a Construye tu futuro",
            html: `
              <div style="font-family:Arial,sans-serif;line-height:1.5">
                <h2>¡Gracias por suscribirte!</h2>
                <p>Tu plan: <b>${plan}</b></p>
                <p>Ya puedes acceder a tu contenido premium.</p>
                <p style="color:#666;font-size:12px">Modo Stripe: ${STRIPE_MODE.toUpperCase()}</p>
              </div>
            `,
          });
        } catch (e) {
          console.error("RESEND send failed:", e?.message || e);
        }
      } else {
        // Esto te ayuda a ver por qué no sale el email
        if (!resend) console.error("RESEND disabled: missing RESEND_API_KEY");
        if (!resendFrom) console.error("RESEND disabled: missing RESEND_FROM");
        if (!email) console.error("No email found in checkout.session.completed");
      }
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated"
    ) {
      const sub = event.data.object;

      let email = null;
      if (sub.customer) {
        const cust = await stripe.customers.retrieve(sub.customer);
        email = cust?.email || null;
      }

      let plan = sub?.metadata?.plan || null;

      // fallback por price id
      const suffix = STRIPE_MODE === "live" ? "LIVE" : "TEST";
      const starterIds = [
        process.env[`PRICE_STARTER_EUR_${suffix}`],
        process.env[`PRICE_STARTER_DKK_${suffix}`],
      ].filter(Boolean);
      const premiumIds = [
        process.env[`PRICE_PREMIUM_EUR_${suffix}`],
        process.env[`PRICE_PREMIUM_DKK_${suffix}`],
      ].filter(Boolean);

      const priceId = sub?.items?.data?.[0]?.price?.id;
      if (!plan && priceId) {
        if (starterIds.includes(priceId)) plan = "starter";
        if (premiumIds.includes(priceId)) plan = "premium";
      }

      await upsertUser({
        email,
        plan: normalizePlan(plan),
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

      if (resend && resendFrom && email) {
        try {
          await resend.emails.send({
            from: resendFrom,
            to: email,
            subject: "Tu suscripción ha sido cancelada",
            html: `<p>Tu suscripción ha sido cancelada. Si fue un error, puedes volver a suscribirte cuando quieras.</p>`,
          });
        } catch (e) {
          console.error("RESEND cancel email failed:", e?.message || e);
        }
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("WEBHOOK HANDLER FAILED:", err);
    return res.status(500).send("Webhook handler failed");
  }
});

/** =========================
 *  JSON para el resto
 *  ========================= */
app.use(express.json());

/** =========================
 *  ROUTES
 *  ========================= */
app.get("/health", (_req, res) => res.json({ ok: true, stripeMode: STRIPE_MODE }));

// Create Checkout Session
app.post("/create-checkout-session", async (req, res) => {
  try {
    const plan = normalizePlan(req.body?.plan);
    const currency = String(req.body?.currency || "eur").toLowerCase() === "dkk" ? "dkk" : "eur";

    if (plan === "free") return res.status(400).json({ error: "Plan inválido" });

    const price = getPriceId(plan, currency);
    if (!price) {
      return res.status(500).json({
        error: `Missing PRICE_* for plan=${plan}, currency=${currency}, mode=${STRIPE_MODE}`,
      });
    }

    const base = frontendBase();

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      metadata: { plan },
      // ✅ NO customer_email => email editable
      success_url: `${base}/?success=1&plan=${plan}#precios`,
      cancel_url: `${base}/?canceled=1#precios`,
      allow_promotion_codes: true,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("CREATE CHECKOUT ERROR:", err);
    return res.status(500).json({ error: err?.raw?.message || err?.message || "Stripe error" });
  }
});

// Get plan by email
app.get("/get-plan", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Missing email" });

    const r = await db.query("SELECT plan FROM users WHERE email=$1", [email]);
    return res.json({ plan: r.rows?.[0]?.plan || "free" });
  } catch (e) {
    console.error("GET PLAN ERROR:", e);
    return res.status(500).json({ error: "server error" });
  }
});

/** =========================
 *  START
 *  ========================= */
const PORT = process.env.PORT || 4242;

ensureTables()
  .then(() => app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT} (mode=${STRIPE_MODE})`)))
  .catch((e) => {
    console.error("Failed to init DB:", e);
    process.exit(1);
  });
