# Slow checkout: investigation notes

Simulated investigation for the Whiteboard demo. The service,
code and numbers are fictional.

**Symptom.** Since Tuesday's release, `POST /checkout` p95 latency went from
about 450 ms to 3,400 ms. Error rate is unchanged. No infrastructure changes.

## Step 1: the request path

From `checkout/handler.go`, a checkout request goes:

```go
func (h *Handler) Checkout(w http.ResponseWriter, r *http.Request) {
    user, err := h.auth.Verify(r)                    // auth service, HTTP
    cart, err := h.carts.Load(r.Context(), user.ID)  // Postgres
    quote, err := h.pricing.Quote(r.Context(), cart) // pricing.quote, in process
    charge, err := h.payments.Charge(r.Context(), user, quote.Total) // payment provider, HTTP
    err = h.orders.Save(r.Context(), cart, charge)   // Postgres
    // ...
}
```

`pricing.Quote` checks stock and applies discounts. Nothing here is confirmed
as the slow part yet: we only know the endpoint is slow.

## Step 2: the p95 trace

From `traces/checkout-p95.json`, one slow request (3,400 ms in total):

| Span | Calls | Time |
|---|---|---|
| `auth.verify` | 1 | 20 ms |
| `carts.load` (db) | 1 | 40 ms |
| `pricing.quote` | 1 | 3,200 ms |
| ↳ `inventory.check` | 1,240 | 3,100 ms |
| `payments.charge` | 1 | 180 ms |
| `orders.save` (db) | 1 | 60 ms |

```
$ grep -c '"inventory.check"' traces/checkout-p95.json
1240
```

`pricing.quote` calls `inventory.check` once per cart line and per warehouse:
Tuesday's release added a per-warehouse stock check inside the loop.

```go
for _, line := range cart.Lines {
    for _, wh := range h.warehouses {
        stock, err := h.inventory.Check(ctx, line.SKU, wh.ID) // one HTTP call each
        // ...
    }
}
```

Auth, the cart load, payment and the order save are fine. The time is an N+1
in `pricing.quote` → `inventory.check`.

## Step 3: proposed fix

Batch the lookups: one `inventory.check_batch` call with every SKU and
warehouse, then read stock from the result in the loop. The inventory service
already has the batch endpoint.

Not measured yet: the fix is a proposal until the trace is re-run with it.
