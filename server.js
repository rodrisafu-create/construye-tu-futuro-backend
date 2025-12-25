import express from "express";
import Stripe from "stripe";
import { Resend } from "resend";
import "dotenv/config";

const app = express();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const FRONTEND = process.env.FRONTEND_ORIGIN || "https://construye-tu-futuro.netlify.app";
const RESEND_FROM = process.env.RESEND_FROM || "Construye tu futuro <noreply@send.construye-tu-futuro.com>";

/* ======================================================
   1) STRIPE WEBHOOK — RAW BODY (SIEMPRE PRIMERO)
====================================================== */
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
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
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const email =
        session.customer_details?.email ||
        session.customer_email ||
        session.metadata?.email;

      const plan = session.metadata?.plan || "starter";

      if (email) {
        await resend.emails.send({
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

        console.log("✅ Email enviado a", email);
      } else {
        console.log("⚠️ checkout.session.completed sin email (no envío welcome).");
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Error procesando webhook:", err);
    return res.status(500).send("Webhook handler failed");
  }
});

/* ======================================================
   2) RESTO DEL SERVER (JSON, CORS, STATIC)
====================================================== */
app.use(express.json());

app.use((req, res, next) => {
  const origin = process.env.FRONTEND_ORIGIN;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.static("public"));

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
