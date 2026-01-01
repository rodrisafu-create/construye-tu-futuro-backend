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
  if (STRIPE_MODE === "live") return requireEnv("STRIPE_SECRET_KEY");
  return requireEnv("STRIPE_SECRET_KEY_TEST");
}

function getStripeWebhookSecret() {
  if (STRIPE_MODE === "live") return requireEnv("STRIPE_WEBHOOK_SECRET");
  return requireEnv("STRIPE_WEBHOOK_SECRET_TEST");
}

function normalizePlan(p) {
  const plan = String(p || "").toLowerCase();
  if (plan === "starter" || plan === "premium") return plan;
  return "free";
}

function normalizeLang(l) {
  const x = String(l || "").toLowerCase();
  if (x === "es" || x === "en" || x === "da" || x === "fr") return x;
  return "es";
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
  return process.env.FRONTEND_ORIGIN || "https://construye-tu-futuro.com";
}

const SUPPORT_EMAIL = "construyetufuturo.web@gmail.com";

/** =========================
 *  EMAIL TEMPLATES
 *  ========================= */

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function planLabel(plan, lang = "es") {
  const p = String(plan || "").toLowerCase();
  const L = normalizeLang(lang);
  if (p === "starter") {
    if (L === "en") return "Starter";
    if (L === "da") return "Starter";
    if (L === "fr") return "Starter";
    return "Starter";
  }
  if (p === "premium") {
    if (L === "en") return "Premium";
    if (L === "da") return "Premium";
    if (L === "fr") return "Premium";
    return "Premium";
  }
  if (L === "en") return "Free";
  if (L === "da") return "Gratis";
  if (L === "fr") return "Gratuit";
  return "Free";
}

