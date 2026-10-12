import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type {
  Address,
  CheckoutResult,
  CheckoutSummary,
  ShippingAddressInput,
  ShippingMethod,
} from "@kash-commerce/storefront-sdk";
import { useAuth, useCart, useCommerce } from "../context/providers";
import { Loading, Money } from "../components/ui";
import { errorMessage, useTitle } from "../lib/util";
import { payWithRazorpay, signMockPayment, type PaymentProof } from "../lib/payments";

const emptyAddr: ShippingAddressInput = {
  fullName: "",
  phone: "",
  line1: "",
  line2: "",
  city: "",
  state: "",
  postalCode: "",
  country: "US",
};

const addressReady = (a: ShippingAddressInput) =>
  !!(
    a.fullName.trim() &&
    a.line1.trim() &&
    a.city.trim() &&
    a.postalCode.trim() &&
    a.country.length === 2
  );

function clean(a: ShippingAddressInput): ShippingAddressInput {
  return {
    fullName: a.fullName.trim(),
    phone: a.phone?.trim() || undefined,
    line1: a.line1.trim(),
    line2: a.line2?.trim() || undefined,
    city: a.city.trim(),
    state: a.state?.trim() || undefined,
    postalCode: a.postalCode.trim(),
    country: a.country.trim().toUpperCase(),
  };
}

