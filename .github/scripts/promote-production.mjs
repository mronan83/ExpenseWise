// Makes this commit's Vercel production build live, after migrations have run (ADR-0018).
// Vercel builds every push to main but no longer assigns the production domain itself; the
// Release workflow calls this once the product owner has approved and migrations are applied.
//
// Steps: skip if main has moved on; wait for this commit's production build; promote it;
// check the production domain serves it; resync the workflow runner (Inngest).

import { pathToFileURL } from 'node:url';

const MINUTE = 60_000;

export async function release(env, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? console.log;
  const now = deps.now ?? Date.now;
  const short = env.RELEASE_SHA.slice(0, 7);
  const servedVersion = () =>
    doFetch(`${env.PRODUCTION_URL}/api/v1/health?release=${now()}`)
      .then((r) => r.json())
      .then((body) => body.version)
      .catch(() => undefined);

  const vercel = async (path, init = {}) => {
    const url = new URL(`https://api.vercel.com${path}`);
    url.searchParams.set('teamId', env.VERCEL_TEAM_ID);
    const res = await doFetch(url, {
      ...init,
      headers: { authorization: `Bearer ${env.VERCEL_TOKEN}`, 'content-type': 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = body?.error?.message ?? body?.message ?? '';
      throw new Error(`Vercel answered ${res.status} for ${path.split('?')[0]}. ${reason}`.trim());
    }
    return body;
  };

  // 1. An older run must never roll production back past a newer commit.
  const head = await doFetch(`https://api.github.com/repos/${env.REPOSITORY}/commits/main`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
    },
  }).then((r) => r.json());
  if (head?.sha && head.sha !== env.RELEASE_SHA) {
    log(
      `main has moved on to ${head.sha.slice(0, 7)}; its own release run promotes it. Nothing to do.`,
    );
    return 'superseded';
  }

  // 2. Wait for this commit's production build.
  let deployment;
  const waitUntil = now() + 15 * MINUTE;
  const giveUpIfNoneBy = now() + 5 * MINUTE;
  for (;;) {
    const query = new URLSearchParams({
      projectId: env.VERCEL_PROJECT_ID,
      target: 'production',
      sha: env.RELEASE_SHA,
      limit: '5',
    });
    const { deployments = [] } = await vercel(`/v6/deployments?${query}`);
    deployment = deployments.sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];
    const state = deployment?.state ?? deployment?.readyState;
    if (state === 'READY') break;
    if (state === 'ERROR') throw new Error(`The production build of ${short} failed on Vercel.`);
    if (state === 'CANCELED' || (!deployment && now() > giveUpIfNoneBy)) {
      // Vercel skips builds for commits that don't touch the app, such as docs. Production
      // keeps serving the last release, which has the same app.
      log(`Vercel has no production build of ${short}; production is unchanged.`);
      return 'no-build';
    }
    if (now() > waitUntil)
      throw new Error(`The production build of ${short} took over 15 minutes.`);
    log(`Waiting for the production build of ${short} (${state ?? 'not started'})…`);
    await sleep(15_000);
  }
  const id = deployment.uid ?? deployment.id;
  log(`Build ready: ${deployment.url} (${id}).`);

  // 3. Point the production domain at it, unless it already serves this commit.
  if ((await servedVersion()) === short) {
    log(`Production already serves ${short}.`);
  } else {
    await vercel(`/v10/projects/${env.VERCEL_PROJECT_ID}/promote/${id}`, { method: 'POST' });
    log('Promotion requested.');
  }

  // 4. Check the production domain now serves this commit.
  const checkUntil = now() + 5 * MINUTE;
  for (;;) {
    const version = await servedVersion();
    if (version === short) break;
    if (now() > checkUntil) {
      throw new Error(`Production still serves ${version ?? 'nothing'} instead of ${short}.`);
    }
    await sleep(10_000);
  }
  log(`Production serves ${short}.`);

  // 5. Tell the workflow runner about this build's functions. Not fatal: Inngest also resyncs
  //    on its own, and the app works without it.
  const sync = await doFetch(`${env.PRODUCTION_URL}/api/inngest`, { method: 'PUT' }).catch(
    (error) => ({ status: 0, statusText: String(error) }),
  );
  if (sync.status === 200) log('Workflow runner resynced.');
  else
    log(
      `::warning::Resyncing the workflow runner answered ${sync.status}. Resync it in Inngest if receipts aren't read.`,
    );
  return 'released';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const required = [
    'VERCEL_TOKEN',
    'VERCEL_PROJECT_ID',
    'VERCEL_TEAM_ID',
    'RELEASE_SHA',
    'REPOSITORY',
    'PRODUCTION_URL',
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(
      `Missing ${missing.join(', ')}. VERCEL_TOKEN is a secret in the production environment.`,
    );
    process.exit(1);
  }
  release(process.env).then(
    (outcome) => console.log(`Release: ${outcome}.`),
    (error) => {
      console.error(`::error::${error.message}`);
      process.exit(1);
    },
  );
}