function tEmail(lang) {
  const L = normalizeLang(lang);

  if (L === "en") {
    return {
      brand: "Construye tu futuro",
      welcomeTitle: "Your access is active",
      welcomePreheader: "Your subscription is active. Log in with your email.",
      welcomeHello: "Welcome",
      welcomeLine1: "Your subscription is active and you can now access the dashboard.",
      welcomeBtn: "Go to dashboard",
      welcomeTip: "Tip: use the same email you used on Stripe.",
      usefulLinks: "Useful links",
      backWeb: "Back to website",
      terms: "Terms",
      help: `Need help? Write to ${SUPPORT_EMAIL}.`,
      unknownIgnore: "If you don't recognize this email, ignore it.",
      stripeMode: "Stripe mode",
      cancelTitle: "Subscription cancelled",
      cancelPreheader: "Your subscription was cancelled. You can come back anytime.",
      cancelHello: "Hi",
      cancelLine1: "Your subscription has been cancelled and your access has been deactivated.",
      resubBtn: "Subscribe again",
      cancelHelp: `Need help? Write to ${SUPPORT_EMAIL}.`,
      prices: "Pricing",
      login: "Login",
    };
  }

  if (L === "da") {
    return {
      brand: "Construye tu futuro",
      welcomeTitle: "Din adgang er aktiv",
      welcomePreheader: "Dit abonnement er aktivt. Log ind med din email.",
      welcomeHello: "Velkommen",
      welcomeLine1: "Dit abonnement er aktivt, og du kan nu få adgang til dashboardet.",
      welcomeBtn: "Gå til dashboard",
      welcomeTip: "Tip: brug den samme email som du brugte i Stripe.",
      usefulLinks: "Nyttige links",
      backWeb: "Tilbage til siden",
      terms: "Vilkår",
      help: `Brug for hjælp? Skriv til ${SUPPORT_EMAIL}.`,
      unknownIgnore: "Hvis du ikke genkender denne email, så ignorér den.",
      stripeMode: "Stripe-tilstand",
      cancelTitle: "Abonnement annulleret",
      cancelPreheader: "Dit abonnement er annulleret. Du kan komme tilbage når som helst.",
      cancelHello: "Hej",
      cancelLine1: "Dit abonnement er annulleret, og din adgang er deaktiveret.",
      resubBtn: "Abonnér igen",
      cancelHelp: `Brug for hjælp? Skriv til ${SUPPORT_EMAIL}.`,
      prices: "Priser",
      login: "Login",
    };
  }

  if (L === "fr") {
    return {
      brand: "Construye tu futuro",
      welcomeTitle: "Ton accès est actif",
      welcomePreheader: "Ton abonnement est actif. Connecte-toi avec ton email.",
      welcomeHello: "Bienvenue",
      welcomeLine1: "Ton abonnement est actif et tu peux maintenant accéder au dashboard.",
      welcomeBtn: "Aller au dashboard",
      welcomeTip: "Conseil : utilise le même email que celui utilisé sur Stripe.",
      usefulLinks: "Liens utiles",
      backWeb: "Retour au site",
      terms: "Conditions",
      help: `Besoin d’aide ? Écris à ${SUPPORT_EMAIL}.`,
      unknownIgnore: "Si tu ne reconnais pas cet email, ignore-le.",
      stripeMode: "Mode Stripe",
      cancelTitle: "Abonnement annulé",
      cancelPreheader: "Ton abonnement a été annulé. Tu peux revenir quand tu veux.",
      cancelHello: "Bonjour",
      cancelLine1: "Ton abonnement a été annulé et ton accès a été désactivé.",
      resubBtn: "Me réabonner",
      cancelHelp: `Besoin d’aide ? Écris à ${SUPPORT_EMAIL}.`,
      prices: "Prix",
      login: "Connexion",
    };
  }

  // ES (default)
  return {
    brand: "Construye tu futuro",
    welcomeTitle: "Tu acceso ya está activo",
    welcomePreheader: "Tu suscripción se ha activado. Entra al dashboard con tu email.",
    welcomeHello: "¡Bienvenido",
    welcomeLine1: "Tu suscripción está activa y ya puedes entrar al dashboard.",
    welcomeBtn: "Entrar al dashboard",
    welcomeTip: "Consejo: usa el mismo email con el que pagaste en Stripe.",
    usefulLinks: "Links útiles",
    backWeb: "Volver a la web",
    terms: "Términos",
    help: `¿Necesitas ayuda? Escribe a ${SUPPORT_EMAIL}.`,
    unknownIgnore: "Si no reconoces este correo, ignóralo.",
    stripeMode: "Modo Stripe",
    cancelTitle: "Suscripción cancelada",
    cancelPreheader: "Tu suscripción ha sido cancelada. Puedes volver cuando quieras.",
    cancelHello: "Hola",
    cancelLine1: "Tu suscripción ha sido cancelada y tu acceso se ha desactivado.",
    resubBtn: "Volver a suscribirme",
    cancelHelp: `¿Necesitas ayuda? Escribe a ${SUPPORT_EMAIL}.`,
    prices: "Precios",
    login: "Login",
  };
}

function emailWrapper({ title, preheader, contentHtml, footerHtml }) {
  return `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>${esc(title)}</title>
    </head>
    <body style="margin:0;padding:0;background:#0b1c33;">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
        ${esc(preheader || "")}
      </div>

      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0b1c33;padding:28px 0;">
        <tr>
          <td align="center">
            <table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:640px;max-width:92vw;">
              <tr>
                <td style="padding:18px 6px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
                  <div style="font-size:14px;opacity:.9;">Construye tu futuro</div>
                  <div style="font-size:26px;font-weight:800;line-height:1.15;margin-top:8px;">
                    ${esc(title)}
                  </div>
                </td>
              </tr>

              <tr>
                <td style="padding:0 6px;">
                  <div style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:18px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
                    ${contentHtml}
                  </div>
                </td>
              </tr>

              <tr>
                <td style="padding:14px 6px 0;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:12px;opacity:.75;line-height:1.4;">
                  ${footerHtml || ""}
                  <div style="margin-top:10px;">
                    ${esc(tEmail("es").unknownIgnore)}
                    <br/>
                    <span style="opacity:.9;">${esc(tEmail("es").stripeMode)}: ${esc(STRIPE_MODE.toUpperCase())}</span>
                  </div>
                </td>
              </tr>

            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>
  `.trim();
}

