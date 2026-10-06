/*
 * The signing secret the web app is started with for end-to-end runs, so the checks can sign a
 * delivery to Bird's webhook (#93). It signs nothing anywhere else; production's is Bird's own.
 */
export const E2E_BIRD_KEY = Buffer.from('e2e-only-bird-webhook-signing-k!');
export const E2E_BIRD_SECRET = `whsec_${E2E_BIRD_KEY.toString('base64')}`;
