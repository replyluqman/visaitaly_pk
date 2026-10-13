import { describe, expect, it } from 'vitest';
import { createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import { createFcmSender, signAssertion } from '../src/lib/fcm.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const SA = JSON.stringify({ client_email: 'push@proj.iam.gserviceaccount.com', private_key: pem, project_id: 'proj-1' });
const b64d = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
void createSign;

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url: string, init: RequestInit) => {
      const c = { url, init };
      calls.push(c);
      return handler(c);
    },
  };
}
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const MSG = { title: 'T', body: 'B', data: { notificationId: 'n1', deepLink: '/x', type: 'requirement_changed' } };

describe('FCM HTTP v1 adapter (unit — real Google is exercised on first staging send)', () => {
  it('signs an RS256 service-account assertion with the firebase.messaging scope and a ≤1h lifetime', async () => {
    const jwt = await signAssertion(JSON.parse(SA), 1_700_000_000);
    const [h, c, s] = jwt.split('.');
    expect(b64d(h!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(b64d(c!)).toEqual({
      iss: 'push@proj.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token', iat: 1_700_000_000, exp: 1_700_003_600,
    });
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
  });

  it('fetches ONE access token for many sends, then posts the documented message shape', async () => {
    const f = fakeFetch(({ url }) => (url.includes('oauth2') ? ok({ access_token: 'AT', expires_in: 3600 }) : ok({ name: 'm' })));
    const sender = createFcmSender(SA, f.fetch);
    expect(await sender.send('tok-1', MSG)).toBe('ok');
    expect(await sender.send('tok-2', MSG)).toBe('ok');
    expect(f.calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1);
    const oauth = f.calls[0]!;
    const form = new URLSearchParams(oauth.init.body as string);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(form.get('assertion')!.split('.')).toHaveLength(3);
    const send = f.calls[1]!;
    expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/proj-1/messages:send');
    expect((send.init.headers as Record<string, string>).Authorization).toBe('Bearer AT');
    expect(JSON.parse(send.init.body as string)).toEqual({
      message: { token: 'tok-1', notification: { title: 'T', body: 'B' }, data: MSG.data, android: { priority: 'HIGH' } },
    });
  });

  it('refreshes the token after expiry and once on a 401 mid-batch', async () => {
    let now = 1_000_000;
    let oauthCalls = 0;
    let first401 = true;
    const f = fakeFetch(({ url }) => {
      if (url.includes('oauth2')) { oauthCalls++; return ok({ access_token: `AT${oauthCalls}`, expires_in: 3600 }); }
      if (first401) { first401 = false; return ok({ error: { status: 'UNAUTHENTICATED' } }, 401); }
      return ok({});
    });
    const sender = createFcmSender(SA, f.fetch, () => now);
    expect(await sender.send('t', MSG)).toBe('ok'); // 401 → forced refresh → retry
    expect(oauthCalls).toBe(2);
    now += 3_700_000; // an hour later
    await sender.send('t', MSG);
    expect(oauthCalls).toBe(3);
  });

  it('maps responses: dead tokens, transient errors, network failure', async () => {
    const mk = (res: Response | Error) =>
      createFcmSender(SA, async (url) => {
        if (url.includes('oauth2')) return ok({ access_token: 'AT', expires_in: 3600 });
        if (res instanceof Error) throw res;
        return res;
      });
    expect(await mk(ok({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }, 404)).send('t', MSG)).toBe('invalid_token');
    expect(await mk(ok({ error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'INVALID_ARGUMENT' }] } }, 400)).send('t', MSG)).toBe('invalid_token');
    expect(await mk(ok({ error: { status: 'UNAVAILABLE' } }, 503)).send('t', MSG)).toBe('retry');
    expect(await mk(ok({}, 429)).send('t', MSG)).toBe('retry');
    expect(await mk(new Error('network')).send('t', MSG)).toBe('retry');
  });

  it('an OAuth failure is "retry", never a throw that would abort the batch', async () => {
    const sender = createFcmSender(SA, async () => new Response('nope', { status: 500 }));
    expect(await sender.send('t', MSG)).toBe('retry');
  });
});