function welcomeSubject(lang, plan) {
  const L = normalizeLang(lang);
  const p = planLabel(plan, L);
  if (L === "en") return `✅ Your access is active — ${p} — Construye tu futuro`;
  if (L === "da") return `✅ Din adgang er aktiv — ${p} — Construye tu futuro`;
  if (L === "fr") return `✅ Ton accès est actif — ${p} — Construye tu futuro`;
  return `✅ Tu acceso ya está activo — ${p} — Construye tu futuro`;
}

function cancelSubject(lang) {
  const L = normalizeLang(lang);
  if (L === "en") return "Your subscription has been cancelled — Construye tu futuro";
  if (L === "da") return "Dit abonnement er annulleret — Construye tu futuro";
  if (L === "fr") return "Ton abonnement a été annulé — Construye tu futuro";
  return "Tu suscripción ha sido cancelada — Construye tu futuro";
}

function welcomeEmailHtml({ email, plan, lang }) {
  const base = frontendBase();
  const L = normalizeLang(lang);
  const tt = tEmail(L);
  const planNice = planLabel(plan, L);

  const contentHtml = `
    <div style="font-size:15px;line-height:1.55;opacity:.95;">
      <p style="margin:0 0 14px;">
        ${esc(tt.welcomeHello)}${email ? `, <b>${esc(email)}</b>` : ""}!
      </p>

      <p style="margin:0 0 14px;">
        ${esc(tt.welcomeLine1)} <b>${esc(planNice)}</b>.
      </p>

      <div style="margin:18px 0 10px;">
        <a href="${esc(base + "/login.html")}"
          style="display:inline-block;background:#b9965b;color:#111;text-decoration:none;font-weight:800;
                 padding:12px 16px;border-radius:12px;">
          ${esc(tt.welcomeBtn)}
        </a>
      </div>

      <div style="margin-top:14px;font-size:13px;opacity:.9;">
        ${esc(tt.welcomeTip)}
      </div>

      <hr style="border:none;border-top:1px solid rgba(255,255,255,.14);margin:16px 0;" />

      <div style="font-size:13px;opacity:.9;">
        <div style="font-weight:800;margin-bottom:8px;">${esc(tt.usefulLinks)}</div>
        <ul style="padding-left:18px;margin:0;">
          <li><a href="${esc(base)}" style="color:#fff;">${esc(tt.backWeb)}</a></li>
          <li><a href="${esc(base + "/terms.html")}" style="color:#fff;">${esc(tt.terms)}</a></li>
        </ul>
      </div>
    </div>
  `;

  const footerHtml = `
    <div>${esc(tt.help)}</div>
  `;

  return emailWrapper({
    title: tt.welcomeTitle,
    preheader: tt.welcomePreheader,
    contentHtml,
    footerHtml,
  });
}

