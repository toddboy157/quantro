// Shared account/session client - used by every page on the site (landing
// pages and the /app dashboard alike; served from the landing static mount
// at the site root, so both mounts can reference it by absolute path
// "/auth-client.js"). Talks to the /api/auth/* and /api/billing/* routes
// added in server.py. No build step, no framework - just fetch + DOM.

export async function apiMe() {
  const res = await fetch("/api/auth/me");
  return res.json();
}

export async function apiSignup(email, password) {
  const res = await fetch("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Signup failed.");
  return data;
}

export async function apiLogin(email, password) {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Login failed.");
  return data;
}

export async function apiLogout() {
  await fetch("/api/auth/logout", { method: "POST" });
}

export async function apiCheckout(plan) {
  const res = await fetch("/api/billing/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not start checkout.");
  return data.url;
}

export async function apiDevConfirm(plan) {
  const res = await fetch("/api/billing/dev-confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not confirm upgrade.");
  return data;
}

const PLAN_LABELS = { free: "Delayed", live: "Live", desk: "Desk" };

/**
 * Renders the "Log in / Sign up" or "you@x.com · Live · Log out" widget
 * into `container`. Call this on every page's nav so account state is
 * visible everywhere, not just in the dashboard.
 */
export async function renderAccountWidget(container) {
  let me;
  try {
    me = await apiMe();
  } catch (err) {
    container.innerHTML = "";
    return;
  }
  if (!me.authenticated) {
    container.innerHTML = `
      <a href="/account/login/" class="account-link">Log in</a>
      <a href="/account/signup/" class="btn btn-ghost account-signup-btn">Sign up</a>
    `;
    return;
  }
  const planLabel = PLAN_LABELS[me.plan] || me.plan;
  const planClass = me.plan === "live" || me.plan === "desk" ? "plan-pill plan-pill-live" : "plan-pill";
  container.innerHTML = `
    <span class="account-email">${me.email}</span>
    <span class="${planClass}">${planLabel}</span>
    <button class="account-link account-logout" type="button">Log out</button>
  `;
  container.querySelector(".account-logout").addEventListener("click", async () => {
    await apiLogout();
    window.location.reload();
  });
}
