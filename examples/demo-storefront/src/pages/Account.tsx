import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { AddressInput } from "@kash-commerce/storefront-sdk";
import { useAuth, useCommerce } from "../context/providers";
import { ErrorNote, Loading, Money } from "../components/ui";
import { errorMessage, useAsync, useTitle } from "../lib/util";

export default function Account() {
  const { customer, ready } = useAuth();
  useTitle("Your account");
  if (!ready) return <Loading />;
  return customer ? <Dashboard /> : <SignIn />;
}

function SignIn() {
  const auth = useAuth();
  const commerce = useCommerce();
  const [mode, setMode] = useState<"login" | "register" | "forgot">("login");
  const [f, setF] = useState({ email: "", password: "", firstName: "", lastName: "" });
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "login") await auth.login(f.email, f.password);
      else if (mode === "register")
        await auth.register({
          email: f.email,
          password: f.password,
          firstName: f.firstName || undefined,
          lastName: f.lastName || undefined,
        });
      else {
        await commerce.auth.forgotPassword(f.email);
        setInfo("If that account exists, a reset link has been sent.");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="narrow">
      <h1>
        {mode === "login" ? "Sign in" : mode === "register" ? "Create account" : "Reset password"}
      </h1>
      <form onSubmit={submit} className="stack">
        {mode === "register" ? (
          <>
            <label>
              First name
              <input
                value={f.firstName}
                onChange={(e) => set("firstName", e.target.value)}
                autoComplete="given-name"
              />
            </label>
            <label>
              Last name
              <input
                value={f.lastName}
                onChange={(e) => set("lastName", e.target.value)}
                autoComplete="family-name"
              />
            </label>
          </>
        ) : null}
        <label>
          Email
          <input
            type="email"
            required
            value={f.email}
            onChange={(e) => set("email", e.target.value)}
            autoComplete="email"
          />
        </label>
        {mode !== "forgot" ? (
          <label>
            Password
            <input
              type="password"
              required
              value={f.password}
              onChange={(e) => set("password", e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </label>
        ) : null}
        {error ? (
          <p role="alert" className="notice error">
            {error}
          </p>
        ) : null}
        {info ? (
          <p role="status" className="notice ok">
            {info}
          </p>
        ) : null}
        <button type="submit" disabled={busy}>
          {mode === "login"
            ? "Sign in"
            : mode === "register"
              ? "Create account"
              : "Send reset link"}
        </button>
      </form>
      <p>
        {mode !== "login" ? (
          <button type="button" className="link-button" onClick={() => setMode("login")}>
            Back to sign in
          </button>
        ) : (
          <>
            <button type="button" className="link-button" onClick={() => setMode("register")}>
              Create an account
            </button>{" "}
            |{" "}
            <button type="button" className="link-button" onClick={() => setMode("forgot")}>
              Forgot password?
            </button>
          </>
        )}
      </p>
    </section>
  );
}

const blankAddr: AddressInput = {
  fullName: "",
  line1: "",
  city: "",
  postalCode: "",
  country: "US",
};

function Dashboard() {
  const auth = useAuth();
  const commerce = useCommerce();
  const orders = useAsync(() => commerce.account.orders.list({ pageSize: 10 }), [commerce]);
  const addresses = useAsync(() => commerce.account.addresses.list(), [commerce]);
  const [form, setForm] = useState<AddressInput>(blankAddr);
  const [error, setError] = useState<string | null>(null);

  async function addAddress(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await commerce.account.addresses.create({ ...form, country: form.country.toUpperCase() });
      setForm(blankAddr);
      addresses.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section>
      <div className="toolbar">
        <h1>Hello, {auth.customer?.firstName || auth.customer?.email}</h1>
        <button type="button" className="secondary" onClick={() => void auth.logout()}>
          Sign out
        </button>
      </div>

      <h2>Orders</h2>
      {orders.loading ? <Loading /> : null}
      {orders.error ? <ErrorNote error={orders.error} /> : null}
      {orders.data && orders.data.items.length === 0 ? <p>No orders yet.</p> : null}
      <ul className="plain">
        {orders.data?.items.map((o) => (
          <li key={o.orderNumber}>
            <Link to={`/order/${encodeURIComponent(o.orderNumber)}`}>{o.orderNumber}</Link> —{" "}
            {o.status.toLowerCase().replace(/_/g, " ")} —{" "}
            <Money amount={o.total} currency={o.currency} />
          </li>
        ))}
      </ul>

      <h2>Addresses</h2>
      {addresses.data?.length === 0 ? <p className="muted">No saved addresses.</p> : null}
      <ul className="plain">
        {addresses.data?.map((a) => (
          <li key={a.id}>
            {a.fullName}, {a.line1}, {a.city} {a.postalCode}, {a.country}
            {a.isDefaultShipping ? " (default)" : ""}{" "}
            <button
              type="button"
              className="link-button"
              onClick={() =>
                void commerce.account.addresses
                  .remove(a.id)
                  .then(addresses.reload)
                  .catch((e) => setError(errorMessage(e)))
              }
              aria-label={`Delete address ${a.line1}`}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={addAddress} className="stack narrow" aria-label="Add address">
        <h3>Add an address</h3>
        {(
          [
            ["fullName", "Full name"],
            ["line1", "Address line 1"],
            ["city", "City"],
            ["postalCode", "Postal code"],
            ["country", "Country (2-letter code)"],
          ] as const
        ).map(([k, label]) => (
          <label key={k}>
            {label}
            <input
              required
              value={form[k] ?? ""}
              maxLength={k === "country" ? 2 : undefined}
              onChange={(e) => setForm((s) => ({ ...s, [k]: e.target.value }))}
            />
          </label>
        ))}
        {error ? (
          <p role="alert" className="notice error">
            {error}
          </p>
        ) : null}
        <button type="submit">Save address</button>
      </form>
    </section>
  );
}
