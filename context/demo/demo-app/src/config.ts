// Demo fixture for OrchestrAI's secret scan. This value is FAKE: it is not a
// real key for any service. It exists so `scan-secrets` has something to find.
export const payment_api_key = "demo_fake_key_not_real_0000"

export const PORT = Number(process.env.PORT ?? 3000)
