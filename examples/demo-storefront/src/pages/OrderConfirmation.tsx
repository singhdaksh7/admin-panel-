import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useCommerce } from "../context/providers";
import { ErrorNote, Loading, Money } from "../components/ui";
import { errorMessage, isNotFound, useAsync, useTitle } from "../lib/util";
import NotFound from "./NotFound";

/** /order/:orderNumber?email=  — guests look an order up with its email; owners need no email. */
export default function OrderConfirmation() {
  const { orderNumber = "" } = useParams();
  const [params] = useSearchParams();
  const email = params.get("email") ?? undefined;
  const commerce = useCommerce();
  const order = useAsync(
    () => commerce.orders.get(orderNumber, email),
    [commerce, orderNumber, email],
  );
  const [retryMsg, setRetryMsg] = useState<string | null>(null);
  useTitle(`Order ${orderNumber}`);

  if (order.loading) return <Loading />;
  if (order.error)
    return isNotFound(order.error) ? <NotFound /> : <ErrorNote error={order.error} />;
  const o = order.data;
  if (!o) return null;
  const unpaid =
    o.paymentProvider &&
    o.paymentProvider !== "MANUAL" &&
    ["PENDING", "FAILED"].includes(o.paymentStatus);

  return (
    <section>
      <h1>Thank you!</h1>
      <p role="status">
        Order <strong>{o.orderNumber}</strong> is{" "}
        <strong>{o.status.toLowerCase().replace(/_/g, " ")}</strong> (payment:{" "}
        {o.paymentStatus.toLowerCase().replace(/_/g, " ")}). A confirmation was sent to {o.email}.
      </p>
      {unpaid && email ? (
        <p>
          <button
            type="button"
            onClick={() =>
              commerce.payments
                .retry({ orderNumber: o.orderNumber, email })
                .then(() =>
                  setRetryMsg("A new payment attempt was created. Complete it from checkout."),
                )
                .catch((e) => setRetryMsg(errorMessage(e)))
            }
          >
            Retry payment
          </button>{" "}
          {retryMsg}
        </p>
      ) : null}
      <table className="cart-table">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Qty</th>
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {o.items.map((i) => (
            <tr key={`${i.productId}-${i.variantId}`}>
              <th scope="row">
                {i.title}{" "}
                {i.variantTitle ? <span className="muted">({i.variantTitle})</span> : null}
              </th>
              <td>{i.quantity}</td>
              <td>
                <Money amount={i.lineTotal} currency={o.currency} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="totals">
        <dt>Subtotal</dt>
        <dd>
          <Money amount={o.subtotal} currency={o.currency} />
        </dd>
        <dt>Shipping{o.shippingMethod ? ` (${o.shippingMethod})` : ""}</dt>
        <dd>
          <Money amount={o.shipping} currency={o.currency} />
        </dd>
        {o.discount !== "0.00" ? (
          <>
            <dt>Discount</dt>
            <dd>
              -<Money amount={o.discount} currency={o.currency} />
            </dd>
          </>
        ) : null}
        <dt>Tax</dt>
        <dd>
          <Money amount={o.tax} currency={o.currency} />
        </dd>
        <dt>Total</dt>
        <dd>
          <strong>
            <Money amount={o.total} currency={o.currency} />
          </strong>
        </dd>
      </dl>
      {o.shippingAddress ? (
        <address>
          <strong>Ships to</strong>
          <br />
          {o.shippingAddress.fullName}
          <br />
          {o.shippingAddress.line1}
          <br />
          {o.shippingAddress.city} {o.shippingAddress.postalCode}, {o.shippingAddress.country}
        </address>
      ) : null}
      <p>
        <a href={commerce.orders.invoiceUrl(o.orderNumber, email)}>Download invoice (PDF)</a>
      </p>
      <p>
        <Link to="/products">Continue shopping</Link>
      </p>
    </section>
  );
}
