import { beforeAll, describe, expect, it } from "vitest";
import { bootApp, loginAdmin, prisma } from "./helpers";
import { notify, notifyAdmin } from "../src/modules/notifications/service";

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let admin: Awaited<ReturnType<typeof loginAdmin>>;

beforeAll(async () => {
  ({ app } = await bootApp());
  admin = await loginAdmin(app);
});

describe("transactional emails and admin alerts", () => {
  it("renders templates with allowlisted variables and creates notification logs", async () => {
    const { ctx } = await bootApp();
    admin = await loginAdmin(app);

    await notify(
      ctx,
      "order.shipped",
      "customer@example.com",
      {
        orderNumber: "ORD-9999",
        trackingNumber: "TRK-12345",
        trackingUrl: "https://track.example.com/TRK-12345",
      },
    );

    const log = await prisma.notificationLog.findFirst({
      where: { event: "order.shipped", recipient: "customer@example.com" },
      orderBy: { createdAt: "desc" },
    });
    expect(log).toBeDefined();
    expect(log?.status).toBe("SENT");
    expect(log?.payload).toBeDefined();
  });

  it("admin can list templates, preview, update, test, and reset", async () => {
    // 1. List templates
    const listRes = await admin.get("/api/v1/admin/notifications/templates");
    expect(listRes.status).toBe(200);
    expect(listRes.body.items.length).toBeGreaterThan(5);

    // 2. Preview
    const prevRes = await admin.post("/api/v1/admin/notifications/templates/order.confirmation/preview", {
      vars: { orderNumber: "ORD-TEST-01" },
    });
    expect(prevRes.status).toBe(200);
    expect(prevRes.body.subject).toContain("ORD-TEST-01");
    expect(prevRes.body.html).toContain("<!DOCTYPE html>");

    // 3. Update template
    const updateRes = await admin.put("/api/v1/admin/notifications/templates/order.confirmation", {
      subject: "Custom Order {{orderNumber}} Confirmed!",
      body: "Thank you {{name}} for your order {{orderNumber}}.",
      isEnabled: true,
    });
    expect(updateRes.status).toBe(200);

    // 4. Send test email
    const testRes = await admin.post("/api/v1/admin/notifications/templates/order.confirmation/test", {
      recipient: "test-admin@example.com",
    });
    expect(testRes.status).toBe(200);
    expect(testRes.body.ok).toBe(true);

    // 5. Reset template
    const resetRes = await admin.post("/api/v1/admin/notifications/templates/order.confirmation/reset");
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.reset).toBe(true);
  });

  it("handles notification log queries and retries", async () => {
    await bootApp();
    admin = await loginAdmin(app);

    // Create a failed log directly
    const failedLog = await prisma.notificationLog.create({
      data: {
        event: "order.delivered",
        channel: "EMAIL",
        recipient: "retry-recipient@example.com",
        status: "FAILED",
        error: "Connection timeout",
        retryCount: 0,
        maxRetries: 3,
        payload: {
          event: "order.delivered",
          recipient: "retry-recipient@example.com",
          vars: { orderNumber: "ORD-RETRY-01" },
        },
      },
    });

    // List logs
    const logsRes = await admin.get("/api/v1/admin/notifications/logs?recipient=retry-recipient");
    expect(logsRes.status).toBe(200);
    expect(logsRes.body.items.length).toBeGreaterThanOrEqual(1);

    // Retry notification
    const retryRes = await admin.post(`/api/v1/admin/notifications/logs/${failedLog.id}/retry`);
    expect(retryRes.status).toBe(200);

    const updated = await prisma.notificationLog.findUnique({ where: { id: failedLog.id } });
    expect(updated?.status).toBe("SENT");
    expect(updated?.retryCount).toBe(1);
  });

  it("admin internal email alerts: respects recipient list and event toggles", async () => {
    const { ctx } = await bootApp();
    admin = await loginAdmin(app);

    // 1. Configure alerts: only notify for new_order, ignore return_requested
    await admin.put("/api/v1/admin/notifications/alerts", {
      recipients: ["ops1@example.com", "ops2@example.com"],
      events: {
        new_order: true,
        return_requested: false,
      },
    });

    // 2. Trigger new_order alert
    await notifyAdmin(ctx, "new_order", {
      orderNumber: "ORD-ALERT-01",
      customerName: "Alex Doe",
      total: "250.00",
      currency: "USD",
      adminOrderUrl: "https://admin.example.com/orders/1",
    });

    const newOrderLogs = await prisma.notificationLog.findMany({
      where: { event: "admin.new_order" },
      orderBy: { createdAt: "desc" },
    });
    const recipients = newOrderLogs.map((l) => l.recipient);
    expect(recipients).toContain("ops1@example.com");
    expect(recipients).toContain("ops2@example.com");

    // 3. Trigger return_requested alert (toggled off)
    await notifyAdmin(ctx, "return_requested", {
      returnId: "RET-1",
      orderNumber: "ORD-ALERT-01",
      customerName: "Alex Doe",
      total: "250.00",
      currency: "USD",
      adminOrderUrl: "https://admin.example.com/orders/1",
    });

    const returnLogs = await prisma.notificationLog.findMany({
      where: { event: "admin.return_requested" },
    });
    expect(returnLogs.length).toBe(0);
  });
});
