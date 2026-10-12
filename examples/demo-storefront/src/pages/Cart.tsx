import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useCart } from "../context/providers";
import { Loading, Money } from "../components/ui";
import { useTitle } from "../lib/util";

export default function CartPage() {
  const { cart, busy, error, setQuantity, remove, applyCoupon, removeCoupon } = useCart();
  const [code, setCode] = useState("");
  useTitle("Your cart");

  if (!cart) return <Loading />;
  if (cart.items.length === 0)
    return (
      <section>
        <h1>Your cart</h1>
        <p>Your cart is empty.</p>
        <Link to="/products" className="button">
          Continue shopping
        </Link>
      </section>
    );

  async function onCoupon(e: FormEvent) {
    e.preventDefault();
    if (code.trim() && (await applyCoupon(code.trim()))) setCode("");
  }

  return (
    <section>
      <h1>Your cart</h1>
      {error ? (
        <p role="alert" className="notice error">
          {error}
        </p>
      ) : null}
      {cart.warnings.length > 0 ? (
        <ul className="notice warn" role="status">
          {cart.warnings.map((w) => (
            <li key={w.variantId}>
              {w.title || "An item"}: {w.problems.join(", ").toLowerCase().replace(/_/g, " ")}
              {w.available !== null ? ` (${w.available} available)` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <table className="cart-table">
        <caption className="sr-only">Items in your cart</caption>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">Price</th>
            <th scope="col">Quantity</th>
            <th scope="col">Total</th>
            <th scope="col">
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {cart.items.map((l) => (
            <tr key={l.variantId}>
              <th scope="row">
                {l.title}
                {l.variantTitle ? <div className="muted">{l.variantTitle}</div> : null}
              </th>
              <td>
                <Money amount={l.unitPrice} currency={cart.currency} />
              </td>
              <td>
                <label className="sr-only" htmlFor={`qty-${l.variantId}`}>
                  Quantity for {l.title}
                </label>
                <input
                  id={`qty-${l.variantId}`}
                  type="number"
                  min={0}
                  max={99}
                  defaultValue={l.quantity}
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isInteger(n) && n !== l.quantity) void setQuantity(l.variantId, n);
                  }}
                />
              </td>
              <td>
                <Money amount={l.lineTotal} currency={cart.currency} />
              </td>
              <td>
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() => void remove(l.variantId)}
                  aria-label={`Remove ${l.title}`}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="cart-footer">
        <form onSubmit={onCoupon} className="coupon" aria-label="Coupon">
          {cart.couponCode ? (
            <p>
              Coupon <strong>{cart.couponCode}</strong> applied{" "}
              <button type="button" className="link-button" onClick={() => void removeCoupon()}>
                Remove coupon
              </button>
            </p>
          ) : (
            <>
              <label htmlFor="coupon">Coupon code</label>{" "}
              <input id="coupon" value={code} onChange={(e) => setCode(e.target.value)} />{" "}
              <button type="submit" disabled={busy}>
                Apply
              </button>
            </>
          )}
          {cart.couponError ? (
            <p role="alert" className="notice error">
              {cart.couponError.message}
            </p>
          ) : null}
        </form>
        <dl className="totals">
          <dt>Subtotal</dt>
          <dd>
            <Money amount={cart.subtotal} currency={cart.currency} />
          </dd>
          {cart.discount !== "0.00" ? (
            <>
              <dt>Discount</dt>
              <dd>
                -<Money amount={cart.discount} currency={cart.currency} />
              </dd>
            </>
          ) : null}
          {cart.tax !== "0.00" ? (
            <>
              <dt>Tax{cart.taxInclusive ? " (included)" : ""}</dt>
              <dd>
                <Money amount={cart.tax} currency={cart.currency} />
              </dd>
            </>
          ) : null}
          <dt>Total</dt>
          <dd>
            <strong>
              <Money amount={cart.total} currency={cart.currency} />
            </strong>
          </dd>
        </dl>
        <p className="muted">Shipping is calculated at checkout.</p>
        <Link to="/checkout" className="button">
          Checkout
        </Link>
      </div>
    </section>
  );
}
