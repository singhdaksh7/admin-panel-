import type { ComponentProps } from "react";
import { Guard as RootGuard } from "../../routes";

/**
 * Lazy proxy for the shell's <Guard>. Feature route modules are evaluated while src/routes.tsx is
 * still loading (circular import), so they must not touch `Guard` at module-evaluation time.
 */
export function Guard(props: ComponentProps<typeof RootGuard>) {
  return <RootGuard {...props} />;
}