function cancelEmailHtml({ email, lang }) {
  const base = frontendBase();
  const L = normalizeLang(lang);
  const tt = tEmail(L);

  const contentHtml = `
    <div style="font-size:15px;line-height:1.55;opacity:.95;">
      <p style="margin:0 0 14px;">
        ${esc(tt.cancelHello)}${email ? `, <b>${esc(email)}</b>` : ""}.
      </p>

      <p style="margin:0 0 14px;">
        ${esc(tt.cancelLine1)}
      </p>

      <div style="margin:18px 0 10px;">
        <a href="${esc(base + "/#precios")}"
          style="display:inline-block;background:#b9965b;color:#111;text-decoration:none;font-weight:800;
                 padding:12px 16px;border-radius:12px;">
          ${esc(tt.resubBtn)}
        </a>
      </div>

      <div style="margin-top:14px;font-size:13px;opacity:.9;">
        ${esc(tt.cancelHelp)}
      </div>

      <hr style="border:none;border-top:1px solid rgba(255,255,255,.14);margin:16px 0;" />

      <div style="font-size:13px;opacity:.9;">
        <div style="font-weight:800;margin-bottom:8px;">${esc(tt.usefulLinks)}</div>
        <ul style="padding-left:18px;margin:0;">
          <li><a href="${esc(base)}" style="color:#fff;">${esc(tt.backWeb)}</a></li>
          <li><a href="${esc(base + "/terms.html")}" style="color:#fff;">${esc(tt.terms)}</a></li>
          <li><a href="${esc(base + "/login.html")}" style="color:#fff;">${esc(tt.login)}</a></li>
        </ul>
      </div>
    </div>
  `;

  const footerHtml = `
    <div>${esc(tt.cancelHelp)}</div>
  `;

  return emailWrapper({
    title: tt.cancelTitle,
    preheader: tt.cancelPreheader,
    contentHtml,
    footerHtml,
  });
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
      lang TEXT NOT NULL DEFAULT 'es',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ✅ Por si la tabla ya existía sin "lang"
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT 'es';`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id SERIAL PRIMARY KEY,
      event_id TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function upsertUser({ email, plan, customerId, subscriptionId, lang }) {
  if (!email) return;
  const p = normalizePlan(plan);
  const L = normalizeLang(lang);

  await db.query(
    `
    INSERT INTO users(email, plan, lang, stripe_customer_id, stripe_subscription_id, updated_at)
    VALUES ($1, $2, $3, $4, $5, now())
    ON CONFLICT (email) DO UPDATE SET
      plan = EXCLUDED.plan,
      lang = COALESCE(EXCLUDED.lang, users.lang),
      stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, users.stripe_customer_id),
      stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, users.stripe_subscription_id),
      updated_at = now()
    `,
    [email.toLowerCase(), p, L, customerId || null, subscriptionId || null]
  );
}

async function getUserLangByEmail(email) {
  if (!email) return "es";
  const r = await db.query("SELECT lang FROM users WHERE email=$1", [String(email).toLowerCase()]);
  return normalizeLang(r.rows?.[0]?.lang || "es");
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

      const email = session?.customer_details?.email || session?.customer_email || null;
      const plan = session?.metadata?.plan || "free";
      const lang = normalizeLang(session?.metadata?.lang);

      await upsertUser({
        email,
        plan,
        lang,
        customerId: session.customer || null,
        subscriptionId: session.subscription || null,
      });

      // ✅ Email bienvenida en el idioma correcto
      if (resend && resendFrom && email) {
        try {
          await resend.emails.send({
            from: resendFrom,
            to: email,
            subject: welcomeSubject(lang, plan),
            html: welcomeEmailHtml({ email, plan, lang }),
          });
        } catch (e) {
          console.error("RESEND send failed:", e?.message || e);
        }
      } else {
        if (!resend) console.error("RESEND disabled: missing RESEND_API_KEY");
        if (!resendFrom) console.error("RESEND disabled: missing RESEND_FROM");
        if (!email) console.error("No email found in checkout.session.completed");
      }
    }

    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
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

      // lang: si no viene en metadata, mantenemos el que ya tenga el usuario
      const currentLang = email ? await getUserLangByEmail(email) : "es";

      await upsertUser({
        email,
        plan: normalizePlan(plan),
        lang: currentLang,
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

      const currentLang = email ? await getUserLangByEmail(email) : "es";

      await upsertUser({
        email,
        plan: "free",
        lang: currentLang,
        customerId: sub.customer || null,
        subscriptionId: null,
      });

      // ✅ Email cancelación en idioma del usuario
      if (resend && resendFrom && email) {
        try {
          await resend.emails.send({
            from: resendFrom,
            to: email,
            subject: cancelSubject(currentLang),
            html: cancelEmailHtml({ email, lang: currentLang }),
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
    const lang = normalizeLang(req.body?.lang);

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
      metadata: { plan, lang }, // ✅ IMPORTANTE: el idioma viaja a Stripe
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
  .then(() =>
    app.listen(PORT, () =>
      console.log(`🚀 Backend running on port ${PORT} (mode=${STRIPE_MODE})`)
    )
  )
  .catch((e) => {
    console.error("Failed to init DB:", e);
    process.exit(1);
  });
