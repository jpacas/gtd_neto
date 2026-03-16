import express from 'express';
import Stripe from 'stripe';
import { getUserSubscription, upsertSubscription } from '../../lib/store.js';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';

export function createBillingRoutes({ renderPage, APP_URL }) {
  const router = express.Router();
  const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

  // GET /pricing — public, shows trial + plan info
  router.get('/pricing', (req, res) => {
    const reason = String(req.query.reason || '');
    const cancelled = Boolean(req.query.cancelled);
    return renderPage(res, 'pricing', {
      title: 'Planes — GTD_Neto',
      hideAppNav: !req.auth?.user,
      reason,
      cancelled,
      trialDays: 14,
    });
  });

  // GET /billing/checkout — creates Stripe Checkout Session and redirects
  router.get('/billing/checkout', async (req, res) => {
    if (!stripe) {
      console.error('[billing/checkout] Stripe not configured (missing STRIPE_SECRET_KEY)');
      return res.redirect('/pricing?error=billing_unavailable');
    }

    const userId = req.auth?.user?.id;
    const email = req.auth?.user?.email;

    if (!userId || !email) return res.redirect('/login');

    try {
      let sub = await getUserSubscription(userId);
      let customerId = sub?.stripe_customer_id;

      if (!customerId) {
        const customer = await stripe.customers.create({
          email,
          metadata: { user_id: userId },
        });
        customerId = customer.id;
        sub = await upsertSubscription(userId, { stripe_customer_id: customerId });
      }

      // If trial is still active, honour the remaining trial on Stripe side
      const trialEnd = sub?.status === 'trialing' && sub?.trial_ends_at && new Date(sub.trial_ends_at) > new Date()
        ? Math.floor(new Date(sub.trial_ends_at).getTime() / 1000)
        : undefined;

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
        mode: 'subscription',
        subscription_data: trialEnd ? { trial_end: trialEnd } : {},
        success_url: `${APP_URL}/billing/success`,
        cancel_url: `${APP_URL}/billing/cancel`,
      });

      return res.redirect(303, session.url);
    } catch (err) {
      console.error('[billing/checkout] Stripe error:', err.message);
      return res.redirect('/pricing?error=checkout_failed');
    }
  });

  // POST /billing/webhook — Stripe events (raw body, no CSRF, signature verified)
  router.post('/billing/webhook', async (req, res) => {
    if (!stripe) return res.status(400).json({ error: 'Billing not configured' });
    if (!STRIPE_WEBHOOK_SECRET) {
      console.error('[billing/webhook] STRIPE_WEBHOOK_SECRET not set');
      return res.status(400).json({ error: 'Webhook secret not configured' });
    }

    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.warn('[billing/webhook] Signature invalid:', err.message);
      return res.status(400).send('Webhook signature verification failed');
    }

    const obj = event.data.object;

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const customerId = obj.customer;
          const subscriptionId = obj.subscription;
          const customer = await stripe.customers.retrieve(customerId);
          const userId = customer.metadata?.user_id;
          if (userId) {
            await upsertSubscription(userId, {
              status: 'active',
              stripe_customer_id: customerId,
              stripe_subscription_id: subscriptionId,
            });
          }
          console.info('[billing/webhook] checkout.session.completed', { customerId, userId });
          break;
        }
        case 'customer.subscription.updated': {
          const customerId = obj.customer;
          const customer = await stripe.customers.retrieve(customerId);
          const userId = customer.metadata?.user_id;
          if (userId) {
            const statusMap = { trialing: 'trialing', active: 'active', past_due: 'past_due' };
            const status = statusMap[obj.status] || 'canceled';
            await upsertSubscription(userId, {
              status,
              stripe_subscription_id: obj.id,
              current_period_end: new Date(obj.current_period_end * 1000).toISOString(),
            });
          }
          break;
        }
        case 'customer.subscription.deleted': {
          const customerId = obj.customer;
          const customer = await stripe.customers.retrieve(customerId);
          const userId = customer.metadata?.user_id;
          if (userId) {
            await upsertSubscription(userId, {
              status: 'canceled',
              stripe_subscription_id: obj.id,
              current_period_end: new Date(obj.current_period_end * 1000).toISOString(),
            });
          }
          console.info('[billing/webhook] subscription.deleted', { customerId, userId });
          break;
        }
        case 'invoice.payment_failed': {
          const customerId = obj.customer;
          const customer = await stripe.customers.retrieve(customerId);
          const userId = customer.metadata?.user_id;
          if (userId) {
            await upsertSubscription(userId, { status: 'past_due' });
          }
          console.warn('[billing/webhook] invoice.payment_failed', { customerId, userId });
          break;
        }
        default:
          // Unknown event — Stripe expects 200 so it doesn't retry
          break;
      }
    } catch (err) {
      console.error('[billing/webhook] Processing error:', { event_type: event.type, error: err.message });
      // Return 500 so Stripe retries (idempotent upserts make this safe)
      return res.status(500).json({ error: 'Webhook processing failed' });
    }

    return res.json({ received: true });
  });

  // GET /billing/success — post-checkout redirect
  router.get('/billing/success', (req, res) => {
    return renderPage(res, 'billing-success', { title: '¡Suscripción activada! — GTD_Neto' });
  });

  // GET /billing/cancel — user cancelled checkout, send back to pricing
  router.get('/billing/cancel', (req, res) => {
    return res.redirect('/pricing?cancelled=1');
  });

  // GET /billing/portal — Stripe Customer Portal to manage/cancel subscription
  router.get('/billing/portal', async (req, res) => {
    if (!stripe) return res.redirect('/pricing');

    const userId = req.auth?.user?.id;
    if (!userId) return res.redirect('/login');

    try {
      const sub = await getUserSubscription(userId);
      if (!sub?.stripe_customer_id) return res.redirect('/pricing');

      const session = await stripe.billingPortal.sessions.create({
        customer: sub.stripe_customer_id,
        return_url: `${APP_URL}/`,
      });

      return res.redirect(303, session.url);
    } catch (err) {
      console.error('[billing/portal] Stripe error:', err.message);
      return res.redirect('/');
    }
  });

  return router;
}
