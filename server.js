import express from "express";
import Stripe from "stripe";
import { Resend } from "resend";
import "dotenv/config";

const app = express();

// ✅ Instancias una sola vez
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

// ✅ URLs
const FRONTEND =
  process.env.FRONTEND_ORIGIN || "https://construye-tu-futuro.netlify.app";

// ✅ FROM (mejor controlarlo por ENV siempre)
const RESEND_FROM =
  process.env.RESEND_FROM ||
  "Construye tu futuro <noreply@send.construye-tu-futuro.com>";

/* ======================================================
   1) STRIPE WEBHOOK — RAW BODY (SIEMPRE PRIMERO)
====================================================== */
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      if (!endpointSecret) throw new Error("Missing STRIPE_WEBHOOK_SECRET");
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error("❌ Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      // ===============================
      // ✅ 1) ALTA: Checkout completado
      // ===============================
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        const email =
          session.customer_details?.email ||
          session.customer_email ||
          session.metadata?.email;

        const plan = session.metadata?.plan || "starter";

        console.log("✅ checkout.session.completed:", {
          email,
          plan,
          id: session.id,
          livemode: session.livemode,
        });

        if (email) {
          const resp = await resend.emails.send({
            from: RESEND_FROM,
            to: email,
            subject: "Bienvenido a Construye tu futuro",
            html: `
              <h2>Bienvenido 👋</h2>
              <p>Gracias por suscribirte a <b>Construye tu futuro</b>.</p>
              <p>Plan: <b>${plan}</b></p>
              <p>👉 Accede aquí:
                <a href="${FRONTEND}/login.html">Entrar</a>
              </p>
              <p style="font-size:12px;color:#666;">
                Si no quieres recibir más emails, ignóralos. (MVP)
              </p>
            `,
          });

          console.log("📨 Resend response (welcome):", resp);
          console.log("✅ Welcome email enviado a", email);
        } else {
          console.log("⚠️ checkout.session.completed sin email (no envío welcome).");
        }
      }

      // ==========================================
      // ✅ 2) BAJA: Suscripción cancelada/eliminada
      // ==========================================
      if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;

        console.log("✅ customer.subscription.deleted:", {
          id: sub.id,
          customer: sub.customer,
          status: sub.status,
          livemode: sub.livemode,
        });

        let email = null;

        // sub.customer suele ser "cus_..."
        if (sub.customer) {
          const customer = await stripe.customers.retrieve(sub.customer);
          email = customer?.email || null;
        }

        if (email) {
          const resp = await resend.emails.send({
            from: RESEND_FROM,
            to: email,
            subject: "Tu suscripción ha sido cancelada",
            html: `
              <h2>Suscripción cancelada</h2>
              <p>Tu suscripción a <b>Construye tu futuro</b> ha sido cancelada.</p>
              <p>Si fue un error, puedes volver cuando quieras.</p>
              <p>👉 Volver a la web: <a href="${FRONTEND}">${FRONTEND}</a></p>
              <p style="font-size:12px;color:#666;">
                Si tienes cualquier duda, responde a este email. (MVP)
              </p>
            `,
          });

          console.log("📨 Resend response (cancel):", resp);
          console.log("✅ Email de cancelación enviado a", email);
        } else {
          console.log("⚠️ customer.subscription.deleted sin email (no envío cancel).");
        }
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("❌ Error procesando webhook:", err);
      return res.status(500).send("Webhook handler failed");
    }
  }
);

/* ======================================================
   2) RESTO DEL SERVER (JSON, CORS, STATIC)
====================================================== */
app.use(express.json());

// CORS
app.use((req, res, next) => {
  const origin = process.env.FRONTEND_ORIGIN;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.static("public"));

app.get("/", (req, res) => res.send("Backend OK ✅"));

/* ======================================================
   3) CHECKOUT
====================================================== */
const PRICE = {
  starter: {
    eur: "price_1ShJvPGi85FmhwHAYtS2Nb3C",
    dkk: "price_1ShJvhGi85FmhwHAHRjSMLLy",
  },
  premium: {
    eur: "price_1ShJw3Gi85FmhwHA4IjFtDWR",
    dkk: "price_1ShJwPGi85FmhwHAnLEZAtVN",
  },
};

app.post("/create-checkout-session", async (req, res) => {
  try {
    let { plan, currency, email } = req.body;

    plan = String(plan || "").toLowerCase();
    currency = String(currency || "").toLowerCase();
    email = String(email || "").trim();

    console.log("BODY:", req.body, "-> normalized:", { plan, currency, email });

    if (!PRICE[plan] || !PRICE[plan][currency]) {
      return res.status(400).json({ error: "Plan o moneda inválidos" });
    }
    if (!email) {
      return res.status(400).json({ error: "Falta email" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: PRICE[plan][currency], quantity: 1 }],
      customer_email: email,
      metadata: { plan, email },
      success_url: `${FRONTEND}/?success=1&plan=${plan}`,
      cancel_url: `${FRONTEND}/?canceled=1`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("STRIPE ERROR:", err);
    return res.status(500).json({
      error: err?.raw?.message || err?.message || "Stripe error",
    });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));