function AddressFields({
  prefix,
  value,
  onChange,
}: {
  prefix: string;
  value: ShippingAddressInput;
  onChange(v: ShippingAddressInput): void;
}) {
  const f = (
    key: keyof ShippingAddressInput,
    label: string,
    extra: { required?: boolean; autoComplete?: string } = {},
  ) => (
    <label>
      {label}
      <input
        name={`${prefix}-${key}`}
        required={extra.required}
        autoComplete={extra.autoComplete ? `${prefix} ${extra.autoComplete}` : undefined}
        value={value[key] ?? ""}
        maxLength={key === "country" ? 2 : undefined}
        onChange={(e) => onChange({ ...value, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <div className="stack">
      {f("fullName", "Full name", { required: true, autoComplete: "name" })}
      {f("phone", "Phone", { autoComplete: "tel" })}
      {f("line1", "Address line 1", { required: true, autoComplete: "address-line1" })}
      {f("line2", "Address line 2", { autoComplete: "address-line2" })}
      {f("city", "City", { required: true, autoComplete: "address-level2" })}
      {f("state", "State / region", { autoComplete: "address-level1" })}
      {f("postalCode", "Postal code", { required: true, autoComplete: "postal-code" })}
      {f("country", "Country (2-letter code)", { required: true, autoComplete: "country" })}
    </div>
  );
}

export default function Checkout() {
  const commerce = useCommerce();
  const navigate = useNavigate();
  const { customer } = useAuth();
  const { cart, refresh } = useCart();
  useTitle("Checkout");

  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [ship, setShip] = useState<ShippingAddressInput>(emptyAddr);
  const [billSame, setBillSame] = useState(true);
  const [bill, setBill] = useState<ShippingAddressInput>(emptyAddr);
  const [methods, setMethods] = useState<ShippingMethod[]>([]);
  const [methodCode, setMethodCode] = useState<string>("");
  const [pay, setPay] = useState<"online" | "cod">("cod");
  const [saved, setSaved] = useState<Address[]>([]);
  const [summary, setSummary] = useState<CheckoutSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<{ result: CheckoutResult; email: string } | null>(null);

  useEffect(() => {
    if (!customer) return;
    setEmail((e) => e || customer.email);
    void commerce.account.addresses
      .list()
      .then(setSaved)
      .catch(() => undefined);
  }, [commerce, customer]);

  const shipOk = addressReady(ship);
  const country = ship.country.length === 2 ? ship.country.toUpperCase() : undefined;
  const subtotal = cart?.subtotal;

  useEffect(() => {
    if (!country) return;
    let alive = true;
    void commerce.checkout
      .shippingMethods({ country, subtotal })
      .then((m) => {
        if (!alive) return;
        setMethods(m);
        setMethodCode((cur) => (m.some((x) => x.code === cur) ? cur : (m[0]?.code ?? "")));
      })
      .catch(() => alive && setMethods([]));
    return () => {
      alive = false;
    };
  }, [commerce, country, subtotal]);

  const shipKey = JSON.stringify(ship);
  useEffect(() => {
    if (!shipOk || !cart || cart.items.length === 0) return setSummary(null);
    let alive = true;
    const t = setTimeout(() => {
      void commerce.checkout
        .summary({ shippingAddress: clean(ship), shippingMethodCode: methodCode || undefined })
        .then((s) => {
          if (!alive) return;
          setSummary(s);
          setSummaryError(null);
        })
        .catch((e) => alive && (setSummary(null), setSummaryError(errorMessage(e))));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [commerce, shipKey, methodCode, cart?.couponCode, cart?.subtotal]);

  if (!cart) return <Loading />;
  if (placed) {
    return (
      <PaymentStep
        result={placed.result}
        email={placed.email}
        onDone={async () => {
          await refresh();
          navigate(
            `/order/${encodeURIComponent(placed.result.order.orderNumber)}?email=${encodeURIComponent(placed.email)}`,
          );
        }}
      />
    );
  }
  if (cart.items.length === 0)
    return (
      <section>
        <h1>Checkout</h1>
        <p>
          Your cart is empty. <Link to="/products">Continue shopping</Link>
        </p>
      </section>
    );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setPlacing(true);
    setError(null);
    try {
      const result = await commerce.checkout.create({
        email: email.trim(),
        phone: phone.trim() || undefined,
        shippingAddress: clean(ship),
        billingAddress: billSame ? undefined : clean(bill),
        shippingMethodCode: methodCode || undefined,
        // Omit to use the store's active provider; "MANUAL" = cash on delivery.
        paymentProvider: pay === "cod" ? "MANUAL" : undefined,
      });
      if (!result.paymentRequired || !result.clientPayload) {
        await refresh();
        navigate(
          `/order/${encodeURIComponent(result.order.orderNumber)}?email=${encodeURIComponent(email.trim())}`,
        );
      } else setPlaced({ result, email: email.trim() });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPlacing(false);
    }
  }

  const useSaved = (id: string) => {
    const a = saved.find((x) => x.id === id);
    if (a)
      setShip({
        fullName: a.fullName,
        phone: a.phone ?? "",
        line1: a.line1,
        line2: a.line2 ?? "",
        city: a.city,
        state: a.state ?? "",
        postalCode: a.postalCode,
        country: a.country,
      });
  };

  return (
    <section>
      <h1>Checkout</h1>
      {!customer ? (
        <p className="muted">
          Checking out as a guest. <Link to="/account">Sign in</Link> to use saved addresses.
        </p>
      ) : null}
      <form onSubmit={onSubmit} className="checkout">
        <div className="stack">
          <fieldset>
            <legend>Contact</legend>
            <label>
              Email
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              Phone
              <input
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>Shipping address</legend>
            {saved.length > 0 ? (
              <label>
                Saved addresses
                <select defaultValue="" onChange={(e) => useSaved(e.target.value)}>
                  <option value="">Choose...</option>
                  {saved.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label ?? a.fullName}, {a.line1}, {a.city}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <AddressFields prefix="shipping" value={ship} onChange={setShip} />
          </fieldset>

          <fieldset>
            <legend>Billing address</legend>
            <label>
              <input
                type="checkbox"
                checked={billSame}
                onChange={(e) => setBillSame(e.target.checked)}
              />{" "}
              Same as shipping
            </label>
            {!billSame ? <AddressFields prefix="billing" value={bill} onChange={setBill} /> : null}
          </fieldset>

          <fieldset>
            <legend>Shipping method</legend>
            {methods.length === 0 ? (
              <p className="muted">Enter your country to see shipping options.</p>
            ) : (
              methods.map((m) => (
                <label key={m.code} className="choice">
                  <input
                    type="radio"
                    name="shipping-method"
                    checked={methodCode === m.code}
                    onChange={() => setMethodCode(m.code)}
                  />{" "}
                  {m.name} ({m.cost && m.cost !== "0.00" ? <Money amount={m.cost} /> : "free"})
                  {m.minDays != null ? (
                    <span className="muted">
                      {" "}
                      {m.minDays}-{m.maxDays ?? m.minDays} days
                    </span>
                  ) : null}
                </label>
              ))
            )}
          </fieldset>

          <fieldset>
            <legend>Payment</legend>
            <label className="choice">
              <input
                type="radio"
                name="pay"
                checked={pay === "cod"}
                onChange={() => setPay("cod")}
              />{" "}
              Cash on delivery (confirms immediately)
            </label>
            <label className="choice">
              <input
                type="radio"
                name="pay"
                checked={pay === "online"}
                onChange={() => setPay("online")}
              />{" "}
              Pay online
            </label>
          </fieldset>
        </div>

        <aside className="summary" aria-label="Order summary">
          <h2>Order summary</h2>
          <ul>
            {cart.items.map((l) => (
              <li key={l.variantId}>
                {l.quantity} x {l.title} {l.variantTitle ? `(${l.variantTitle})` : ""} —{" "}
                <Money amount={l.lineTotal} currency={cart.currency} />
              </li>
            ))}
          </ul>
          {cart.couponCode ? <p>Coupon: {cart.couponCode} (change it in your cart)</p> : null}
          <dl className="totals">
            <dt>Subtotal</dt>
            <dd>
              <Money amount={summary?.subtotal ?? cart.subtotal} currency={cart.currency} />
            </dd>
            {summary && summary.discount !== "0.00" ? (
              <>
                <dt>Discount</dt>
                <dd>
                  -<Money amount={summary.discount} currency={cart.currency} />
                </dd>
              </>
            ) : null}
            <dt>Shipping</dt>
            <dd>{summary ? <Money amount={summary.shipping} currency={cart.currency} /> : "—"}</dd>
            {summary && summary.tax !== "0.00" ? (
              <>
                <dt>Tax</dt>
                <dd>
                  <Money amount={summary.tax} currency={cart.currency} />
                </dd>
              </>
            ) : null}
            <dt>Total</dt>
            <dd>
              <strong>
                <Money amount={summary?.total ?? cart.total} currency={cart.currency} />
              </strong>
            </dd>
          </dl>
          {summaryError ? (
            <p role="alert" className="notice error">
              {summaryError}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="notice error">
              {error}
            </p>
          ) : null}
          <button type="submit" disabled={placing || !shipOk || !email}>
            {placing ? "Placing order..." : "Place order"}
          </button>
        </aside>
      </form>
    </section>
  );
}

/** Second step for online payments: completes the provider's client flow, then verifies on the API. */
export function PaymentStep({
  result,
  email,
  onDone,
}: {
  result: CheckoutResult;
  email: string;
  onDone(): void | Promise<void>;
}) {
  const commerce = useCommerce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(result.paymentError ?? null);
  const [payload, setPayload] = useState(result.clientPayload);
  const orderNumber = result.order.orderNumber;

  async function verify(proof: PaymentProof) {
    await commerce.payments.verify({ orderNumber, email, ...proof });
    await onDone();
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h1>Complete your payment</h1>
      <p>
        Order <strong>{orderNumber}</strong> is waiting for payment of{" "}
        <Money amount={result.order.total} currency={result.order.currency} />.
      </p>
      {error ? (
        <p role="alert" className="notice error">
          {error}
        </p>
      ) : null}
      {payload?.mock ? (
        <div className="notice warn">
          <p>
            <strong>DEMO ONLY.</strong> The MOCK payment provider is enabled on this API. This
            button signs a fake payment in your browser using the public development secret. It
            cannot work against a production API.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(async () => verify(await signMockPayment(String(payload.providerOrderId))))
            }
          >
            Simulate payment
          </button>
        </div>
      ) : payload?.keyId ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => run(async () => verify(await payWithRazorpay(payload, { email })))}
        >
          Pay now
        </button>
      ) : null}
      {!payload || error ? (
        <p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await commerce.payments.retry({ orderNumber, email });
                if (r.clientPayload) setPayload(r.clientPayload);
              })
            }
          >
            Retry payment
          </button>
        </p>
      ) : null}
      <p>
        <Link to={`/order/${encodeURIComponent(orderNumber)}?email=${encodeURIComponent(email)}`}>
          View order
        </Link>
      </p>
    </section>
  );
}
