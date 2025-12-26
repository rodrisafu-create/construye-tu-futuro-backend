import express from "express";
import cors from "cors";
import Stripe from "stripe";
import { Resend } from "resend";
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

/* ======================================================
   ENV (Render)
   - STRIPE_MODE = "test" | "live"
   - STRIPE_SECRET_KEY_TEST / STRIPE_SECRET_KEY
   - STRIPE_WEBHOOK_SECRET_TEST / STRIPE_WEBHOOK_SECRET
   - PRICE_STARTER_EUR_TEST / PRICE_STARTER_DKK_TEST / PRICE_PREMIUM_EUR_TEST / PRICE_PREMIUM_DKK_TEST
   - PRICE_STARTER_EUR / PRICE_STARTER_DKK / PRICE_PREMIUM_EUR / PRICE_PREMIUM_DKK
   - DATABASE_URL
   - FRONTEND_ORIGIN (https://construye-tu-futuro.netlify.app)
   - RESEND_API_KEY
   - RESEND_FROM (ej: "Construye tu futuro <noreply@tu-dominio.com>")
====================================================== */

const app = express();

/* ======================================================
   CORS
====================================================== */
const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN || "https://construye-tu-futuro.netlify.app";

app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
  })
);

/* ======================================================
   STRIPE MODE SWITCH
====================================================== */
const STRIPE_MODE = (process.env.STRIPE_MODE || "test").toLowerCase();

const STRIPE_SECRET =
  STRIPE_MODE === "test"
    ? process.env.STRIPE_SECRET_KEY_TEST
    : process.env.STRIPE_SECRET_KEY;

const STRIPE_WEBHOOK_SECRET =
  STRIPE_MODE === "test"
    ? process.env.STRIPE_WEBHOOK_SECRET_TEST
    : process.env.STRIPE_WEBHOOK_SECRET;

if (!STRIPE_SECRET) {
  throw new Error(
    `Missing Stripe secret key for STRIPE_MODE=${STRIPE_MODE}. Set STRIPE_SECRET_KEY_TEST / STRIPE_SECRET_KEY`
  );
}
if (!STRIPE_WEBHOOK_SECRET) {
  throw new Error(
    `Missing Stripe webhook secret for STRIPE_MODE=${STRIPE_MODE}. Set STRIPE_WEBHOOK_SECRET_TEST / STRIPE_WEBHOOK_SECRET`
  );
}

const stripe = new Stripe(STRIPE_SECRET, {
  apiVersion: "2025-02-24.acacia",
});

/* ======================================================
   RESEND
====================================================== */
const resend =
  process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const RESEND_FROM =
  process.env.RESEND_FROM ||
  "Construye tu futuro <noreply@send.construye-tu-futuro.com>";

async function safeSendWelcomeEmail({ to, plan }) {
  try {
    if (!resend) return; // si no hay API key, no hacemos nada
    if (!to) return;

    await resend.emails.send({
      from: RESEND_FROM,
      to,
      subject: "Bienvenido a Construye tu futuro ✅",
      html: `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
          <h2>¡Bienvenido! 👋</h2>
          <p>Tu suscripción se ha activado correctamente.</p>
          <p><b>Plan:</b> ${plan}</p>
          <p>Si tienes cualquier duda, responde a este correo.</p>
        </div>
      `,
    });
  } catch (e) {
    // IMPORTANTÍSIMO: nunca rompas el webhook por el email
    console.error("Resend error (ignored):", e?.message || e);
  }
}

