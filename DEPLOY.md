# Going live on Railway

This gets the site running on the public internet on Railway's free subdomain
(`something.up.railway.app`) — no domain purchase needed to start. Billing
stays in **dev-checkout mode** (see README) for now; nothing here changes
that, so "Upgrade to Live" will keep flipping the plan instantly with no real
charge until Whop/Stripe is wired in as a follow-up.

Estimated cost: Railway bills usage-based on top of a small monthly plan fee.
A single small always-on service like this one plus a tiny persistent volume
is inexpensive, but check **railway.com/pricing** yourself for the current
numbers before committing — pricing pages change and I don't want to quote
you a stale figure.

## 0. One-time setup

You'll need a Railway account (railway.com) and the Railway CLI installed on
your own machine (this can't be run from inside this chat — it needs to
authenticate as *you*).

```bash
npm i -g @railway/cli
```

(No Node.js/npm on your machine? Railway's docs at
`docs.railway.com/guides/cli` list a couple of other install methods —
Homebrew on Mac, a shell script on Linux. Use whichever works; the commands
below are the same regardless of how the CLI got installed.)

## 1. Unzip the project and log in

```bash
unzip quantro-prototype.zip
cd quantro
railway login       # opens a browser tab to authenticate
railway init         # creates a new Railway project - give it a name, e.g. quantro
```

The repo already has a `Dockerfile` at its root (added this round) that
Railway will detect and build automatically - no other config needed for the
build itself.

## 2. Set your real config as environment variables

**Do this instead of shipping `backend/.env`.** The Dockerfile deliberately
does not copy `.env` into the image (see `.dockerignore`), so your real
Massive/Polygon key never ends up baked into a build artifact - it only
exists as a Railway environment variable, which is the right way to handle
it in production.

```bash
railway variable set DATA_PROVIDER=polygon
railway variable set POLYGON_API_KEY=Fou4FE7xsSxB75fOA8QE3Luea2qCT4K9
railway variable set UNDERLYINGS=SPX,SPY,QQQ,AAPL,NVDA,MSFT,TSLA,AMZN
railway variable set REFRESH_INTERVAL_SECONDS=2
railway variable set RISK_FREE_RATE=0.045
railway variable set FREE_PLAN_UNDERLYING_LIMIT=3
railway variable set DB_PATH=/data/quantro.db
railway variable set SECRET_KEY=9637c43acc0e5ae1332f15adec8fac5d00d9f743fcc321e7184a71fcb2429f4c
```

`SECRET_KEY` above is a real, randomly generated value (not a placeholder) -
safe to use as-is, or regenerate your own any time with
`python3 -c "import secrets; print(secrets.token_hex(32))"`. Setting it
explicitly (instead of leaving it blank) matters once this is a real
deployment: blank means a new random key per restart, which silently logs
everyone out every time Railway redeploys or restarts the container.

Leave `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICE_ID_LIVE`
unset for now - that's what keeps "Upgrade to Live" on the dev-checkout
bypass per your call to ship the dashboard first and finish billing later.

## 3. Deploy

```bash
railway up
```

This builds the Dockerfile and starts the service. Watch the build log it
prints - it should end with the same "Uvicorn running on..." line you've
seen locally.

## 4. Add a persistent volume (needed for the SQLite database)

Without this step, the database (positioning history, candles, and every
signed-up account) gets wiped every time the service redeploys or restarts,
because the container's own filesystem doesn't persist.

In the Railway dashboard: open the project, press `⌘K` (or right-click the
project canvas) → **New Volume** → attach it to the quantro service → set
its **mount path to `/data`**. That matches the `DB_PATH=/data/quantro.db`
variable you set in step 2.

## 5. Get your public URL

```bash
railway domain
```

This generates your free `<something>.up.railway.app` address. Open it -
you should see the live marketing homepage, and `/app` should show the
dashboard with a green **LIVE DATA (polygon)** badge (not the orange
"SIMULATED DATA" one, which would mean `POLYGON_API_KEY` didn't get picked
up - double check `railway variable list`).

Then set that URL as `PUBLIC_BASE_URL` (used today only by the not-yet-active
billing code, but worth having correct before you turn billing on):

```bash
railway variable set PUBLIC_BASE_URL=https://<your-actual-domain>.up.railway.app
```

## 6. Verify it end-to-end

- Open the homepage, click through to Methodology / Pricing / FAQ / Legal.
- Open `/app` - confirm live data is flowing (spot price moving, walls
  populated, the new positioning-map heatmap rendering).
- Sign up for an account, click "Upgrade to Live" on the pricing page,
  confirm the dev-checkout bypass unlocks the full underlying universe.
- Open `/app/compare/` and confirm all 8 underlyings show up once upgraded.

## Shipping future changes

Edit the code locally, then from the `quantro/` folder:

```bash
railway up
```

Railway rebuilds the image and redeploys. Your database on the attached
volume is untouched across deploys - only the container's own filesystem
resets.

## Before you get real users: rotate your API key

Your Massive/Polygon key has been pasted into this chat, saved in a
delivered zip, and is now also about to sit in a live Railway environment
variable. None of that is a leak by itself, but it's more copies than a
production secret should have. Worth rotating it once at
**massive.com/dashboard** (then `railway variable set POLYGON_API_KEY=...`
with the new one) so the old value stops being sensitive.

## When you're ready to take real payments

This is the other half of "fully live" - say the word and this gets
finished the same way everything else in this build has: implemented
against the documented spec, offline-tested, and clearly caveated on
anything that couldn't be verified live from this environment. You'll need
to hand over your actual Whop checkout URL (and a webhook secret, if you
want plan upgrades to happen automatically rather than through the same
manual-confirm bypass used today).
