import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch, renderApp, type Handler } from "./growth-helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const templates = [
  {
    event: "order.confirmation",
    channel: "EMAIL",
    subject: "Order {{orderNumber}} confirmed",
    body: "Hi {{name}}, your order is confirmed.",
    html: null,
    isEnabled: true,
    isCustomized: false,
    description: "Sent when an order is placed",
    defaultSubject: "Order {{orderNumber}} confirmed",
    defaultBody: "Hi {{name}}, your order is confirmed.",
    updatedAt: null,
  },
];

const alerts = {
  recipients: ["admin@example.com"],
  events: {
    new_order: true,
    payment_failed: true,
  },
};

const logs = [
  {
    id: "log-1",
    event: "order.confirmation",
    channel: "EMAIL",
    recipient: "buyer@example.com",
    status: "SENT",
    error: null,
    retryCount: 0,
    maxRetries: 3,
    lastAttemptAt: "2026-10-28T10:00:00Z",
    createdAt: "2026-10-28T10:00:00Z",
  },
];

const notifHandler: Handler = (_u, _init, path) => {
  if (path === "/notifications/templates") return { body: { items: templates } };
  if (path === "/notifications/alerts") return { body: alerts };
  if (path === "/notifications/logs") return { body: { items: logs, total: 1 } };
  return undefined;
};

describe("Admin Notifications Screen", () => {
  it("renders tabs, templates, and loads template editor on click", async () => {
    mockFetch(notifHandler, ["settings.read", "settings.write"]);
    renderApp("/notifications");

    await waitFor(() => {
      expect(screen.getByText("Transactional notifications")).toBeInTheDocument();
    });

    // Verify subtabs
    expect(screen.getByRole("tab", { name: /Email templates/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Internal admin alerts/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Delivery logs/i })).toBeInTheDocument();

    // Verify template listed
    await waitFor(() => {
      expect(screen.getByText("order.confirmation")).toBeInTheDocument();
    });

    // Click template to open editor
    const user = userEvent.setup();
    await user.click(screen.getByText("order.confirmation"));

    await waitFor(() => {
      expect(screen.getByText("Edit Template: order.confirmation")).toBeInTheDocument();
      expect(screen.getByDisplayValue("Order {{orderNumber}} confirmed")).toBeInTheDocument();
    });
  });
});