/* ======================================================
   DB (Postgres)
====================================================== */
if (!process.env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL");
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT UNIQUE,
      plan TEXT NOT NULL DEFAULT 'free',
      status TEXT,
      current_period_end TIMESTAMPTZ,
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

function normalizeCurrency(c) {
  const cur = String(c || "eur").toLowerCase();
  return cur === "dkk" ? "dkk" : "eur";
}
function stripeMode() {
  const m = String(process.env.STRIPE_MODE || "test").toLowerCase();
  return m === "live" ? "live" : "test";
}

function normalizeCurrency(currency) {
  return String(currency || "eur").toLowerCase() === "dkk" ? "dkk" : "eur";
}

function priceIdFor(plan, currency) {
  const p = normalizePlan(plan);
  const cur = normalizeCurrency(currency);
  const mode = stripeMode(); // test | live
  const suffix = mode === "live" ? "LIVE" : "TEST";

  if (p === "starter") {
    return process.env[`PRICE_STARTER_${cur.toUpperCase()}_${suffix}`];
  }
  if (p === "premium") {
    return process.env[`PRICE_PREMIUM_${cur.toUpperCase()}_${suffix}`];
  }
  return null;
}

async function upsertUser(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;

  const r = await db.query(
    `
    INSERT INTO users(email, updated_at)
    VALUES ($1, now())
    ON CONFLICT (email)
    DO UPDATE SET updated_at = now()
    RETURNING id, email
  `,
    [e]
  );
  return r.rows[0];
}

async function upsertSubscription({
  userId,
  stripeCustomerId,
  stripeSubscriptionId,
  plan,
  status,
  currentPeriodEnd,
}) {
  await db.query(
    `
    INSERT INTO subscriptions(
      user_id,
      stripe_customer_id,
      stripe_subscription_id,
      plan,
      status,
      current_period_end,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,now())
    ON CONFLICT (stripe_subscription_id)
    DO UPDATE SET
      user_id = EXCLUDED.user_id,
      stripe_customer_id = EXCLUDED.stripe_customer_id,
      plan = EXCLUDED.plan,
      status = EXCLUDED.status,
      current_period_end = EXCLUDED.current_period_end,
      updated_at = now()
  `,
    [
      userId,
      stripeCustomerId || null,
      stripeSubscriptionId || null,
      normalizePlan(plan),
      status || null,
      currentPeriodEnd || null,
    ]
  );
}

async function markCanceled(stripeSubscriptionId) {
  await db.query(
    `
    UPDATE subscriptions
    SET status='canceled',
        current_period_end = now(),
        updated_at = now()
    WHERE stripe_subscription_id = $1
  `,
    [stripeSubscriptionId]
  );
}

async function getEmailFromCustomerId(customerId) {
  if (!customerId) return null;
  try {
    const c = await stripe.customers.retrieve(customerId);
    if (c && typeof c === "object" && "email" in c) return c.email || null;
    return null;
  } catch (e) {
    console.error("Could not retrieve customer:", e?.message || e);
    return null;
  }
}

function tsFromStripeUnixSeconds(sec) {
  if (!sec) return null;
  return new Date(sec * 1000);
}

/* ======================================================
   WEBHOOK (RAW BODY)  ✅ antes de app.use(express.json())
====================================================== */
app.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotencia: guardamos event_id
  try {
    await db.query(
      "INSERT INTO webhook_events(event_id, type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING",
      [event.id, event.type]
    );
  } catch (e) {
    console.error("DB webhook event insert failed (ignored):", e?.message || e);
  }

  try {
    // 1) Checkout completed (cuando termina pago y crea subscription)
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const plan = normalizePlan(session?.metadata?.plan);
      const stripeSubscriptionId = session?.subscription || null;
      const stripeCustomerId = session?.customer || null;

      // Email: si NO pre-rellenas customer_email, el usuario lo escribe y viene aquí
      const email =
        session?.customer_details?.email ||
        session?.customer_email ||
        null;

      // A veces Stripe todavía no mete todo aquí: recuperamos subscription si existe
      if (stripeSubscriptionId) {
        const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);

        const finalEmail = email || (await getEmailFromCustomerId(sub.customer));
        if (finalEmail) {
          const user = await upsertUser(finalEmail);
          await upsertSubscription({
            userId: user.id,
            stripeCustomerId: sub.customer,
            stripeSubscriptionId: sub.id,
            plan: plan || sub?.metadata?.plan || "starter",
            status: sub.status,
            currentPeriodEnd: tsFromStripeUnixSeconds(sub.current_period_end),
          });

          // Email bienvenida (no rompe nada si falla)
          await safeSendWelcomeEmail({ to: finalEmail, plan: plan || "starter" });
        } else {
          console.warn("checkout.session.completed: no email found");
        }
      }
    }

    // 2) Subscription created/updated (estado/renovaciones/etc)
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated"
    ) {
      const sub = event.data.object;

      const plan = normalizePlan(sub?.metadata?.plan);
      const email = await getEmailFromCustomerId(sub.customer);

      if (email) {
        const user = await upsertUser(email);
        await upsertSubscription({
          userId: user.id,
          stripeCustomerId: sub.customer,
          stripeSubscriptionId: sub.id,
          plan: plan || "starter",
          status: sub.status,
          currentPeriodEnd: tsFromStripeUnixSeconds(sub.current_period_end),
        });
      }
    }

    // 3) Subscription deleted (cancel)
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      await markCanceled(sub.id);
    }

    // 4) Invoice paid (por si quieres enganchar lógica aquí también)
    // if (event.type === "invoice.paid") { ... }

    return res.json({ received: true });
  } catch (err) {
    console.error("WEBHOOK HANDLER FAILED:", err);
    return res.status(500).send("Webhook handler failed");
  }
});

