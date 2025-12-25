import express from "express";
import Stripe from "stripe";
import { Resend } from "resend";
import "dotenv/config";

const app = express();

// ✅ Instancias una vez
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const RESEND_FROM =
  process.env.RESEND_FROM || "Construye tu futuro <onboarding@resend.dev>";

// --- CORS simple ---
app.use((req, res, next) => {
  const origin = process.env.FRONTEND_ORIGIN;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/**
 * ✅ Stripe webhook (RAW body)
 * OJO: esta ruta debe ir ANTES de express.json()
 */
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (!endpointSecret) {
      console.error("Falta STRIPE_WEBHOOK_SECRET en variables de entorno.");
      return res.status(500).send("Webhook secret missing");
    }
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("❌ Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const customerEmail =
        session.customer_details?.email ||
        session.customer_email ||
        session.metadata?.email;

      const plan = session.metadata?.plan || "starter";

      if (customerEmail) {
        await resend.emails.send({
          from: RESEND_FROM,
          to: customerEmail,
          subject: "Bienvenido a Construye tu futuro",
          html: `
            <h2>Bienvenido 👋</h2>
            <p>Gracias por suscribirte a <b>Construye tu futuro</b>.</p>
            <p>Plan: <b>${plan}</b></p>
            <p>Tu acceso ya está activo.</p>
            <p>👉 Entra aquí: <a href="https://construye-tu-futuro.netlify.app/login.html">Acceder</a></p>
            <p style="font-size:12px;color:#666;">
              Si no quieres recibir más emails, ignóralos. (MVP)
            </p>
          `,
        });

        console.log("✅ Welcome email enviado a:", customerEmail);
      } else {
        console.log("⚠️ No hay email en la sesión. No se envía welcome email.");
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Error procesando webhook:", err);
    return res.status(500).send("Webhook handler failed");
  }
});

// --- JSON para el resto ---
app.use(express.json());
app.use(express.static("public"));

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

const FRONTEND = process.env.FRONTEND_ORIGIN || "http://localhost:5500";

app.get("/", (req, res) => res.send("Backend OK ✅"));

app.post("/create-checkout-session", async (req, res) => {
  try {
    let { plan, currency, email } = req.body;

    plan = String(plan || "").toLowerCase();
    currency = String(currency || "").toLowerCase();
    email = (email || "").trim();

    if (!PRICE[plan] || !PRICE[plan][currency]) {
      return res.status(400).json({ error: "Plan o moneda inválidos" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: PRICE[plan][currency], quantity: 1 }],
      ...(email ? { customer_email: email } : {}),
      metadata: { plan, ...(email ? { email } : {}) },
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