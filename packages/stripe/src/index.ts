import Stripe from 'stripe'

export interface StripeClientOptions {
  secretKey?: string
}

function readEnv(name: string): string | undefined {
  const globalWithProcess = globalThis as { process?: { env?: Record<string, string | undefined> } }
  return globalWithProcess.process?.env?.[name]
}

export function createStripeClient(options: StripeClientOptions = {}): Stripe {
  const secretKey = options.secretKey ?? readEnv('STRIPE_SECRET_KEY')

  if (!secretKey) {
    throw new Error('[GTG] createStripeClient(): STRIPE_SECRET_KEY is required.')
  }

  return new Stripe(secretKey)
}

export interface ConstructWebhookEventInput {
  payload: string
  signature: string
  webhookSecret?: string
  stripeClient?: Stripe
}

export function constructWebhookEvent(input: ConstructWebhookEventInput): Stripe.Event {
  const stripeClient = input.stripeClient ?? createStripeClient()
  const webhookSecret = input.webhookSecret ?? readEnv('STRIPE_WEBHOOK_SECRET')

  if (!webhookSecret) {
    throw new Error('[GTG] constructWebhookEvent(): STRIPE_WEBHOOK_SECRET is required.')
  }

  return stripeClient.webhooks.constructEvent(input.payload, input.signature, webhookSecret)
}