/* ======================================================
   JSON middleware para el resto
====================================================== */
app.use(express.json());

/* ======================================================
   ROUTES
====================================================== */
app.get("/health", (_req, res) =>
  res.json({ ok: true, stripe_mode: STRIPE_MODE })
);

/**
 * Create Checkout Session (subscription)
 * ✅ NO customer_creation
 * ✅ NO customer_email => email editable
 */
app.post("/create-checkout-session", async (req, res) => {
  try {
    const plan = normalizePlan(req.body?.plan);
    const currency = normalizeCurrency(req.body?.currency);

    if (plan === "free") {
      return res.status(400).json({ error: "Plan inválido" });
    }

    const price = priceIdFor(plan, currency);
    if (!price) {
      return res.status(500).json({
        error:
          `Missing PRICE ids for mode=${STRIPE_MODE}. Revisa PRICE_*${STRIPE_MODE === "test" ? "_TEST" : ""}`,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      metadata: { plan }, // para leerlo en webhook
      allow_promotion_codes: true,
      success_url: `${FRONTEND_ORIGIN}/?success=1&plan=${plan}#precios`,
      cancel_url: `${FRONTEND_ORIGIN}/?canceled=1#precios`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("STRIPE ERROR:", err);
    return res.status(500).json({
      error: err?.raw?.message || err?.message || "Stripe error",
    });
  }
});

/**
 * Check access by email (simple)
 * Devuelve el plan si hay sub activa/trialing/past_due y no expirada.
 */
function isAccessActive(row) {
  if (!row) return false;
  const status = String(row.status || "").toLowerCase();
  const allowed = ["active", "trialing", "past_due"];
  if (!allowed.includes(status)) return false;
  if (!row.current_period_end) return false;
  return new Date(row.current_period_end).getTime() > Date.now();
}

app.get("/auth/check", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: "Missing email" });

    const r = await db.query(
      `
      SELECT s.plan, s.status, s.current_period_end
      FROM users u
      JOIN subscriptions s ON s.user_id = u.id
      WHERE u.email = $1
      ORDER BY s.current_period_end DESC NULLS LAST
      LIMIT 1
    `,
      [email]
    );

    const row = r.rows[0];
    if (!row || !isAccessActive(row)) {
      return res.status(401).json({ ok: false, plan: "free" });
    }

    return res.json({
      ok: true,
      plan: row.plan,
      status: row.status,
      current_period_end: row.current_period_end,
    });
  } catch (e) {
    console.error("AUTH CHECK ERROR:", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
});

/* ======================================================
   START
====================================================== */
const PORT = process.env.PORT || 4242;

ensureTables()
  .then(() => {
    app.listen(PORT, () =>
      console.log(`🚀 Backend running on port ${PORT} (stripe=${STRIPE_MODE})`)
    );
  })
  .catch((e) => {
    console.error("Failed to init DB:", e);
    process.exit(1);
  });
