export interface NotificationMessage {
  to: string;
  subject: string;
  body: string;
  html?: string;
}

/** Channel-agnostic: EMAIL now; SMS / WHATSAPP later by adding implementations. */
export interface NotificationProvider {
  readonly channel: "EMAIL" | "SMS" | "WHATSAPP";
  send(message: NotificationMessage): Promise<void>;
}
